import type { LoweringServices } from "../lowering-services.js";
import ts from "typescript";
import { engineSampleCountCpp } from "../engine-samples.js";
import { argumentAt } from "../syntax.js";
import {
    postProcessComposite,
    postProcessEffect,
} from "../../post-process-effects.js";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import type { EngineOptionContext } from "./engine-options.js";
import { compileScreenSpaceTaskOptions } from "./screen-space-options.js";
import {
    compilePostProcessCompositeOptions,
    compilePostProcessTaskOptions,
} from "./post-process-options.js";
import { isScreenSpaceIntrinsic } from "../../pinned-screen-space.js";
import { validateObjectProperties } from "../option-helpers.js";
import {
    compileGpuTaskTimingIntrinsic,
    type GpuTaskTimingIntrinsicContext,
} from "./gpu-task-timing.js";

export interface EngineIntrinsicContext
    extends
        IntrinsicCallContext,
        GpuTaskTimingIntrinsicContext,
        EngineOptionContext,
        Pick<
            LoweringServices,
            | "noteTextSceneLifecycle"
            | "noteTemporalRecordBoundary"
            | "emit"
            | "emitDiscardedValue"
            | "fail"
            | "expectSameEngine"
            | "requireDefaultEngine"
            | "requireEngine"
            | "allocateTemporaryCppName"
            | "compileEngineCreation"
            | "compileRenderTargetOptions"
            | "compileRenderTaskOptions"
            | "compileGeometryTaskOptions"
            | "compileCopyTaskOptions"
            | "sceneManifest"
            | "compileSceneDefaultRenderTask"
            | "expectObjectLiteral"
            | "objectProperty"
            | "propertyName"
            | "compileFrameCallback"
            | "compileVoidCallback"
        > {}

function reachRenderer(
    context: EngineIntrinsicContext,
    call: ts.CallExpression,
): void {
    context.reachFeature("renderer:scene", call);
    context.reachFeature("renderer:geometry-output", call);
}

export function compileEngineIntrinsic(
    context: EngineIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    const timing = compileGpuTaskTimingIntrinsic(context, importedName, call);
    if (timing) return timing;
    switch (importedName) {
        case "waitForGpuIdle":
        case "waitForGpuResourceRetirements": {
            context.expectArgumentCount(call, 1, 1);
            context.reachFeature("engine:gpu-retirement", call);
            const engine = context.compileValue(argumentAt(call, 0));
            context.expectKind(engine, "engine", call);
            if (!engine.ownedEngineCpp)
                return context.fail(
                    call,
                    "GPU completion requires a realm-owned engine.",
                );
            return {
                kind: "promise",
                cpp:
                    importedName === "waitForGpuIdle"
                        ? `bbl::pal::submitted_gpu_work(${engine.cpp}.offscreen_run)`
                        : `bbl::wait_for_gpu_resource_retirements(bbl::pal::gpu_retirement_state(${engine.cpp}))`,
                promiseType: "bbl::js::PromiseVoid",
                promiseResult: { kind: "void", cpp: "" },
            };
        }
        case "createEngine":
            return context.compileEngineCreation(
                call,
                context.allocateTemporaryCppName("inline_engine"),
            );

        case "createSurface": {
            context.expectArgumentCount(call, 2, 2);
            const engine = context.compileValue(argumentAt(call, 0));
            context.expectKind(engine, "engine", argumentAt(call, 0));
            const canvas = context.compileValue(argumentAt(call, 1));
            context.expectKind(canvas, "ui-element", argumentAt(call, 1));
            context.expectSameEngine(engine, canvas, call);
            if (canvas.uiTag !== "canvas") {
                context.fail(
                    call,
                    "Additional surfaces require retained canvas elements.",
                );
            }
            context.reachFeature("renderer:surface", call);
            return {
                kind: "surface",
                surfaceCanvas: true,
                // Surface defaults are independent of the engine's primary surface.
                msaaSamples: 4,
                cpp: `bbl::create_surface(${engine.cpp}, ${canvas.cpp})`,
                engineCpp: engine.engineCpp ?? engine.cpp,
            };
        }

        case "disposeSurface": {
            context.expectArgumentCount(call, 1, 1);
            const surface = context.compileValue(argumentAt(call, 0));
            context.expectKind(surface, "surface", argumentAt(call, 0));
            return {
                kind: "void",
                cpp: `bbl::dispose_surface(${surface.cpp})`,
            };
        }

        case "enableSurfaceResizeObserver": {
            context.expectArgumentCount(call, 1, 1);
            const surface = context.compileValue(argumentAt(call, 0));
            if (surface.kind !== "engine") {
                context.expectKind(surface, "surface", argumentAt(call, 0));
            }
            // Native frame loops already refresh canvas extents. Installing or
            // cancelling the browser's layout cache does not change that policy,
            // but evaluating the surface expression still has source effects.
            context.emitDiscardedValue(surface);
            return {
                kind: "callback",
                cpp: "std::function<void()>{[]() {}}",
                nativeCallbackParameterTypes: [],
            };
        }

        case "createSceneContext": {
            context.expectArgumentCount(call, 1, 2);
            const engine = context.compileValue(argumentAt(call, 0));
            if (engine.kind !== "surface") {
                context.expectKind(engine, "engine", argumentAt(call, 0));
            }
            const defaultRenderTask = context.compileSceneDefaultRenderTask(
                call.arguments[1],
            );
            if (!defaultRenderTask)
                context.noteTextSceneLifecycle(
                    call,
                    "Text requires the default scene render task; empty and custom text task execution is not represented.",
                );
            if (defaultRenderTask)
                context.noteTemporalRecordBoundary(
                    call,
                    "implicit default scene passes",
                    "always",
                );
            const samples = engine.msaaSamples ?? 4;
            const create = `bbl::create_scene_context(${engine.cpp})`;
            return {
                kind: "scene",
                ...(engine.surfaceCanvas
                    ? { surfaceCanvas: true as const }
                    : {}),
                cpp:
                    defaultRenderTask && samples === 4
                        ? create
                        : `bbl::configure_scene_render_defaults(${create}, ${defaultRenderTask}, ${engineSampleCountCpp(engine)})`,
                sceneEnvironmentState: {
                    rotationSet: false,
                    hasTexturedSkybox: false,
                },
                sceneTopologyState: { lights: [] },
                engineCpp: engine.engineCpp ?? engine.cpp,
                ...(engine.msaaSamples
                    ? {
                          msaaSamples: engine.msaaSamples,
                      }
                    : {}),
            };
        }

        case "createFrameGraphContext": {
            context.expectArgumentCount(call, 1, 2);
            const surface = context.compileValue(argumentAt(call, 0));
            context.expectKind(surface, "engine", argumentAt(call, 0));
            const options = call.arguments[1]
                ? context.expectObjectLiteral(call.arguments[1])
                : undefined;
            if (options) {
                validateObjectProperties(
                    context,
                    options,
                    ["name", "clearColor", "update"],
                    "A frame-graph context supports name, clearColor, and update.",
                );
            }
            const update = options
                ? context.objectProperty(options, "update")
                : undefined;
            context.reachFeature("renderer:frame-graph", call);
            const nativeContext =
                context.allocateTemporaryCppName("frame_graph");
            context.emit({
                kind: "declaration",
                type: "auto",
                name: nativeContext,
                initializer: `bbl::create_frame_graph_context(${surface.cpp})`,
            });
            if (update) {
                context.emit(
                    `bbl::on_frame_graph_update(${nativeContext}, ${context.compileFrameCallback(update)});`,
                );
            }
            return {
                kind: "frame-graph-context",
                cpp: nativeContext,
                engineCpp: surface.engineCpp ?? surface.cpp,
                ...(surface.msaaSamples
                    ? { msaaSamples: surface.msaaSamples }
                    : {}),
                sceneEnvironmentState: {
                    rotationSet: false,
                    hasTexturedSkybox: false,
                },
            };
        }

        case "createRenderTarget": {
            context.expectArgumentCount(call, 1, 1);
            const engine = context.requireDefaultEngine(call);
            const options = context.compileRenderTargetOptions(
                argumentAt(call, 0),
            );
            context.reachFeature("frame-graph:resources", call);
            return {
                kind: "render-target",
                cpp: `bbl::create_render_target(${engine}, ${options.cpp})`,
                engineCpp: engine,
                renderTargetSignature: options.signature,
            };
        }

        case "createRenderTargetTexture":
        case "createSurfaceRenderTargetTexture": {
            context.expectArgumentCount(call, 2, 3);
            const sampleDepth = call.arguments[2];
            if (
                sampleDepth &&
                context.symbols.importedName(sampleDepth) !==
                    "withSampledDepthTexture"
            ) {
                context.fail(
                    sampleDepth,
                    "Render-target depth sampling requires withSampledDepthTexture.",
                );
            }
            const engine = context.compileValue(argumentAt(call, 0));
            context.expectKind(engine, "engine", argumentAt(call, 0));
            const options = context.compileRenderTargetOptions(
                argumentAt(call, 1),
            );
            const surfaceSized =
                importedName === "createSurfaceRenderTargetTexture";
            if (surfaceSized) {
                context.reachFeature("frame-graph:surface-target", call);
                context.reachFeature("engine:gpu-retirement", call);
            }
            if ((options.surface !== undefined) !== surfaceSized) {
                context.fail(
                    call,
                    `${importedName} requires ${surfaceSized ? "surface-backed" : "fixed pixel"} dimensions.`,
                );
            }
            if (options.surface)
                context.expectSameEngine(engine, options.surface, call);
            if (
                sampleDepth &&
                (!options.signature.depthFormat ||
                    options.signature.samples !== 1)
            ) {
                context.fail(
                    call,
                    "withSampledDepthTexture requires a single-sample depth attachment.",
                );
            }
            if (!options.hasColor && !sampleDepth) {
                context.fail(
                    call,
                    "A colorless render-target texture requires withSampledDepthTexture.",
                );
            }
            context.reachFeature("frame-graph:resources", call);
            const optionsCpp = sampleDepth
                ? `[&]() { auto options = ${options.cpp}; options.sampled_depth = true; return options; }()`
                : options.cpp;
            return {
                kind: "render-target-texture",
                cpp:
                    `bbl::create_render_target_texture(` +
                    `${engine.cpp}, ${optionsCpp}${surfaceSized ? ", true" : ""})`,
                renderTextureSource: "render-target",
                renderTargetSignature: options.signature,
                // `rtt.ts` hands back the colour attachment when the
                // descriptor declared one and the depth attachment
                // otherwise, so a colourless target's texture samples
                // depth. The `.texture` read carries this through.
                ...(options.hasColor ? {} : { isDepthTexture: true as const }),
                engineCpp: engine.engineCpp ?? engine.cpp,
            };
        }

        case "onRenderTargetTextureResize": {
            context.expectArgumentCount(call, 2, 2);
            const target = context.compileValue(argumentAt(call, 0));
            context.expectKind(target, "render-target-texture", call);
            const engine = context.requireEngine(target, call);
            context.reachFeature("frame-graph:resources", call);
            context.reachFeature("frame-graph:surface-target", call);
            context.reachFeature("engine:gpu-retirement", call);
            return {
                kind: "data",
                cpp: `bbl::on_render_target_texture_resize(${engine}, ${target.cpp}, ${context.compileVoidCallback(argumentAt(call, 1))})`,
                dataType: { kind: "function", parameters: [], identity: true },
            };
        }

        case "enableRenderTaskMeshRefresh": {
            context.expectArgumentCount(call, 1, 1);
            const task = context.compileValue(argumentAt(call, 0));
            context.expectKind(task, "task", call);
            if (!task.renderTask)
                context.fail(
                    call,
                    "Mesh refresh requires a retained render task.",
                );
            reachRenderer(context, call);
            return {
                kind: "void",
                cpp: `bbl::enable_render_task_mesh_refresh(${context.requireEngine(task, call)}, ${task.cpp})`,
            };
        }

        case "createRenderTask": {
            context.expectArgumentCount(call, 3, 3);
            const engine = context.compileValue(argumentAt(call, 1));
            const scene = context.compileValue(argumentAt(call, 2));
            context.expectKind(engine, "engine", argumentAt(call, 1));
            context.expectKind(scene, "scene", argumentAt(call, 2));
            context.expectSameEngine(engine, scene, call);
            const options = context.compileRenderTaskOptions(
                argumentAt(call, 0),
            );
            reachRenderer(context, call);
            return {
                kind: "task",
                cpp:
                    `bbl::create_render_task(${engine.cpp}, ` +
                    `${scene.cpp}, ${options})`,
                renderTask: true,
                engineCpp: engine.engineCpp ?? engine.cpp,
            };
        }

        case "createGeometryRendererTask": {
            context.noteTemporalRecordBoundary(
                call,
                "geometry-output task preparation",
                "always",
            );
            context.expectArgumentCount(call, 3, 3);
            const engine = context.compileValue(argumentAt(call, 1));
            const scene = context.compileValue(argumentAt(call, 2));
            context.expectKind(engine, "engine", argumentAt(call, 1));
            context.expectKind(scene, "scene", argumentAt(call, 2));
            context.expectSameEngine(engine, scene, call);
            const compiled = context.compileGeometryTaskOptions(
                argumentAt(call, 0),
            );
            context.sceneManifest.recordGeometryOutputTask(compiled.manifest);
            reachRenderer(context, call);
            return {
                kind: "task",
                cpp:
                    `bbl::create_geometry_renderer_task(` +
                    `${engine.cpp}, ${scene.cpp}, ` +
                    `${compiled.cpp})`,
                engineCpp: engine.engineCpp ?? engine.cpp,
                geometryTask: compiled.manifest,
            };
        }

        case "createCopyToTextureTask": {
            context.noteTemporalRecordBoundary(
                call,
                "copy task preparation",
                "always",
            );
            context.expectArgumentCount(call, 3, 3);
            const engine = context.compileValue(argumentAt(call, 1));
            const scene = context.compileValue(argumentAt(call, 2));
            context.expectKind(engine, "engine", argumentAt(call, 1));
            context.expectKind(scene, "scene", argumentAt(call, 2));
            context.expectSameEngine(engine, scene, call);
            const options = context.compileCopyTaskOptions(argumentAt(call, 0));
            reachRenderer(context, call);
            return {
                kind: "task",
                cpp:
                    `bbl::create_copy_to_texture_task(` +
                    `${engine.cpp}, ${scene.cpp}, ${options})`,
                engineCpp: engine.engineCpp ?? engine.cpp,
            };
        }

        default:
            if (isScreenSpaceIntrinsic(importedName)) {
                return compileScreenSpaceIntrinsic(context, importedName, call);
            }
            return compilePostProcessIntrinsic(context, importedName, call);
    }
}

/**
 * A screen-space effect task. The pin builds it over the scene's own
 * camera math and two ordinary post-process passes, so it reaches the scene
 * renderer and the post-process family beside its own; a call with no scene
 * has no camera to reconstruct depth through and is refused.
 */
/**
 * The `(config, engine, scene?)` tail every frame-graph task factory takes:
 * the engine compiled and checked, the scene compiled and matched to it
 * when given, and the renderer or the bare frame graph reached accordingly.
 * A factory whose frame function reads the scene renderer requires the
 * scene and names why.
 */
function compileTaskEngineAndScene(
    context: EngineIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
    sceneRequired?: string,
): Value {
    context.expectArgumentCount(call, 2, 3);
    const engine = context.compileValue(argumentAt(call, 1));
    context.expectKind(engine, "engine", argumentAt(call, 1));
    if (!call.arguments[2] && sceneRequired) {
        context.fail(
            call,
            `${importedName} without a scene is not supported: ${sceneRequired}`,
        );
    }
    const scene = call.arguments[2]
        ? context.compileValue(call.arguments[2])
        : undefined;
    if (scene) {
        context.expectKind(scene, "scene", argumentAt(call, 2));
        context.expectSameEngine(engine, scene, call);
        reachRenderer(context, call);
    } else {
        context.reachFeature("renderer:frame-graph", call);
    }
    context.reachFeature("frame-graph:resources", call);
    context.reachFeature("renderer:post-process", call);
    return engine;
}

function compileScreenSpaceIntrinsic(
    context: EngineIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value {
    const engine = compileTaskEngineAndScene(
        context,
        importedName,
        call,
        "the frame function reads the scene renderer's camera matrices.",
    );
    context.reachFeature("renderer:screen-space", call);
    const compiled = compileScreenSpaceTaskOptions(
        context,
        importedName,
        argumentAt(call, 0),
        context.sceneManifest.screenSpaceTasks.length,
    );
    context.sceneManifest.recordScreenSpaceTask(compiled.manifest);
    return {
        kind: "task",
        cpp:
            `bbl::create_screen_space_task_${compiled.manifest.taskIndex}(` +
            `${engine.cpp}, ${compiled.argumentsCpp})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
        screenSpaceTask: compiled.manifest,
    };
}

/**
 * Every post-process pass is the same task with a different composed stage, so
 * one case serves all of them: the effect table names which factories exist,
 * and the options compiler reads the rest out of the descriptor. Reach order
 * is the generated shader table's index order, which is why the index comes
 * from how many passes the scene has already reached.
 */
function compilePostProcessIntrinsic(
    context: EngineIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    const effect = postProcessEffect(importedName);
    const composite = postProcessComposite(importedName);
    if (!effect && !composite) {
        return undefined;
    }
    if (effect?.internal) {
        // The pin marks these `@internal`: they exist for a composite to
        // build, and their config carries textures a caller has no way to
        // make. Refusing by name says so, rather than failing later on one.
        context.fail(
            call,
            `'${importedName}' is a composite's own pass, not a scene entry ` +
                "point.",
        );
    }
    const engine = compileTaskEngineAndScene(context, importedName, call);
    if (composite) {
        const built = compilePostProcessCompositeOptions(
            context,
            importedName,
            argumentAt(call, 0),
            context.sceneManifest.postProcessComposites.length,
        );
        context.sceneManifest.recordPostProcessComposite(built.manifest, call);
        for (const task of built.sourceTasks) {
            context.expectSameEngine(engine, task, call);
        }
        return {
            kind: "task",
            cpp: `bbl::create_composite_post_process_task_${
                built.manifest.compositeIndex
            }(${engine.cpp}, ${built.cpp})`,
            engineCpp: engine.engineCpp ?? engine.cpp,
            postProcessComposite: built.manifest,
        };
    }
    const compiled = compilePostProcessTaskOptions(
        context,
        importedName,
        argumentAt(call, 0),
        context.sceneManifest.postProcessTasks.length,
    );
    context.sceneManifest.recordPostProcessTask(compiled.manifest);
    return {
        kind: "task",
        cpp: `bbl::create_post_process_task(${engine.cpp}, ${compiled.cpp})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
        postProcessTask: compiled.manifest,
    };
}

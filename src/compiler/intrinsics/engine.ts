import ts from "typescript";
import {
    postProcessComposite,
    postProcessEffect,
} from "../../post-process-effects.js";
import type {
    GeometryOutputTaskManifest,
    PostProcessCompositeManifest,
    PostProcessTaskManifest,
    ScreenSpaceTaskManifest,
    Value,
} from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import type { CompiledRenderTargetOptions } from "./engine-options.js";
import type { CompiledScreenSpaceTask } from "./screen-space-options.js";
import type {
    CompiledPostProcessComposite,
    CompiledPostProcessTask,
} from "./post-process-options.js";
import { isScreenSpaceIntrinsic } from "../../pinned-screen-space.js";
import { validateObjectProperties } from "../option-helpers.js";

interface CompiledGeometryTask {
    cpp: string;
    manifest: GeometryOutputTaskManifest;
}

export interface EngineIntrinsicContext
    extends IntrinsicCallContext {
    noteTemporalRecordBoundary(node: ts.Node, reason: string, mode?: "runtime" | "registration" | "always", scene?: Value): void;
    emit(line: string): void;
    fail(node: ts.Node, message: string): never;
    expectSameEngine(
        left: Value,
        right: Value,
        node: ts.Node,
    ): void;
    requireDefaultEngine(node: ts.Node): string;
    allocateTemporaryCppName(label: string): string;
    compileEngineCreation(
        call: ts.CallExpression,
        cppName: string,
    ): Value;
    compileRenderTargetOptions(
        expression: ts.Expression,
    ): CompiledRenderTargetOptions;
    compileRenderTaskOptions(
        expression: ts.Expression,
    ): string;
    compileGeometryTaskOptions(
        expression: ts.Expression,
    ): CompiledGeometryTask;
    compileCopyTaskOptions(
        expression: ts.Expression,
    ): string;
    compilePostProcessTaskOptions(
        intrinsic: string,
        expression: ts.Expression,
        shaderIndex: number,
    ): CompiledPostProcessTask;
    compilePostProcessCompositeOptions(
        intrinsic: string,
        expression: ts.Expression,
        compositeIndex: number,
    ): CompiledPostProcessComposite;
    recordGeometryOutputTask(
        manifest: GeometryOutputTaskManifest,
    ): void;
    recordPostProcessTask(
        manifest: PostProcessTaskManifest,
    ): void;
    recordPostProcessComposite(
        manifest: PostProcessCompositeManifest,
        site: ts.Node,
    ): void;
    compileScreenSpaceTaskOptions(
        intrinsic: string,
        expression: ts.Expression,
        taskIndex: number,
    ): CompiledScreenSpaceTask;
    recordScreenSpaceTask(manifest: ScreenSpaceTaskManifest): void;
    readonly postProcessTasks: readonly PostProcessTaskManifest[];
    readonly postProcessComposites: readonly PostProcessCompositeManifest[];
    readonly screenSpaceTasks: readonly ScreenSpaceTaskManifest[];
    compileSceneDefaultRenderTask(
        expression: ts.Expression | undefined,
    ): boolean;
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    propertyName(name: ts.PropertyName): string | undefined;
    compileFrameCallback(expression: ts.Expression, signature?: import("../types.js").FrameCallbackSignature, retainCaptures?: boolean): string;
}

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
    switch (importedName) {
        case "createEngine":
            return context.compileEngineCreation(
                call,
                context.allocateTemporaryCppName(
                    "inline_engine",
                ),
            );

        case "createSurface": {
            context.expectArgumentCount(call, 2, 3);
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            const canvas = context.compileValue(call.arguments[1]!);
            context.expectKind(canvas, "ui-element", call.arguments[1]!);
            return {
                kind: "surface",
                cpp: `bbl::create_surface(${engine.cpp}, ${canvas.cpp})`,
                engineCpp: engine.engineCpp ?? engine.cpp,
            };
        }

        case "disposeSurface": {
            context.expectArgumentCount(call, 1, 1);
            const surface = context.compileValue(call.arguments[0]!);
            context.expectKind(surface, "surface", call.arguments[0]!);
            return {
                kind: "void",
                cpp: `bbl::dispose_surface(${surface.cpp})`,
            };
        }

        case "enableSurfaceResizeObserver": {
            context.expectArgumentCount(call, 1, 1);
            const surface = context.compileValue(call.arguments[0]!);
            context.expectKind(surface, "surface", call.arguments[0]!);
            return {
                kind: "callback",
                cpp: "std::function<void()>{[]() {}}",
                nativeCallbackParameterTypes: [],
            };
        }

        case "createSceneContext": {
            context.expectArgumentCount(call, 1, 2);
            const engine =
                context.compileValue(call.arguments[0]!);
            if (engine.kind !== "surface") {
                context.expectKind(
                    engine,
                    "engine",
                    call.arguments[0]!,
                );
            }
            const defaultRenderTask = context.compileSceneDefaultRenderTask(call.arguments[1]);
            if (defaultRenderTask) context.noteTemporalRecordBoundary(call, "implicit default scene passes", "always");
            const samples = engine.msaaSamples ?? 4;
            const create = `bbl::create_scene_context(${engine.cpp})`;
            return {
                kind: "scene",
                cpp: defaultRenderTask && samples === 4
                    ? create
                    : `bbl::configure_scene_render_defaults(${create}, ${defaultRenderTask}, ${samples}u)`,
                sceneEnvironmentState: {
                    rotationSet: false,
                    hasTexturedSkybox: false,
                },
                sceneTopologyState: { lights: [] },
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
                ...(engine.msaaSamples
                    ? {
                          msaaSamples:
                              engine.msaaSamples,
                      }
                    : {}),
            };
        }

        case "createFrameGraphContext": {
            context.expectArgumentCount(call, 1, 2);
            const surface = context.compileValue(call.arguments[0]!);
            context.expectKind(surface, "engine", call.arguments[0]!);
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
            const nativeContext = context.allocateTemporaryCppName("frame_graph");
            context.emit(`auto ${nativeContext} = bbl::create_frame_graph_context(${surface.cpp});`);
            if (update) {
                context.emit(`bbl::on_frame_graph_update(${nativeContext}, ${context.compileFrameCallback(update)});`);
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
            const engine =
                context.requireDefaultEngine(call);
            const options =
                context.compileRenderTargetOptions(
                    call.arguments[0]!,
                );
            context.reachFeature("frame-graph:resources", call);
            return {
                kind: "render-target",
                cpp: `bbl::create_render_target(${engine}, ${options.cpp})`,
                engineCpp: engine,
                renderTargetSignature: options.signature,
            };
        }

        case "createRenderTargetTexture": {
            context.expectArgumentCount(call, 2, 2);
            const engine =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[0]!,
            );
            const options =
                context.compileRenderTargetOptions(
                    call.arguments[1]!,
                );
            context.reachFeature("frame-graph:resources", call);
            return {
                kind: "render-target-texture",
                cpp:
                    `bbl::create_render_target_texture(` +
                    `${engine.cpp}, ${options.cpp})`,
                renderTextureSource: "render-target",
                renderTargetSignature: options.signature,
                // `rtt.ts` hands back the colour attachment when the
                // descriptor declared one and the depth attachment
                // otherwise, so a colourless target's texture samples
                // depth. The `.texture` read carries this through.
                ...(options.hasColor ? {} : { isDepthTexture: true as const }),
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
            };
        }

        case "createRenderTask": {
            context.expectArgumentCount(call, 3, 3);
            const engine =
                context.compileValue(call.arguments[1]!);
            const scene =
                context.compileValue(call.arguments[2]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[1]!,
            );
            context.expectKind(
                scene,
                "scene",
                call.arguments[2]!,
            );
            context.expectSameEngine(engine, scene, call);
            const options =
                context.compileRenderTaskOptions(
                    call.arguments[0]!,
                );
            reachRenderer(context, call);
            return {
                kind: "task",
                cpp:
                    `bbl::create_render_task(${engine.cpp}, ` +
                    `${scene.cpp}, ${options})`,
                renderTask: true,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
            };
        }

        case "createGeometryRendererTask": {
            context.noteTemporalRecordBoundary(call, "geometry-output task preparation", "always");
            context.expectArgumentCount(call, 3, 3);
            const engine =
                context.compileValue(call.arguments[1]!);
            const scene =
                context.compileValue(call.arguments[2]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[1]!,
            );
            context.expectKind(
                scene,
                "scene",
                call.arguments[2]!,
            );
            context.expectSameEngine(engine, scene, call);
            const compiled =
                context.compileGeometryTaskOptions(
                    call.arguments[0]!,
                );
            context.recordGeometryOutputTask(
                compiled.manifest,
            );
            reachRenderer(context, call);
            return {
                kind: "task",
                cpp:
                    `bbl::create_geometry_renderer_task(` +
                    `${engine.cpp}, ${scene.cpp}, ` +
                    `${compiled.cpp})`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
                geometryTask: compiled.manifest,
            };
        }

        case "createCopyToTextureTask": {
            context.noteTemporalRecordBoundary(call, "copy task preparation", "always");
            context.expectArgumentCount(call, 3, 3);
            const engine =
                context.compileValue(call.arguments[1]!);
            const scene =
                context.compileValue(call.arguments[2]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[1]!,
            );
            context.expectKind(
                scene,
                "scene",
                call.arguments[2]!,
            );
            context.expectSameEngine(engine, scene, call);
            const options =
                context.compileCopyTaskOptions(
                    call.arguments[0]!,
                );
            reachRenderer(context, call);
            return {
                kind: "task",
                cpp:
                    `bbl::create_copy_to_texture_task(` +
                    `${engine.cpp}, ${scene.cpp}, ${options})`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
            };
        }

        default:
            if (isScreenSpaceIntrinsic(importedName)) {
                return compileScreenSpaceIntrinsic(
                    context,
                    importedName,
                    call,
                );
            }
            return compilePostProcessIntrinsic(
                context,
                importedName,
                call,
            );
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
    const engine = context.compileValue(call.arguments[1]!);
    context.expectKind(engine, "engine", call.arguments[1]!);
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
        context.expectKind(scene, "scene", call.arguments[2]!);
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
    const compiled = context.compileScreenSpaceTaskOptions(
        importedName,
        call.arguments[0]!,
        context.screenSpaceTasks.length,
    );
    context.recordScreenSpaceTask(compiled.manifest);
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
        const built = context.compilePostProcessCompositeOptions(
            importedName,
            call.arguments[0]!,
            context.postProcessComposites.length,
        );
        context.recordPostProcessComposite(built.manifest, call);
        for (const task of built.sourceTasks) {
            context.expectSameEngine(engine, task, call);
        }
        return {
            kind: "task",
            cpp:
                `bbl::create_composite_post_process_task_${
                    built.manifest.compositeIndex
                }(${engine.cpp}, ${built.cpp})`,
            engineCpp: engine.engineCpp ?? engine.cpp,
            postProcessComposite: built.manifest,
        };
    }
    const compiled = context.compilePostProcessTaskOptions(
        importedName,
        call.arguments[0]!,
        context.postProcessTasks.length,
    );
    context.recordPostProcessTask(compiled.manifest);
    return {
        kind: "task",
        cpp:
            `bbl::create_post_process_task(${engine.cpp}, ${compiled.cpp})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
        postProcessTask: compiled.manifest,
    };
}

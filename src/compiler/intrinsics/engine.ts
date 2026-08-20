import ts from "typescript";
import {
    postProcessComposite,
    postProcessEffect,
} from "../../post-process-effects.js";
import type {
    GeometryOutputTaskManifest,
    PostProcessCompositeManifest,
    PostProcessTaskManifest,
    Value,
} from "../types.js";
import type { IntrinsicCallContext } from "./context.js";

interface CompiledGeometryTask {
    cpp: string;
    manifest: GeometryOutputTaskManifest;
}

interface CompiledPostProcessTask {
    cpp: string;
    manifest: PostProcessTaskManifest;
}

interface CompiledPostProcessComposite {
    cpp: string;
    manifest: PostProcessCompositeManifest;
}

export interface EngineIntrinsicContext
    extends IntrinsicCallContext {
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
    ): string;
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
    ): void;
    readonly postProcessTasks: readonly PostProcessTaskManifest[];
    readonly postProcessComposites: readonly PostProcessCompositeManifest[];
    compileSceneDefaultRenderTask(
        expression: ts.Expression | undefined,
    ): boolean;
}

function reachRenderer(
    context: EngineIntrinsicContext,
    call: ts.CallExpression,
): void {
    context.reachFeature("renderer:pbr", call);
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

        case "createSceneContext": {
            context.expectArgumentCount(call, 1, 2);
            const engine =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[0]!,
            );
            return {
                kind: "scene",
                cpp: `bbl::create_scene_context(${engine.cpp})`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
                ...(engine.msaaSamples
                    ? {
                          msaaSamples:
                              engine.msaaSamples,
                      }
                    : {}),
                defaultRenderTask:
                    context.compileSceneDefaultRenderTask(
                        call.arguments[1],
                    ),
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
            reachRenderer(context, call);
            return {
                kind: "render-target",
                cpp: `bbl::create_render_target(${engine}, ${options})`,
                engineCpp: engine,
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
            reachRenderer(context, call);
            return {
                kind: "render-target-texture",
                cpp:
                    `bbl::create_render_target_texture(` +
                    `${engine.cpp}, ${options})`,
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
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
            };
        }

        case "createGeometryRendererTask": {
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
            return compilePostProcessIntrinsic(
                context,
                importedName,
                call,
            );
    }
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
    context.expectArgumentCount(call, 3, 3);
    const engine = context.compileValue(call.arguments[1]!);
    const scene = context.compileValue(call.arguments[2]!);
    context.expectKind(engine, "engine", call.arguments[1]!);
    context.expectKind(scene, "scene", call.arguments[2]!);
    context.expectSameEngine(engine, scene, call);
    reachRenderer(context, call);
    context.reachFeature("renderer:post-process", call);
    if (composite) {
        const built = context.compilePostProcessCompositeOptions(
            importedName,
            call.arguments[0]!,
            context.postProcessComposites.length,
        );
        context.recordPostProcessComposite(built.manifest);
        return {
            kind: "task",
            cpp:
                `bbl::create_composite_post_process_task_${
                    built.manifest.compositeIndex
                }(${engine.cpp}, ${scene.cpp}, ${built.cpp})`,
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
            `bbl::create_post_process_task(${engine.cpp}, ` +
            `${scene.cpp}, ${compiled.cpp})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
        postProcessTask: compiled.manifest,
    };
}

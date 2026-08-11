import ts from "typescript";
import type {
    Feature,
    GeometryOutputTaskManifest,
    Value,
    ValueKind,
} from "../types.js";

interface CompiledGeometryTask {
    cpp: string;
    manifest: GeometryOutputTaskManifest;
}

export interface EngineIntrinsicContext {
    expectArgumentCount(
        call: ts.CallExpression,
        minimum: number,
        maximum: number,
    ): void;
    compileValue(expression: ts.Expression): Value;
    expectKind(
        value: Value,
        kind: ValueKind,
        node: ts.Node,
    ): void;
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
    recordGeometryOutputTask(
        manifest: GeometryOutputTaskManifest,
    ): void;
    reachFeature(feature: Feature): void;
}

function reachRenderer(
    context: EngineIntrinsicContext,
): void {
    context.reachFeature("renderer:pbr");
    context.reachFeature("renderer:geometry-output");
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
            reachRenderer(context);
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
            reachRenderer(context);
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
            reachRenderer(context);
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
            reachRenderer(context);
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
            reachRenderer(context);
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
            return undefined;
    }
}

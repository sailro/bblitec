import ts from "typescript";
import type {
    Feature,
    Value,
    ValueKind,
} from "../types.js";

export interface SceneIntrinsicContext {
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
    compileFrameCallback(expression: ts.Expression): string;
    requireEngine(value: Value, node: ts.Node): string;
    reachFeature(feature: Feature): void;
    fail(node: ts.Node, message: string): never;
}

export function compileSceneIntrinsic(
    context: SceneIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "addToScene": {
            context.expectArgumentCount(call, 2, 2);
            const scene =
                context.compileValue(call.arguments[0]!);
            const resource =
                context.compileValue(call.arguments[1]!);
            context.expectKind(
                scene,
                "scene",
                call.arguments[0]!,
            );
            if (
                resource.kind !== "asset" &&
                resource.kind !== "mesh" &&
                resource.kind !== "light"
            ) {
                context.fail(
                    call.arguments[1]!,
                    `addToScene supports asset, mesh, and light values, received ${resource.kind}.`,
                );
            }
            context.expectSameEngine(scene, resource, call);
            return {
                kind: "void",
                cpp:
                    `bbl::add_to_scene(` +
                    `${scene.cpp}, ${resource.cpp})`,
            };
        }

        case "onBeforeRender": {
            context.expectArgumentCount(call, 2, 2);
            const scene =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                scene,
                "scene",
                call.arguments[0]!,
            );
            return {
                kind: "void",
                cpp:
                    `bbl::on_before_render(${scene.cpp}, ` +
                    `${context.compileFrameCallback(call.arguments[1]!)})`,
            };
        }

        case "addTask":
        case "addTaskAtStart": {
            context.expectArgumentCount(call, 2, 2);
            const scene =
                context.compileValue(call.arguments[0]!);
            const task =
                context.compileValue(call.arguments[1]!);
            context.expectKind(
                scene,
                "scene",
                call.arguments[0]!,
            );
            context.expectKind(
                task,
                "task",
                call.arguments[1]!,
            );
            context.expectSameEngine(scene, task, call);
            return {
                kind: "void",
                cpp:
                    importedName === "addTaskAtStart"
                        ? `bbl::add_task_at_start(${scene.cpp}, ${task.cpp})`
                        : `bbl::add_task(${scene.cpp}, ${task.cpp})`,
            };
        }

        case "attachControl":
        case "attachFreeControl": {
            context.expectArgumentCount(call, 2, 3);
            const camera =
                context.compileValue(call.arguments[0]!);
            const sceneArgument =
                call.arguments.length === 3
                    ? call.arguments[2]!
                    : call.arguments[1]!;
            const scene =
                context.compileValue(sceneArgument);
            context.expectKind(
                camera,
                "camera",
                call.arguments[0]!,
            );
            context.expectKind(
                scene,
                "scene",
                sceneArgument,
            );
            context.expectSameEngine(camera, scene, call);
            if (importedName === "attachFreeControl") {
                context.reachFeature("camera:free");
            }
            return {
                kind: "void",
                cpp:
                    importedName === "attachFreeControl"
                        ? `bbl::attach_free_control(${context.requireEngine(camera, call)}, ${camera.cpp}, ${scene.cpp})`
                        : `bbl::attach_control(${context.requireEngine(camera, call)}, ${camera.cpp}, ${scene.cpp})`,
            };
        }

        case "registerScene": {
            context.expectArgumentCount(call, 1, 1);
            const scene =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                scene,
                "scene",
                call.arguments[0]!,
            );
            return {
                kind: "void",
                cpp: `bbl::register_scene(${scene.cpp})`,
            };
        }

        case "startEngine": {
            context.expectArgumentCount(call, 1, 1);
            const engine =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[0]!,
            );
            context.reachFeature("backend:sdl");
            return {
                kind: "void",
                cpp: `bbl::start_engine(${engine.cpp})`,
            };
        }

        default:
            return undefined;
    }
}

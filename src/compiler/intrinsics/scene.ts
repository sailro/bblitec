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
    compileNumber(expression: ts.Expression): string;
    compileColor3(expression: ts.Expression): string;
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
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
    ensureDefaultRenderTask(
        scene: Value,
        node: ts.Node,
    ): string | undefined;
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
            const defaultTask =
                context.ensureDefaultRenderTask(
                    scene,
                    call,
                );
            const taskCall =
                importedName === "addTaskAtStart"
                    ? `bbl::add_task_at_start(${scene.cpp}, ${task.cpp})`
                    : `bbl::add_task(${scene.cpp}, ${task.cpp})`;
            return {
                kind: "void",
                cpp: defaultTask
                    ? `${defaultTask};\n        ${taskCall}`
                    : taskCall,
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

        case "setFog": {
            context.expectArgumentCount(call, 2, 2);
            const scene =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                scene,
                "scene",
                call.arguments[0]!,
            );
            const config = context.expectObjectLiteral(
                call.arguments[1]!,
            );
            const property = (
                name: string,
            ): ts.Expression => {
                const expression = context.objectProperty(
                    config,
                    name,
                );
                if (!expression) {
                    context.fail(
                        config,
                        `setFog requires a '${name}' property.`,
                    );
                }
                return expression;
            };
            const modeExpression = property("mode");
            const mode =
                context.compileValue(modeExpression);
            if (
                mode.kind !== "number" ||
                mode.staticNumber === undefined ||
                ![0, 1, 2, 3].includes(mode.staticNumber)
            ) {
                context.fail(
                    modeExpression,
                    "setFog mode must be a static 0 (none), 1 (exp), 2 (exp2), or 3 (linear) literal.",
                );
            }
            context.reachFeature("renderer:fog");
            return {
                kind: "void",
                cpp:
                    `bbl::set_scene_fog(${scene.cpp}, ` +
                    `${mode.staticNumber}.0f, ` +
                    `${context.compileNumber(property("density"))}, ` +
                    `${context.compileNumber(property("start"))}, ` +
                    `${context.compileNumber(property("end"))}, ` +
                    `${context.compileColor3(property("color"))})`,
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

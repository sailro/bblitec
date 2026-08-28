import ts from "typescript";
import type { LightKind, Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";

export interface SceneIntrinsicContext
    extends IntrinsicCallContext {
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileColor3(expression: ts.Expression): string;
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    expectSameEngine(
        left: Value,
        right: Value,
        node: ts.Node,
    ): void;
    compileFrameCallback(expression: ts.Expression): string;
    /**
     * Records where the render loop starts, so the statements after it --
     * the browser's own continuation -- are hoisted into the conductor's
     * deferred queue rather than emitted after a call that never returns.
     */
    markEngineStart(engineCpp: string, node: ts.Node): void;
    /** The `scene.lights` slot the next added light fills. */
    nextSceneLightIndex(kind?: LightKind): number;
    requireEngine(value: Value, node: ts.Node): string;
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
                resource.kind !== "asset-entity" &&
                !(
                    resource.kind === "asset-root" &&
                    resource.assetRootClone
                ) &&
                resource.kind !== "mesh" &&
                resource.kind !== "light"
            ) {
                context.fail(
                    call.arguments[1]!,
                    `addToScene supports asset, entity, mesh, and light values, received ${resource.kind}.`,
                );
            }
            context.expectSameEngine(scene, resource, call);
            // The slot this light lands in. `scene.lights` order is what the
            // pin's shadow receiver fragment names its per-light varyings
            // and bindings by, so a generator's light has to be added
            // before the generator is created.
            if (resource.kind === "light") {
                resource.sceneLightIndex = context.nextSceneLightIndex(
                    resource.lightKind,
                );
            }
            // A container's entity takes the pin's entity walk alone: its
            // animation groups, per-frame tick, camera and clear colour
            // belong to the container arm, which a scene iterating
            // `entities` never reaches.
            return {
                kind: "void",
                cpp:
                    resource.kind === "asset-entity" ||
                    resource.kind === "asset-root"
                        ? `bbl::add_asset_entities(` +
                          `${scene.cpp}, ${resource.cpp})`
                        : `bbl::add_to_scene(` +
                          `${scene.cpp}, ${resource.cpp})`,
            };
        }

        case "removeFromScene": {
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
            // The pinned removal accepts the same union as addToScene;
            // the reached subset removes meshes (the demo's particle
            // retirement).
            context.expectKind(
                resource,
                "mesh",
                call.arguments[1]!,
            );
            context.expectSameEngine(scene, resource, call);
            context.reachFeature("scene:remove", call);
            return {
                kind: "void",
                cpp:
                    `bbl::remove_from_scene(` +
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
            if (
                scene.kind !== "scene" &&
                scene.kind !== "frame-graph-context"
            ) {
                context.fail(
                    call.arguments[0]!,
                    `addTask requires a scene or frame-graph context, received ${scene.kind}.`,
                );
            }
            context.expectKind(
                task,
                "task",
                call.arguments[1]!,
            );
            context.expectSameEngine(scene, task, call);
            const defaultTask = scene.kind === "scene"
                ? context.ensureDefaultRenderTask(scene, call)
                : undefined;
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

        case "registerFrameGraphContext": {
            context.expectArgumentCount(call, 1, 1);
            const frameGraph = context.compileValue(call.arguments[0]!);
            context.expectKind(
                frameGraph,
                "frame-graph-context",
                call.arguments[0]!,
            );
            const update = frameGraph.frameGraphUpdateCpp
                ? `bbl::on_frame_graph_update(${frameGraph.cpp}, ${frameGraph.frameGraphUpdateCpp});\n        `
                : "";
            return {
                kind: "void",
                cpp: `${update}bbl::register_frame_graph_context(${frameGraph.cpp})`,
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
                context.reachFeature("camera:free", call);
            }
            return {
                kind: "void",
                cpp:
                    // The scene is checked but not passed: both pinned hooks
                    // read it only to reach the canvas and the render loop,
                    // neither of which crosses into the runtime's state.
                    importedName === "attachFreeControl"
                        ? `bbl::attach_free_control(${context.requireEngine(camera, call)}, ${camera.cpp})`
                        : `bbl::attach_control(${context.requireEngine(camera, call)}, ${camera.cpp})`,
            };
        }

        case "setEnvironmentRotation": {
            // src/scene/set-environment-rotation.ts stores the Y rotation on
            // the scene and registers the environment uniform/skybox patch.
            // Native carries the same scalar in EnvironmentState; its shared
            // scene block and composed IBL shader already consume it.
            context.expectArgumentCount(call, 2, 2);
            const scene =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                scene,
                "scene",
                call.arguments[0]!,
            );
            if (
                scene.sceneEnvironmentState!
                    .hasTexturedSkybox
            ) {
                context.fail(
                    call,
                    "setEnvironmentRotation is currently lowered without a textured environment skybox; rotating one requires native skybox rotation support.",
                );
            }
            scene.sceneEnvironmentState!.rotationSet =
                true;
            return {
                kind: "void",
                cpp:
                    `${scene.cpp}.environment.rotation_y = ` +
                    context.compileNumber(call.arguments[1]!),
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
            context.reachFeature("renderer:fog", call);
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
            context.reachFeature("backend:sdl", call);
            // Upstream this returns to a continuation that runs alongside
            // the frames it just scheduled; here the call blocks, so the
            // statements after it are hoisted into the frame conductor's
            // deferred queue.
            context.markEngineStart(
                engine.engineCpp ?? engine.cpp,
                call,
            );
            return {
                kind: "void",
                cpp: `bbl::start_engine(${engine.cpp})`,
            };
        }

        // `stopEngine` is the pin's own end of the render loop, and the
        // corpus reaches it from inside a zero-delay `setTimeout` -- the
        // freeze every physics scene pins its measured pose with. What it
        // means here is a flag the frame conductor reads.
        case "stopEngine": {
            context.expectArgumentCount(call, 1, 1);
            const engine =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[0]!,
            );
            return {
                kind: "void",
                cpp: `bbl::stop_engine(${engine.cpp})`,
            };
        }

        default:
            return undefined;
    }
}

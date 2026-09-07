import ts from "typescript";
import type { DefaultRenderTaskEmission, LightKind, Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import {
    type CameraDeferralContext,
    compileCameraDeferralOptions,
} from "./gizmo.js";

export interface SceneIntrinsicContext
    extends IntrinsicCallContext,
        CameraDeferralContext {
    noteTemporalRecordBoundary(node: ts.Node, reason: string, mode?: "runtime" | "registration" | "always", scene?: Value): void;
    noteTemporalCameraControl(node: ts.Node): void;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileColor3(expression: ts.Expression): string;
    compileVec4(expression: ts.Expression): string;
    unwrap(expression: ts.Expression): ts.Expression;
    recordSceneUniformIdentityLimitation(node: ts.Node, message: string): void;
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
    compileFrameCallback(expression: ts.Expression, signature?: import("../types.js").FrameCallbackSignature, retainCaptures?: boolean): string;
    compileVoidCallback(expression: ts.Expression): string;
    emit(line: string): void;
    /**
     * Records where the render loop starts, so the statements after it --
     * the browser's own continuation -- are hoisted into the conductor's
     * deferred queue rather than emitted after a call that never returns.
     */
    markEngineStart(engineCpp: string, node: ts.Node): void;
    compileAsyncEngineStart(engine: Value, node: ts.Node): Value | undefined;
    /** Add/remove a light in the compiler's current scene-topology model. */
    addSceneLight(scene: Value, light: Value, kind: LightKind): void;
    addDynamicSceneLight(): void;
    removeSceneLight(scene: Value, light: Value): void;
    requireEngine(value: Value, node: ts.Node): string;
    ensureDefaultRenderTask(
        scene: Value,
        node: ts.Node,
    ): DefaultRenderTaskEmission;
    fail(node: ts.Node, message: string): never;
}

export function compileSceneIntrinsic(
    context: SceneIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    if (["unregisterScene", "addToScene", "removeFromScene", "addTask", "addTaskAtStart"].includes(importedName)) {
        context.noteTemporalRecordBoundary(call, `${importedName} after scene registration`);
    }
    if (importedName === "rebuildSceneRenderables") context.noteTemporalRecordBoundary(call, importedName, "always");
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
                resource.kind !== "light" &&
                resource.kind !== "camera" &&
                resource.kind !== "scene-node" &&
                resource.kind !== "transform-node"
            ) {
                context.fail(
                    call.arguments[1]!,
                    `addToScene supports asset, entity, mesh, light, camera, and transform-node values, received ${resource.kind}.`,
                );
            }
            context.expectSameEngine(scene, resource, call);
            // The slot this light lands in. `scene.lights` order is what the
            // pin's shadow receiver fragment names its per-light varyings
            // and bindings by. Generators created before this call are
            // patched to the slot here.
            if (resource.kind === "light") {
                if (resource.lightKind && resource.lightIdentity) {
                    context.addSceneLight(
                        scene,
                        resource,
                        resource.lightKind,
                    );
                } else {
                    // A light read from native data has the runtime handle
                    // but no single generation-time identity/kind. The
                    // pipeline therefore composes its dynamic light arms;
                    // the runtime add keeps the handle's actual kind/order.
                    context.addDynamicSceneLight();
                }
            }
            // A container's entity takes the pin's entity walk alone: its
            // animation groups, per-frame tick, camera and clear colour
            // belong to the container arm, which a scene iterating
            // `entities` never reaches.
            return {
                kind: "void",
                cpp:
                    resource.kind === "camera"
                        ? ""
                        : resource.kind === "scene-node"
                          ? `bbl::add_to_scene(${scene.cpp}, ${resource.cpp})`
                        : resource.kind === "asset-entity" ||
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
            // The pinned removal accepts the same union as addToScene. Mesh
            // retirement and light-topology replacement are the two reached
            // native paths; both retain their concrete handle kind here.
            if (resource.kind !== "mesh" && resource.kind !== "light") {
                context.fail(
                    call.arguments[1]!,
                    `removeFromScene currently supports mesh and light values, received ${resource.kind}.`,
                );
            }
            context.expectSameEngine(scene, resource, call);
            if (resource.kind === "light") {
                context.removeSceneLight(scene, resource);
            }
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

        case "onSceneDispose": {
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
                    `bbl::on_scene_dispose(${scene.cpp}, ` +
                    `${context.compileVoidCallback(call.arguments[1]!)})`,
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
            const sceneCpp = defaultTask?.sceneCpp ?? scene.cpp;
            const taskCall =
                importedName === "addTaskAtStart"
                    ? `bbl::add_task_at_start(${sceneCpp}, ${task.cpp})`
                    : `bbl::add_task(${sceneCpp}, ${task.cpp})`;
            return {
                kind: "void",
                cpp: defaultTask
                    ? `${defaultTask.setup};\n        ${taskCall}`
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
            context.noteTemporalRecordBoundary(call, importedName, "registration", frameGraph);
            return {
                kind: "void",
                cpp: `bbl::register_frame_graph_context(${frameGraph.cpp})`,
            };
        }

        case "attachControl":
        case "attachFreeControl": {
            // Only the ArcRotate hook takes a fourth argument: the pinned
            // `AttachControlOptions` bag of camera-deferral callbacks,
            // compiled as live predicates over the registered dispatcher.
            // `attachFreeControl` declares no such parameter.
            context.expectArgumentCount(
                call,
                2,
                importedName === "attachControl" ? 4 : 3,
            );
            const camera =
                context.compileValue(call.arguments[0]!);
            const sceneArgument =
                call.arguments.length >= 3
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
            context.noteTemporalCameraControl(call);
            const deferrals = call.arguments[3]
                ? compileCameraDeferralOptions(context, call.arguments[3]) : [];
            if (importedName === "attachFreeControl") {
                context.reachFeature("camera:free", call);
            }
            // The scene is checked but not passed: both pinned hooks read it
            // only to reach the canvas and the render loop. Install the
            // native control immediately and preserve the pin's returned
            // disposer, which disables controls and releases its callbacks.
            context.emit(
                importedName === "attachFreeControl"
                    ? `bbl::attach_free_control(${context.requireEngine(camera, call)}, ${camera.cpp});`
                    : `bbl::attach_control(${context.requireEngine(camera, call)}, ${camera.cpp});`,
            );
            const engine = context.requireEngine(camera, call);
            for (const { member, cpp } of deferrals) {
                context.emit(`${engine}.cameras[${camera.cpp}.value].${member} = ${cpp};`);
            }
            return {
                kind: "data",
                cpp: `std::function<void()>{[&${engine}, camera = ${camera.cpp}]() { auto& record = ${engine}.cameras[camera.value]; record.controls_enabled = false; record.should_handle_pointer_down = {}; record.external_drag_active = {}; record.external_pick_pending = {}; }}`,
                dataType: { kind: "function", parameters: [] },
            };
        }

        case "setEnvironmentRotation": {
            context.noteTemporalRecordBoundary(call,
                "setEnvironmentRotation invalidates source-task caches beyond the retained key fields", "always");
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

        case "enableMirroredMeshes": {
            // src/mesh/enable-mirrored-meshes.ts: the opt-in that reaches
            // the winding resolution through a dynamic import, so a scene
            // that never calls it composes none of it. Awaited upstream
            // because that import is; the awaited value is void.
            context.expectArgumentCount(call, 1, 1);
            const scene = context.compileValue(call.arguments[0]!);
            context.expectKind(scene, "scene", call.arguments[0]!);
            context.reachFeature("mesh:mirrored", call);
            return {
                kind: "void",
                cpp: `bbl::enable_mirrored_meshes(${scene.cpp})`,
                ...(scene.engineCpp
                    ? { engineCpp: scene.engineCpp }
                    : {}),
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
            // This adapter snapshots the numeric fields. A fresh literal and
            // its fresh color array cannot subsequently be mutated through an
            // alias; retained bags need their own live object carrier first.
            if (!ts.isObjectLiteralExpression(context.unwrap(call.arguments[1]!)) ||
                !ts.isArrayLiteralExpression(context.unwrap(property("color")))) {
                context.recordSceneUniformIdentityLimitation(call.arguments[1]!,
                    "TAA requires setFog to receive a fresh inline config with an inline color array; " +
                    "named or aliased fog objects do not yet retain their identity and live fields.");
            }
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

        case "setClipPlane": {
            // src/scene/scene-ubo-extras.ts, `setFog`'s sibling: the plane
            // is stored on the scene and the writer that puts it in the
            // scene UBO's own `clipPlane` lane is registered. The pin makes
            // importing the setter the opt-in that pulls those bytes in --
            // "keeping those bytes out of scenes that never clip" -- so the
            // feature is reached at the same call, and the lane a scene
            // never writes stays the zero its block was packed with.
            context.expectArgumentCount(call, 2, 2);
            const scene =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                scene,
                "scene",
                call.arguments[0]!,
            );
            context.reachFeature("renderer:clip-plane", call);
            return {
                kind: "void",
                cpp:
                    `bbl::set_scene_clip_plane(${scene.cpp}, ` +
                    `${context.compileVec4(call.arguments[1]!)})`,
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
            context.noteTemporalRecordBoundary(call, importedName, "registration", scene);
            return {
                kind: "void",
                cpp: `bbl::register_scene(${scene.cpp})`,
            };
        }

        case "unregisterScene": {
            context.expectArgumentCount(call, 1, 1);
            const scene = context.compileValue(call.arguments[0]!);
            context.expectKind(scene, "scene", call.arguments[0]!);
            return {
                kind: "void",
                cpp: `bbl::unregister_scene(${scene.cpp})`,
            };
        }

        case "disposeScene": {
            context.expectArgumentCount(call, 1, 1);
            const scene = context.compileValue(call.arguments[0]!);
            context.expectKind(scene, "scene", call.arguments[0]!);
            return {
                kind: "void",
                cpp: `bbl::dispose_scene(${scene.cpp})`,
            };
        }

        case "rebuildSceneRenderables": {
            context.expectArgumentCount(call, 1, 1);
            const scene = context.compileValue(call.arguments[0]!);
            context.expectKind(scene, "scene", call.arguments[0]!);
            return {
                kind: "void",
                cpp: `bbl::rebuild_scene_renderables(${scene.cpp})`,
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
            const asynchronous = context.compileAsyncEngineStart(engine, call);
            if (asynchronous) return asynchronous;
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

        case "setEngineSize": {
            context.expectArgumentCount(call, 3, 3);
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            if (!engine.ownedEngineCpp) return context.fail(call, "Explicit engine size currently requires a realm-owned canvas.");
            const width = context.compileNumber(call.arguments[1]!, "double");
            const height = context.compileNumber(call.arguments[2]!, "double");
            return { kind: "void", cpp: `bbl::set_engine_size(${engine.cpp}, ${width}, ${height})` };
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

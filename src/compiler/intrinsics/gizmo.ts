// The display-gizmo family: the utility layer and the camera and light
// gizmos hosted on it.
//
// A `UtilityLayer` is the pin's second SceneContext over one engine
// (`src/gizmo/utility-layer.ts`), registered after the main scene -- which
// is exactly what makes both backends record it as a swapchain overlay
// layer, colour loaded and depth freshly cleared. So the value is a native
// handle and nothing about the layer is folded: its camera is shared with
// the main scene by reference and forwarded every frame, as upstream
// forwards it.
//
// Both gizmos are display only in the reached slice. What each attach call
// does at generation is bind the target; the geometry it builds is the
// pin's own lazy build, emitted in the generated family unit.
import ts from "typescript";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";

export interface GizmoIntrinsicContext extends IntrinsicCallContext {
    requireEngine(value: Value, node: ts.Node): string;
    requireDefaultEngine(node: ts.Node): string;
    expectSameEngine(left: Value, right: Value, node: ts.Node): void;
    fail(node: ts.Node, message: string): never;
}

/**
 * The options bag each factory takes, refused rather than half-supported.
 *
 * Every member of `UtilityLayerOptions`, `CameraGizmoOptions` and
 * `LightGizmoOptions` changes what the generated family unit BUILDS -- a
 * colour, a light intensity, whether the body or the frustum exists at all
 * -- and the unit is emitted from the pin's defaults. A scene supplying one
 * therefore refuses by name instead of compiling a widget that ignores it.
 */
function refuseOptions(
    context: GizmoIntrinsicContext,
    call: ts.CallExpression,
    index: number,
    factory: string,
): void {
    if (call.arguments.length > index) {
        context.fail(
            call.arguments[index]!,
            `${factory} options are not supported: the generated gizmo ` +
                "family is built from the pinned factory's own defaults, " +
                "so a supplied colour, light intensity or display flag " +
                "would be accepted and then ignored.",
        );
    }
}

export function compileGizmoIntrinsic(
    context: GizmoIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "createUtilityLayer": {
            context.expectArgumentCount(call, 2, 3);
            refuseOptions(context, call, 2, "createUtilityLayer");
            const engine = context.compileValue(call.arguments[0]!);
            const scene = context.compileValue(call.arguments[1]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            context.expectKind(scene, "scene", call.arguments[1]!);
            context.reachFeature("gizmo:utility-layer", call);
            // The pin's own default light, created by this factory.
            context.reachFeature("light:hemispheric", call);
            // Every gizmo the layer hosts hangs off transform nodes, and
            // the layer is where the family's node parenting starts.
            context.reachFeature("mesh:transform-node", call);
            context.reachFeature("mesh:parenting", call);
            return {
                kind: "utility-layer",
                cpp:
                    `bbl::create_utility_layer(` +
                    `${engine.cpp}, ${scene.cpp})`,
                engineCpp: engine.cpp,
            };
        }

        case "registerUtilityLayer": {
            context.expectArgumentCount(call, 1, 1);
            const layer = context.compileValue(call.arguments[0]!);
            context.expectKind(
                layer,
                "utility-layer",
                call.arguments[0]!,
            );
            // Registration order is what makes the layer an overlay: the
            // pin's `configureSwapchainOverlayScene` reads the surface's
            // LAST rendering context as the base. A scene registering the
            // layer before its main scene would make the main scene the
            // overlay, which is a different picture -- and one this port
            // would render, so the order is left to the scene exactly as
            // upstream leaves it.
            return {
                kind: "void",
                cpp:
                    `bbl::register_utility_layer(` +
                    `${context.requireEngine(layer, call)}, ${layer.cpp})`,
            };
        }

        case "createCameraGizmo": {
            context.expectArgumentCount(call, 2, 3);
            refuseOptions(context, call, 2, "createCameraGizmo");
            const engine = context.compileValue(call.arguments[0]!);
            const layer = context.compileValue(call.arguments[1]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            context.expectKind(
                layer,
                "utility-layer",
                call.arguments[1]!,
            );
            context.expectSameEngine(engine, layer, call);
            context.reachFeature("gizmo:camera", call);
            // What the pinned camera-gizmo body builds: BJS
            // `_CreateCameraMesh` is a box plus three cylinders, and the
            // frustum wireframe is twelve more cylinders. Reached at this
            // factory because that is where the pin reaches them.
            context.reachFeature("mesh:box", call);
            context.reachFeature("mesh:cylinder", call);
            return {
                kind: "camera-gizmo",
                cpp:
                    `bbl::create_camera_gizmo(` +
                    `${engine.cpp}, ${layer.cpp})`,
                engineCpp: engine.cpp,
            };
        }

        case "attachCameraGizmoToCamera": {
            context.expectArgumentCount(call, 2, 2);
            const gizmo = context.compileValue(call.arguments[0]!);
            const camera = context.compileValue(call.arguments[1]!);
            context.expectKind(
                gizmo,
                "camera-gizmo",
                call.arguments[0]!,
            );
            context.expectKind(camera, "camera", call.arguments[1]!);
            context.expectSameEngine(gizmo, camera, call);
            return {
                kind: "void",
                cpp:
                    `bbl::attach_camera_gizmo_to_camera(` +
                    `${context.requireEngine(gizmo, call)}, ` +
                    `${gizmo.cpp}, ${camera.cpp})`,
            };
        }

        case "createLightGizmo": {
            context.expectArgumentCount(call, 2, 3);
            refuseOptions(context, call, 2, "createLightGizmo");
            const engine = context.compileValue(call.arguments[0]!);
            const layer = context.compileValue(call.arguments[1]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            context.expectKind(
                layer,
                "utility-layer",
                call.arguments[1]!,
            );
            context.expectSameEngine(engine, layer, call);
            context.reachFeature("gizmo:light", call);
            // What the pinned light-gizmo body builds: a sphere per type,
            // the cylinder rays of `_CreateLightLines`, and the hemisphere
            // dome it assembles itself through `createMeshFromData`.
            context.reachFeature("mesh:sphere", call);
            context.reachFeature("mesh:cylinder", call);
            context.reachFeature("mesh:from-data", call);
            return {
                kind: "light-gizmo",
                cpp:
                    `bbl::create_light_gizmo(` +
                    `${engine.cpp}, ${layer.cpp})`,
                engineCpp: engine.cpp,
            };
        }

        case "attachLightGizmoToLight": {
            context.expectArgumentCount(call, 2, 2);
            const gizmo = context.compileValue(call.arguments[0]!);
            const light = context.compileValue(call.arguments[1]!);
            context.expectKind(
                gizmo,
                "light-gizmo",
                call.arguments[0]!,
            );
            context.expectKind(light, "light", call.arguments[1]!);
            context.expectSameEngine(gizmo, light, call);
            // Which geometry the attach builds follows the light's TYPE,
            // and the record carries it -- the same tag the per-frame
            // follow asks for the position and direction arms.
            return {
                kind: "void",
                cpp:
                    `bbl::attach_light_gizmo_to_light(` +
                    `${context.requireEngine(gizmo, call)}, ` +
                    `${gizmo.cpp}, ${light.cpp})`,
            };
        }

        default:
            return undefined;
    }
}

import ts from "typescript";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";

export interface CameraIntrinsicContext
    extends IntrinsicCallContext {
    compileVec3(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    requireEngine(value: Value, node: ts.Node): string;
    requireDefaultEngine(node: ts.Node): string;
    fail(node: ts.Node, message: string): never;
}

export function compileCameraIntrinsic(
    context: CameraIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "createArcRotateCamera": {
            context.expectArgumentCount(call, 4, 4);
            const engine = context.requireDefaultEngine(call);
            context.reachFeature("camera:arc-rotate", call);
            return {
                kind: "camera",
                cpp:
                    // The four arguments are JavaScript numbers upstream
                    // and stay doubles here: `Math.PI / 2` is not its own
                    // float32 neighbour, and the difference reaches the
                    // composed view matrix (see CameraRecord).
                    `bbl::create_arc_rotate_camera(` +
                    `${engine}, ` +
                    `${context.compileNumber(call.arguments[0]!, "double")}, ` +
                    `${context.compileNumber(call.arguments[1]!, "double")}, ` +
                    `${context.compileNumber(call.arguments[2]!, "double")}, ` +
                    `${context.compileVec3(call.arguments[3]!, "double")})`,
                engineCpp: engine,
                cameraKind: "arc-rotate",
            };
        }

        case "createDefaultCamera": {
            context.expectArgumentCount(call, 1, 1);
            const scene =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                scene,
                "scene",
                call.arguments[0]!,
            );
            const engine = context.requireEngine(scene, call);
            context.reachFeature("camera:arc-rotate", call);
            context.reachFeature("camera:default", call);
            return {
                kind: "camera",
                cpp:
                    `bbl::create_default_camera(` +
                    `${engine}, ${scene.cpp})`,
                engineCpp: engine,
                cameraKind: "arc-rotate",
            };
        }

        case "createFreeCamera": {
            context.expectArgumentCount(call, 2, 2);
            const engine = context.requireDefaultEngine(call);
            context.reachFeature("camera:free", call);
            return {
                kind: "camera",
                cpp:
                    `bbl::create_free_camera(` +
                    `${engine}, ` +
                    `${context.compileVec3(call.arguments[0]!, "double")}, ` +
                    `${context.compileVec3(call.arguments[1]!, "double")})`,
                engineCpp: engine,
                cameraKind: "free",
            };
        }

        case "enableOrthographicCamera": {
            // src/camera/orthographic.ts: the opt-in installs the
            // projector and hands back live bounds that stay reachable
            // as `camera.ortho`. The reached surface derives every plane
            // from `halfHeight`; an explicit off-center plane would need
            // its own record state, so it is rejected rather than
            // silently derived.
            context.expectArgumentCount(call, 1, 2);
            const camera =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                camera,
                "camera",
                call.arguments[0]!,
            );
            let halfHeight = "1.0";
            const options = call.arguments[1];
            if (options) {
                const object =
                    context.expectObjectLiteral(options);
                for (const plane of [
                    "left",
                    "right",
                    "bottom",
                    "top",
                ]) {
                    if (
                        context.objectProperty(
                            object,
                            plane,
                        )
                    ) {
                        context.fail(
                            options,
                            `Orthographic '${plane}' planes are not lowered; the reached scenes derive every plane from halfHeight.`,
                        );
                    }
                }
                const value = context.objectProperty(
                    object,
                    "halfHeight",
                );
                if (value) {
                    halfHeight =
                        context.compileNumber(value, "double");
                }
            }
            context.reachFeature("camera:orthographic", call);
            const engine = context.requireEngine(
                camera,
                call,
            );
            return {
                kind: "camera-ortho",
                cpp:
                    `bbl::enable_orthographic_camera(` +
                    `${engine}, ${camera.cpp}, ${halfHeight})`,
                engineCpp: engine,
            };
        }

        default:
            return undefined;
    }
}

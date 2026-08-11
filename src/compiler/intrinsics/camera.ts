import ts from "typescript";
import type {
    Feature,
    Value,
    ValueKind,
} from "../types.js";

export interface CameraIntrinsicContext {
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
    compileVec3(expression: ts.Expression): string;
    compileNumber(expression: ts.Expression): string;
    requireEngine(value: Value, node: ts.Node): string;
    requireDefaultEngine(node: ts.Node): string;
    reachFeature(feature: Feature): void;
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
            context.reachFeature("camera:arc-rotate");
            return {
                kind: "camera",
                cpp:
                    `bbl::create_arc_rotate_camera(` +
                    `${engine}, ` +
                    `${context.compileNumber(call.arguments[0]!)}, ` +
                    `${context.compileNumber(call.arguments[1]!)}, ` +
                    `${context.compileNumber(call.arguments[2]!)}, ` +
                    `${context.compileVec3(call.arguments[3]!)})`,
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
            context.reachFeature("camera:arc-rotate");
            context.reachFeature("camera:default");
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
            context.reachFeature("camera:free");
            return {
                kind: "camera",
                cpp:
                    `bbl::create_free_camera(` +
                    `${engine}, ` +
                    `${context.compileVec3(call.arguments[0]!)}, ` +
                    `${context.compileVec3(call.arguments[1]!)})`,
                engineCpp: engine,
                cameraKind: "free",
            };
        }

        default:
            return undefined;
    }
}

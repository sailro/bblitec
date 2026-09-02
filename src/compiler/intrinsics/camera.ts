import ts from "typescript";
import {
    staticNumberValue,
    staticVec3Value,
    type PositiveIntegerContext,
} from "../option-helpers.js";
import type { DataType, DataTypeRegistry } from "../data-types.js";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";

export interface CameraIntrinsicContext
    extends IntrinsicCallContext, PositiveIntegerContext {
    readonly dataTypes: DataTypeRegistry;
    readonly checker: ts.TypeChecker;
    readonly dataLowerer: {
        structAggregate(
            dataType: DataType & { kind: "struct" },
            parts: readonly string[],
        ): string;
    };
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
    expectSameEngine(left: Value, right: Value, node: ts.Node): void;
    fail(node: ts.Node, message: string): never;
}

/**
 * The camera's construction as static numbers, when every argument is one.
 *
 * Only one consumer reads it -- the node-particle driver, whose flow-map
 * build derives a view-projection from the scene's camera -- and a camera
 * whose arguments are not literals simply carries no program, which that
 * consumer refuses by name.
 */
function arcRotateProgram(
    context: CameraIntrinsicContext,
    call: ts.CallExpression,
): Value["cameraProgram"] | undefined {
    // Folded rather than read as a literal: the corpus writes
    // `-Math.PI / 2`, which is a constant expression. Both halves of the
    // program -- these arguments and the property writes that follow -- go
    // through the same folder, so one cannot accept what the other drops.
    const scalar = (index: number): number | undefined =>
        staticNumberValue(context, call.arguments[index]!);
    const alpha = scalar(0);
    const beta = scalar(1);
    const radius = scalar(2);
    const target = staticVec3Value(context, call.arguments[3]!);
    if (
        alpha === undefined ||
        beta === undefined ||
        radius === undefined ||
        !target
    ) {
        return undefined;
    }
    return {
        kind: "arc-rotate",
        alpha,
        beta,
        radius,
        target,
        properties: [],
    };
}

/**
 * Record a write to a camera record on that camera's replayable program, or
 * drop the program when the write cannot be replayed.
 *
 * The polarity is deliberate. A recorded program is only worth anything if
 * it describes the camera the scene actually built, and there are several
 * places that write `engine.cameras[...]` -- through the camera handle,
 * through `scene.camera`, and through the vector setters. An unrecognised
 * write therefore has to *invalidate*, so a site that forgets to call this
 * leaves the program stale only if it also forgets the write is a write.
 * Its one consumer -- the node-particle flow-map build, which replays the
 * camera at generation -- then refuses by name instead of baking against a
 * view-projection the scene never had.
 */
export function noteCameraRecordWrite(
    context: PositiveIntegerContext,
    camera: Value | undefined,
    property: string,
    value: ts.Expression | undefined,
    simple: boolean,
): void {
    if (!camera?.cameraProgram) return;
    const written = value ? staticNumberValue(context, value) : undefined;
    if (!simple || written === undefined) {
        delete camera.cameraProgram;
        return;
    }
    camera.cameraProgram.properties.push([property, written]);
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
            const program = arcRotateProgram(context, call);
            return {
                ...(program ? { cameraProgram: program } : {}),
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

        // src/camera/camera.ts: `{ x: w[12], y: w[13], z: w[14] }` off
        // the camera's own world matrix, lowered as `camera_position` in
        // `camera_math.hpp` beside the matrix it reads. What is left here
        // is the record the scene sees.
        case "getCameraPosition": {
            context.expectArgumentCount(call, 1, 1);
            const camera = context.compileValue(call.arguments[0]!);
            context.expectKind(camera, "camera", call.arguments[0]!);
            const resultType = context.dataTypes.fromTsType(
                context.checker.getTypeAtLocation(call),
                call,
            );
            if (resultType?.kind !== "struct") {
                context.fail(
                    call,
                    "getCameraPosition must return the pin's own " +
                        "{ x, y, z } record.",
                );
            }
            const fields = context.dataTypes.structFields(
                resultType.name,
                call,
            );
            if (
                fields.length !== 3 ||
                !fields.every(
                    (field, index) =>
                        field.name === ["x", "y", "z"][index] &&
                        field.type.kind === "number",
                )
            ) {
                context.fail(
                    call,
                    "getCameraPosition must return the pin's own " +
                        "{ x, y, z } record.",
                );
            }
            const engine = context.requireEngine(camera, call);
            // The lanes come from `camera_position`, which the camera
            // lowerer emits from the pin's own two-line body -- so the
            // matrix is composed once rather than once per component, and
            // the float-store rule is stated where it is ported.
            const position =
                `bbl::upstream::camera_position(` +
                `${engine}.cameras[${camera.cpp}.value])`;
            const cppType = context.dataTypes.cppType(resultType);
            // Built through the data lowerer rather than braced here: the
            // reference-vs-value fork is stated in `structAggregate` alone,
            // which is why the hit records route through it too.
            const aggregate = context.dataLowerer.structAggregate(
                resultType,
                ["eye.x", "eye.y", "eye.z"],
            );
            return {
                kind: "data",
                cpp:
                    `([&]() -> ${cppType} { ` +
                    `const bbl::Vec3d eye = ${position}; ` +
                    `return ${aggregate}; }())`,
                dataType: resultType,
                engineCpp: engine,
            };
        }

        case "setCameraLimits": {
            context.expectArgumentCount(call, 2, 3);
            const camera = context.compileValue(call.arguments[0]!);
            context.expectKind(camera, "camera", call.arguments[0]!);
            if (camera.cameraKind && camera.cameraKind !== "arc-rotate") {
                context.fail(
                    call.arguments[0]!,
                    "setCameraLimits requires an ArcRotateCamera.",
                );
            }
            const limits = context.expectObjectLiteral(call.arguments[1]!);
            const fields = [
                "lowerAlphaLimit",
                "upperAlphaLimit",
                "lowerBetaLimit",
                "upperBetaLimit",
                "lowerRadiusLimit",
                "upperRadiusLimit",
            ] as const;
            let presentMask = 0;
            const values = fields.map((field, index) => {
                const value = context.objectProperty(limits, field);
                if (!value) return "0.0";
                presentMask |= 1 << index;
                return context.compileNumber(value, "double");
            });
            if (call.arguments[2]) {
                const scene = context.compileValue(call.arguments[2]);
                context.expectKind(scene, "scene", call.arguments[2]);
                context.expectSameEngine(camera, scene, call);
            }
            context.reachFeature("camera:arc-rotate", call);
            const engine = context.requireEngine(camera, call);
            return {
                kind: "void",
                cpp:
                    `bbl::set_camera_limits(${engine}, ${camera.cpp}, ` +
                    `${presentMask}u, std::array<double, 6>{${values.join(", ")}})`,
            };
        }

        default:
            return undefined;
    }
}

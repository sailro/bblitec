import ts from "typescript";
import { isPinnedType } from "./data-types.js";
import { cameraRecordField } from "./properties.js";
import type { Value } from "./types.js";

interface CameraWriteContext {
    checker: ts.TypeChecker;
    unwrap(expression: ts.Expression): ts.Expression;
    compileValue(expression: ts.Expression): Value;
    resolveRecordValue(expression: ts.Expression): Value | undefined;
    resolveRecordMember(expression: ts.PropertyAccessExpression): Value | undefined;
    lookupOptional(identifier: ts.Identifier): Value | undefined;
    requireEngine(value: Value, node: ts.Node): string;
    allocateTemporaryCppName(label: string): string;
    emit(line: string): void;
}

export function isCameraExpression(context: Pick<CameraWriteContext, "checker" | "lookupOptional" | "resolveRecordMember">, expression: ts.Expression): boolean {
    const value = ts.isIdentifier(expression) ? context.lookupOptional(expression) :
        ts.isPropertyAccessExpression(expression) ? context.resolveRecordMember(expression) : undefined;
    return value?.kind === "camera" || isPinnedType(context.checker.getNonNullableType(context.checker.getTypeAtLocation(expression)),
        ["Camera", "ArcRotateCamera", "FreeCamera", "BankedFreeCamera", "GeospatialCamera"]);
}

/** Resolve only an actual camera or its retained observable object. The
 * owner's handle is evaluated before the RHS, including a rebinding RHS. */
export function cameraNumberWrite(context: CameraWriteContext, expression: ts.Expression):
    { camera: Value; property: string; current: string; write(value: string): string } | undefined {
    const left = context.unwrap(expression);
    if (!ts.isPropertyAccessExpression(left)) return undefined;
    const ownerExpression = context.unwrap(left.expression);
    let camera: Value | undefined;
    let vector: Value["cameraVector"];
    let field: string | undefined;
    if (isCameraExpression(context, ownerExpression)) {
        if (!["alpha", "beta", "radius"].includes(left.name.text)) return undefined;
        field = cameraRecordField(left.name.text);
        if (!field) return undefined;
        camera = context.compileValue(ownerExpression);
    } else if (["x", "y", "z"].includes(left.name.text)) {
        vector = context.resolveRecordValue(ownerExpression)?.cameraVector;
        if (!vector && ts.isPropertyAccessExpression(ownerExpression) &&
            ["target", "position", "upVector"].includes(ownerExpression.name.text) &&
            isCameraExpression(context, ownerExpression.expression)) {
            vector = context.compileValue(ownerExpression).cameraVector;
        }
        camera = vector?.owner;
    }
    if (camera?.kind !== "camera") return undefined;
    const engine = context.requireEngine(camera, left);
    const handle = context.allocateTemporaryCppName("camera_write_owner");
    context.emit(`const auto ${handle} = ${camera.cpp};`);
    const record = `${engine}.cameras[${handle}.value]`;
    return vector ? {
        camera, property: vector.field,
        current: `${record}.${vector.field}.${left.name.text}`,
        write: (value) => `bbl::write_camera_vector_component(${record}, &bbl::CameraRecord::${vector.field}, &bbl::Vec3d::${left.name.text}, ${value});`,
    } : {
        camera, property: left.name.text,
        current: `${record}.${field!}`,
        write: (value) => `bbl::write_camera_scalar(${record}, &bbl::CameraRecord::${field!}, ${value});`,
    };
}

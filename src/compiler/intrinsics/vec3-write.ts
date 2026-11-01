import type ts from "typescript";
import type { LoweringServices } from "../lowering-services.js";
import type { Value } from "../types.js";
import { recordAt } from "../record-access.js";
import { cameraVectorComponentWrite } from "../camera-setters.js";

type Vec3WriteContext = Pick<
    LoweringServices,
    "dataTypes" | "fail" | "emit" | "bindings" | "requireEngine"
>;

export function writableVec3Lanes(
    context: Vec3WriteContext,
    value: Value,
    node: ts.Node,
): [string, string, string] {
    if (value.kind === "record") {
        const lanes = ["x", "y", "z"].map(
            (name) => value.recordProperties?.[name],
        );
        if (
            lanes.every(
                (lane) => lane?.kind === "number" && lane.cpp.length > 0,
            )
        ) {
            return lanes.map((lane) => lane!.cpp) as [string, string, string];
        }
    }
    if (value.kind === "data" && value.dataType?.kind === "struct") {
        const dataType = value.dataType;
        const separator = context.dataTypes.isReferenceStruct(dataType.name)
            ? "->"
            : ".";
        return ["x", "y", "z"].map((name) => {
            const field = context.dataTypes.structField(
                dataType.name,
                name,
                node,
            );
            return `${value.cpp}${separator}${field.name}`;
        }) as [string, string, string];
    }
    return context.fail(
        node,
        "A Vec3 *ToRef output must be a writable Vec3 record.",
    );
}

export function writeVec3Lanes(
    context: Vec3WriteContext,
    output: Value,
    outputNode: ts.Node,
    components: readonly [string, string, string],
): void {
    const vector = context.bindings.bindCameraVector(output).cameraVector;
    if (vector) {
        const engine = context.requireEngine(vector.owner, outputNode);
        const record = recordAt(`${engine}.cameras`, vector.owner.cpp);
        for (const [index, axis] of ["x", "y", "z"].entries())
            context.emit({
                kind: "expression",
                code: `${cameraVectorComponentWrite(record, vector.field, axis, components[index]!, true)};`,
            });
        return;
    }
    const lanes = writableVec3Lanes(context, output, outputNode);
    for (let index = 0; index < 3; index += 1) {
        context.emit({
            kind: "expression",
            code: `${lanes[index]} = ${components[index]};`,
        });
    }
}

/**
 * A lowered library record's members the application writes (its reads
 * are `lowered-record-surface.ts`'s): a public member of a record it holds
 * (`stream.screenError`, `pointSplatting.colorRenderMode`), and `rotation`,
 * a stream node's Euler proxy (scene-node.ts `createEulerProxy`), whose
 * writes update the quaternion the world matrix composes.
 */
import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import { isPinnedType } from "./data-types.js";
import {
    LOWERED_LIBRARIES,
    storeLoweredRecordProperty,
} from "./lowered-record-surface.js";

interface SplatStreamSurfaceContext extends Pick<
    LoweringServices,
    | "checker"
    | "compileValue"
    | "compileNumber"
    | "dataLowerer"
    | "bindings"
    | "emit"
    | "fail"
> {}

/** The Euler proxy's axes, in its setter's lane order. */
const EULER_AXES = ["x", "y", "z"];

/**
 * `record.<member> = v` of a lowered library record's public member
 * (`storeLoweredRecordProperty`), and `stream.rotation.<axis> = v`: the
 * Euler proxy's setter.
 */
export function emitSplatStreamAssignment(
    context: SplatStreamSurfaceContext,
    expression: ts.BinaryExpression,
): boolean {
    const left = expression.left;
    if (!ts.isPropertyAccessExpression(left)) return false;
    const recordOwner = (node: ts.Expression): boolean =>
        isPinnedType(
            context.checker.getTypeAtLocation(node),
            LOWERED_LIBRARIES.flatMap(({ library }) => library.records),
        );
    const rotation =
        ts.isPropertyAccessExpression(left.expression) &&
        left.expression.name.text === "rotation" &&
        isPinnedType(
            context.checker.getTypeAtLocation(left.expression.expression),
            ["GaussianSplatStream"],
        );
    if (!rotation && !recordOwner(left.expression)) return false;
    if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
        context.fail(
            expression.operatorToken,
            "A library record member takes a simple assignment natively.",
        );
    if (rotation) {
        const axis = EULER_AXES.indexOf(left.name.text);
        if (axis < 0)
            context.fail(
                left.name,
                `GaussianSplatStream.rotation has no axis '${left.name.text}'.`,
            );
        const stream = context.bindings.pinValueToTemporary(
            context.compileValue(left.expression.expression),
            "stream",
            left.expression,
        );
        context.emit({
            kind: "expression",
            code: `bbl::library::node_euler_write(*${stream.cpp}, ${axis}, ${context.compileNumber(expression.right, "double")});`,
        });
        return true;
    }
    const owner = context.bindings.pinValueToTemporary(
        context.compileValue(left.expression),
        "record",
        left.expression,
    );
    storeLoweredRecordProperty(
        context,
        owner,
        context.checker.getTypeAtLocation(left.expression),
        left.name.text,
        context.compileValue(expression.right),
        left.name,
    );
    return true;
}

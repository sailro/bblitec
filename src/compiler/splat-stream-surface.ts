/**
 * The members of a streamed Gaussian-splat cloud the application writes
 * (its reads are `lowered-record-surface.ts`'s): a public number of the
 * lowered `GaussianSplatStream` record (`bblite/upstream_splat_stream.hpp`),
 * and `rotation`, the stream node's Euler proxy (scene-node.ts
 * `createEulerProxy`), whose writes update the quaternion the world matrix
 * composes.
 */
import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import { isPinnedType } from "./data-types.js";
import { publicMember } from "./lowered-record-surface.js";
import { valueKindOf } from "./type-facts.js";

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

const isNumber = (type: ts.Type): boolean => valueKindOf(type) === "number";

/** The Euler proxy's axes, in its setter's lane order. */
const EULER_AXES = ["x", "y", "z"];

/**
 * `stream.<member> = v` of a public number the pin lets the application
 * write, and `stream.rotation.<axis> = v`: a plain write of the record's
 * field, and the Euler proxy's setter.
 */
export function emitSplatStreamAssignment(
    context: SplatStreamSurfaceContext,
    expression: ts.BinaryExpression,
): boolean {
    const left = expression.left;
    if (!ts.isPropertyAccessExpression(left)) return false;
    const streamOwner = (node: ts.Expression): boolean =>
        isPinnedType(context.checker.getTypeAtLocation(node), [
            "GaussianSplatStream",
        ]);
    const rotation =
        ts.isPropertyAccessExpression(left.expression) &&
        left.expression.name.text === "rotation" &&
        streamOwner(left.expression.expression);
    if (!rotation && !streamOwner(left.expression)) return false;
    if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
        context.fail(
            expression.operatorToken,
            "A stream member takes a simple assignment natively.",
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
    const member = publicMember(context.checker, left, "GaussianSplatStream");
    if (!member || member.readonly || !isNumber(member.type))
        return context.fail(
            left.name,
            `GaussianSplatStream.${left.name.text} is not a writable stream member.`,
        );
    const stream = context.bindings.pinValueToTemporary(
        context.compileValue(left.expression),
        "stream",
        left.expression,
    );
    context.emit({
        kind: "expression",
        code: `(${stream.cpp})->${member.field} = ${context.compileNumber(expression.right, "double")};`,
    });
    return true;
}

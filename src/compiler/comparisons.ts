/**
 * The comparison a condition performs: which operator it is, how C++ spells
 * it and what it folds to when generation settled both operands.
 *
 * Spelling and numeric folding are the shared operator layer's
 * (`PINNED_COMPARISON_OPERATORS`, `foldNumericComparison`), so scene code
 * and pinned bodies compare with one meaning.
 */
import ts from "typescript";
import {
    PINNED_COMPARISON_OPERATORS,
    foldNumericComparison,
} from "../lowering/pinned-operators.js";
import type { Value } from "./types.js";

const STRICT_EQUALITY = new Map<ts.SyntaxKind, ts.SyntaxKind>([
    [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken],
    [
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ],
]);

/** A comparison lowered as the strict or ordering operator `kind`, spelled `cpp`. */
export interface ConditionComparison {
    readonly kind: ts.SyntaxKind;
    readonly cpp: string;
}

/** The one primitive type every member of `type` has, if it has one. */
function primitiveKind(
    type: ts.Type,
): "number" | "string" | "boolean" | undefined {
    const kinds = new Set(
        (type.isUnion() ? type.types : [type]).map((member) =>
            member.flags & ts.TypeFlags.NumberLike
                ? "number"
                : member.flags & ts.TypeFlags.StringLike
                  ? "string"
                  : member.flags & ts.TypeFlags.BooleanLike
                    ? "boolean"
                    : undefined,
        ),
    );
    const [kind] = kinds;
    return kinds.size === 1 ? kind : undefined;
}

/**
 * The comparison `expression` performs, or undefined when its operator is
 * not a comparison. A loose equality between operands of one primitive type
 * is the strict one (ECMAScript IsLooseEqual, step 1); across types it
 * coerces, which `"coercing"` reports so the caller can refuse it.
 */
export function conditionComparison(
    checker: ts.TypeChecker,
    expression: ts.BinaryExpression,
): ConditionComparison | "coercing" | undefined {
    const token = expression.operatorToken.kind;
    const strict = STRICT_EQUALITY.get(token);
    if (strict !== undefined) {
        const left = primitiveKind(checker.getTypeAtLocation(expression.left));
        if (
            left === undefined ||
            left !== primitiveKind(checker.getTypeAtLocation(expression.right))
        )
            return "coercing";
    }
    const kind = strict ?? token;
    const cpp = PINNED_COMPARISON_OPERATORS.get(kind);
    return cpp === undefined ? undefined : { kind, cpp };
}

/**
 * A comparison whose operands generation settled, folded: two static
 * strings compare for identity, two finite static numbers through the
 * shared numeric fold. Undefined when either operand is still a runtime
 * value or the operator does not fold them.
 */
export function foldSettledComparison(
    kind: ts.SyntaxKind,
    left: Value,
    right: Value,
): boolean | undefined {
    if (left.staticString !== undefined && right.staticString !== undefined) {
        const equal = left.staticString === right.staticString;
        if (kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return equal;
        if (kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) return !equal;
    }
    const staticNumber = (value: Value): number | undefined =>
        value.kind === "number" && !value.parameterBinding
            ? value.staticNumber
            : undefined;
    const leftNumber = staticNumber(left);
    const rightNumber = staticNumber(right);
    return leftNumber !== undefined &&
        rightNumber !== undefined &&
        Number.isFinite(leftNumber) &&
        Number.isFinite(rightNumber)
        ? foldNumericComparison(kind, leftNumber, rightNumber)
        : undefined;
}

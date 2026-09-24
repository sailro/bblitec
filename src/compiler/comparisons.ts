/**
 * The comparison a condition performs: which operator it is, how C++ spells
 * it and what it folds to when generation settled both operands -- and the
 * two comparisons generation decides outright, boolean identity over
 * settled operands and `instanceof` a local class.
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
import { isJsonValue } from "./json-bridge.js";
import type { LoweringServices } from "./lowering-services.js";
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

/** What the generation-decided comparisons read of the compiler. */
export interface ComparisonContext extends Pick<
    LoweringServices,
    | "checker"
    | "symbols"
    | "evaluator"
    | "dataTypes"
    | "compileValue"
    | "compilePropertyAccess"
    | "bindings"
    | "probeEmission"
    | "fail"
> {}

/**
 * `<boolean> === <boolean>` where both sides settle at generation.
 *
 * Returns the answer as `"true"`/`"false"`, or nothing where either side
 * is a run-time value, which leaves the comparison to the arms of
 * `compileCondition` that emit one.
 */
export function foldBooleanComparison(
    context: ComparisonContext,
    expression: ts.BinaryExpression,
): string | undefined {
    const equals =
        expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken;
    if (
        !equals &&
        expression.operatorToken.kind !==
            ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
        return undefined;
    }
    const booleanLike = (side: ts.Expression): boolean =>
        (context.checker.getNonNullableType(
            context.checker.getTypeAtLocation(side),
        ).flags &
            ts.TypeFlags.BooleanLike) !==
        0;
    if (!booleanLike(expression.left) || !booleanLike(expression.right))
        return undefined;
    const settled = (side: ts.Expression): string | undefined => {
        const resolved = context.evaluator.resolveStaticExpression(side);
        if (resolved.kind === ts.SyntaxKind.TrueKeyword) return "true";
        if (resolved.kind === ts.SyntaxKind.FalseKeyword) return "false";
        const value = ts.isIdentifier(resolved)
            ? context.bindings.lookupOptional(resolved)
            : ts.isPropertyAccessExpression(resolved)
              ? context.compilePropertyAccess(resolved)
              : undefined;
        if (value?.kind === "json-null") return "nullish";
        return value?.kind === "boolean" &&
            (value.cpp === "true" || value.cpp === "false")
            ? value.cpp
            : undefined;
    };
    return context.probeEmission(() => {
        const left = settled(expression.left);
        const right = settled(expression.right);
        if (left === undefined || right === undefined) return undefined;
        // Nullable booleans can still distinguish null from undefined;
        // only their inequality with a concrete boolean is established.
        if (left === "nullish" && right === "nullish") return undefined;
        return String((left === right) === equals);
    });
}

/**
 * `value instanceof LocalClass` is decided at generation: a class
 * instance is a compile-time record that names its class, and a struct
 * stored in data names the class it was mapped from. A value that could
 * be an instance of several classes has no representation yet.
 */
export function compileClassInstanceOf(
    context: ComparisonContext,
    expression: ts.BinaryExpression,
    className: ts.Identifier,
): string | undefined {
    const symbol = context.symbols.valueSymbol(className);
    const declaration = symbol?.valueDeclaration;
    if (!declaration || !ts.isClassDeclaration(declaration)) {
        return undefined;
    }
    const value = context.compileValue(expression.left);
    if (isJsonValue(value)) {
        const type = context.dataTypes.fromSharedReturnType(
            context.checker.getDeclaredTypeOfSymbol(symbol),
            expression,
        );
        if (type?.kind !== "struct")
            context.fail(
                expression,
                "A dynamic instanceof check requires a represented class type.",
            );
        return `${value.cpp}.instance_of<${context.dataTypes.cppType(type)}>()`;
    }
    if (value.kind === "record" && value.classDeclaration) {
        return value.classDeclaration === declaration ? "true" : "false";
    }
    if (value.kind === "data" && value.dataType?.kind === "struct") {
        const classType = context.dataTypes.fromTsType(
            context.checker.getDeclaredTypeOfSymbol(symbol),
            expression,
        );
        if (classType?.kind === "struct") {
            return classType.name === value.dataType.name ? "true" : "false";
        }
    }
    if (
        value.kind === "json-null" ||
        value.kind === "number" ||
        value.kind === "string" ||
        value.kind === "boolean" ||
        value.kind === "tuple" ||
        (value.kind === "data" &&
            value.dataType !== undefined &&
            value.dataType.kind !== "struct" &&
            value.dataType.kind !== "optional")
    ) {
        // A scalar, a tuple, a collection: never an instance.
        return "false";
    }
    context.fail(
        expression,
        `'instanceof ${className.text}' is decided for class instances and structs; this value's class is not represented.`,
    );
}

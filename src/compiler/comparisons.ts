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
import { staticBooleanOf } from "./values/model.js";
import {
    PINNED_COMPARISON_OPERATORS,
    foldNumericComparison,
} from "../lowering/pinned-operators.js";
import { localClassOfSymbol } from "./class-members.js";
import { isJsonValue } from "./json-bridge.js";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import { valueKinds } from "./type-facts.js";

const STRICT_EQUALITY = new Map<ts.SyntaxKind, ts.SyntaxKind>([
    [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken],
    [
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ],
]);

/** A comparison lowered as the strict or ordering operator `kind`, spelled `cpp`. */
interface ConditionComparison {
    readonly kind: ts.SyntaxKind;
    readonly cpp: string;
}

/** The one primitive type every member of `type` has, if it has one. */
function primitiveKind(
    type: ts.Type,
): "number" | "string" | "boolean" | "bigint" | undefined {
    const kinds = valueKinds(type);
    const [kind] = kinds;
    return kinds.size === 1 &&
        (kind === "number" ||
            kind === "string" ||
            kind === "boolean" ||
            kind === "bigint")
        ? kind
        : undefined;
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
 * An empty object a literal created without a native object (an identity
 * token, `const token = {}`): its one property table, which every value of
 * that object shares (`BindingScopes.recordDeclaration`).
 */
function emptyObjectToken(value: Value): object | undefined {
    return value.kind === "record" &&
        !value.cpp &&
        value.recordProperties &&
        !value.classDeclaration &&
        [
            value.recordProperties,
            value.recordMethods,
            value.recordGetters,
            value.recordSetters,
        ].every((members) => Object.keys(members ?? {}).length === 0)
        ? value.recordProperties
        : undefined;
}

/**
 * A comparison whose operands generation settled, folded: two static
 * strings compare for identity, two finite static numbers through the
 * shared numeric fold, two empty object tokens by being one object.
 * Undefined when either operand is still a runtime value or the operator
 * does not fold them.
 */
export function foldSettledComparison(
    kind: ts.SyntaxKind,
    left: Value,
    right: Value,
): boolean | undefined {
    const leftToken = emptyObjectToken(left);
    const rightToken = emptyObjectToken(right);
    const sameString =
        left.staticString !== undefined && right.staticString !== undefined
            ? left.staticString === right.staticString
            : undefined;
    const equal =
        leftToken && rightToken ? leftToken === rightToken : sameString;
    if (equal !== undefined) {
        if (kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return equal;
        if (kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) return !equal;
    }
    // Two strings order by UTF-16 code units, as the generator's own `<`
    // does; two C++ literals would compare their addresses.
    if (left.staticString !== undefined && right.staticString !== undefined) {
        const [a, b] = [left.staticString, right.staticString];
        if (kind === ts.SyntaxKind.LessThanToken) return a < b;
        if (kind === ts.SyntaxKind.LessThanEqualsToken) return a <= b;
        if (kind === ts.SyntaxKind.GreaterThanToken) return a > b;
        if (kind === ts.SyntaxKind.GreaterThanEqualsToken) return a >= b;
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
    | "classLowerer"
    | "compileValue"
    | "propertyAccess"
    | "bindings"
    | "probeEmission"
    | "fail"
> {}

/**
 * A strict comparison to a boolean where both sides settle at generation.
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
    const booleanLike = (side: ts.Expression): boolean => {
        const type = context.checker.getNonNullableType(
            context.checker.getTypeAtLocation(side),
        );
        // A specialized option can hold a known boolean even when its
        // declaration also permits an object. The value proof below still
        // requires a concrete boolean on at least one side.
        return valueKinds(type).has("boolean");
    };
    if (!booleanLike(expression.left) || !booleanLike(expression.right))
        return undefined;
    const settled = (side: ts.Expression): string | undefined => {
        const resolved = context.evaluator.resolveStaticExpression(side);
        if (resolved.kind === ts.SyntaxKind.TrueKeyword) return "true";
        if (resolved.kind === ts.SyntaxKind.FalseKeyword) return "false";
        const value = ts.isIdentifier(resolved)
            ? context.bindings.lookupOptional(resolved)
            : ts.isPropertyAccessExpression(resolved)
              ? context.propertyAccess.compilePropertyAccess(resolved)
              : undefined;
        if (value?.kind === "json-null") return "nullish";
        if (value?.kind === "record" && !value.cpp) return "object";
        if (value?.kind !== "boolean") return undefined;
        const known = staticBooleanOf(value);
        return known === undefined ? undefined : String(known);
    };
    return context.probeEmission(() => {
        const left = settled(expression.left);
        const right = settled(expression.right);
        if (left === undefined || right === undefined) return undefined;
        // Object identity and null versus undefined remain undecided;
        // only their inequality with a concrete boolean is established.
        const boolean = (value: string): boolean =>
            value === "true" || value === "false";
        if (!boolean(left) && !boolean(right)) return undefined;
        return String((left === right) === equals);
    });
}

/**
 * `value instanceof LocalClass` is decided at generation for a class
 * instance whose class is known -- a compile-time record names it, and a
 * struct stored in data names the class it was mapped from -- and on the
 * stored tag for a receiver a class hierarchy leaves open.
 */
export function compileClassInstanceOf(
    context: ComparisonContext,
    expression: ts.BinaryExpression,
    className: ts.Identifier,
): string | undefined {
    const symbol = context.symbols.valueSymbol(className);
    const declaration = localClassOfSymbol(symbol);
    if (!symbol || !declaration) {
        return undefined;
    }
    const value = context.compileValue(expression.left);
    const instance = context.classLowerer.instanceOf(
        value,
        declaration,
        expression.left,
    );
    if (instance !== undefined) return instance;
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

// Shared option-lowering helpers.
//
// The option compilers agree on three small contracts: an options
// object may only carry the properties the reached lowering reads, a
// count lowers to a positive integer literal (or the engine's own
// msaaSamples), and an optional flag folds to a static boolean. They
// are declared once here so every per-domain option module states the
// same rule instead of carrying its own copy.
import ts from "typescript";
import type { Value } from "./types.js";

export interface ObjectValidationContext {
    propertyName(
        name: ts.PropertyName,
    ): string | undefined;
    fail(node: ts.Node, message: string): never;
}

export function validateObjectProperties(
    context: ObjectValidationContext,
    object: ts.ObjectLiteralExpression,
    supported: readonly string[],
    message: string,
): void {
    const supportedNames = new Set(supported);
    for (const property of object.properties) {
        const name =
            ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property)
                ? context.propertyName(property.name)
                : undefined;
        if (!name || !supportedNames.has(name)) {
            context.fail(property, message);
        }
    }
}

export interface PositiveIntegerContext {
    resolveStaticExpression(
        expression: ts.Expression,
    ): ts.Expression;
    lookup(identifier: ts.Identifier): Value;
    fail(node: ts.Node, message: string): never;
}

export function compilePositiveInteger(
    context: PositiveIntegerContext,
    expression: ts.Expression,
): string {
    const unwrapped = context.resolveStaticExpression(
        expression,
    );
    if (
        ts.isPropertyAccessExpression(unwrapped) &&
        ts.isIdentifier(unwrapped.expression) &&
        unwrapped.name.text === "msaaSamples" &&
        context.lookup(unwrapped.expression).kind ===
            "engine"
    ) {
        const engine = context.lookup(
            unwrapped.expression,
        );
        return `${engine.msaaSamples ?? 4}u`;
    }
    const value = compileStaticNumber(
        context,
        unwrapped,
        "A count",
    );
    if (!Number.isInteger(value) || value <= 0) {
        context.fail(unwrapped, "Expected a positive integer literal.");
    }
    return `${value}u`;
}

export interface StaticBooleanContext {
    resolveStaticExpression(
        expression: ts.Expression,
    ): ts.Expression;
    compileBoolean(expression: ts.Expression): string;
}

export function compileOptionalStaticBoolean(
    context: StaticBooleanContext,
    expression: ts.Expression | undefined,
    fallback: boolean,
): boolean {
    if (!expression) return fallback;
    return context.compileBoolean(context.resolveStaticExpression(expression)) ===
        "true";
}

/**
 * A number an option carries as a value rather than as an expression.
 *
 * Most options lower to a native expression, but some have to be *known* at
 * generation: a shader the pin composes from an option's value, and the
 * effect parameter table a post-process record carries, are both settled
 * before any native code exists. Anything that does not resolve to a literal
 * here is refused rather than defaulted.
 */
export function compileStaticNumber(
    context: PositiveIntegerContext,
    expression: ts.Expression,
    label: string,
): number {
    const unwrapped = context.resolveStaticExpression(expression);
    if (ts.isNumericLiteral(unwrapped)) {
        const value = Number(unwrapped.text);
        if (!Number.isFinite(value)) {
            context.fail(unwrapped, `Invalid numeric literal in ${label}.`);
        }
        return value;
    }
    if (
        ts.isPrefixUnaryExpression(unwrapped) &&
        (unwrapped.operator === ts.SyntaxKind.MinusToken ||
            unwrapped.operator === ts.SyntaxKind.PlusToken)
    ) {
        const operand = compileStaticNumber(
            context,
            unwrapped.operand,
            label,
        );
        return unwrapped.operator === ts.SyntaxKind.MinusToken
            ? -operand
            : operand;
    }
    if (ts.isIdentifier(unwrapped)) {
        const value = context.lookup(unwrapped);
        if (value.staticNumber !== undefined) {
            return value.staticNumber;
        }
    }
    context.fail(
        unwrapped,
        `${label} must be a static number.`,
    );
}

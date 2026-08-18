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
    if (ts.isIdentifier(unwrapped)) {
        const value = context.lookup(unwrapped);
        if (
            value.kind === "number" &&
            value.staticNumber !== undefined &&
            Number.isInteger(value.staticNumber) &&
            value.staticNumber > 0
        ) {
            return `${value.staticNumber}u`;
        }
    }
    if (!ts.isNumericLiteral(unwrapped)) {
        context.fail(unwrapped, "Expected a positive integer literal.");
    }
    const value = Number(unwrapped.text);
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

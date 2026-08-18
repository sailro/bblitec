// Browser-only expression erasure.
//
// A pinned scene reaches browser objects -- console, document, window,
// performance, URLSearchParams -- that have no native counterpart, so
// the compiler erases those expressions instead of lowering them. This
// module answers the three questions that erasure turns on: whether an
// expression is browser-only, what value it evaluates to at compile
// time (window.location.search is always empty, so a query flag reads
// as unset and a condition over it folds to the branch the native
// scene keeps), and whether a call is browser instrumentation that is
// erased outright.
import ts from "typescript";
import type { Value } from "./types.js";

export interface BrowserErasureContext {
    unwrap(expression: ts.Expression): ts.Expression;
    canvasSizeProperty(
        expression: ts.Expression,
    ): "width" | "height" | undefined;
    lookupOptional(
        identifier: ts.Identifier,
    ): Value | undefined;
}

export class BrowserErasure {
    public constructor(
        private readonly context: BrowserErasureContext,
    ) {}

    public isBrowserOnlyExpression(expression: ts.Expression): boolean {
        const unwrapped = this.context.unwrap(expression);
        if (this.context.canvasSizeProperty(unwrapped)) {
            return false;
        }
        if (ts.isIdentifier(unwrapped)) {
            if (
                [
                    "console",
                    "document",
                    "performance",
                    "window",
                ].includes(unwrapped.text)
            ) {
                return true;
            }
            return (
                this.context.lookupOptional(unwrapped)?.kind ===
                "browser"
            );
        }
        if (
            ts.isNewExpression(unwrapped) &&
            ts.isIdentifier(unwrapped.expression) &&
            unwrapped.expression.text === "URLSearchParams"
        ) {
            return true;
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            return this.isBrowserOnlyExpression(
                unwrapped.expression,
            );
        }
        if (ts.isBinaryExpression(unwrapped)) {
            return (
                this.isBrowserOnlyExpression(
                    unwrapped.left,
                ) ||
                this.isBrowserOnlyExpression(
                    unwrapped.right,
                )
            );
        }
        if (ts.isPrefixUnaryExpression(unwrapped)) {
            return this.isBrowserOnlyExpression(
                unwrapped.operand,
            );
        }
        if (ts.isCallExpression(unwrapped)) {
            if (
                ts.isPropertyAccessExpression(
                    unwrapped.expression,
                ) &&
                this.isBrowserOnlyExpression(
                    unwrapped.expression.expression,
                )
            ) {
                return true;
            }
            const browserArgument =
                unwrapped.arguments.some((argument) =>
                    this.isBrowserOnlyExpression(argument),
                );
            if (
                ts.isIdentifier(unwrapped.expression) &&
                ["isNaN", "parseFloat"].includes(
                    unwrapped.expression.text,
                )
            ) {
                return browserArgument;
            }
            if (
                ts.isPropertyAccessExpression(
                    unwrapped.expression,
                ) &&
                ts.isIdentifier(
                    unwrapped.expression.expression,
                ) &&
                unwrapped.expression.expression.text ===
                    "Number" &&
                unwrapped.expression.name.text === "isFinite"
            ) {
                return browserArgument;
            }
            return false;
        }
        return false;
    }

    public evaluateBrowserCondition(
        expression: ts.Expression,
    ): boolean | undefined {
        const value =
            this.evaluateBrowserValue(expression);
        return value?.kind === "boolean"
            ? value.value
            : undefined;
    }

    public evaluateBrowserValue(
        expression: ts.Expression,
    ): Value["browserValue"] | undefined {
        const unwrapped = this.context.unwrap(expression);
        if (unwrapped.kind === ts.SyntaxKind.TrueKeyword) {
            return { kind: "boolean", value: true };
        }
        if (unwrapped.kind === ts.SyntaxKind.FalseKeyword) {
            return { kind: "boolean", value: false };
        }
        if (unwrapped.kind === ts.SyntaxKind.NullKeyword) {
            return { kind: "null" };
        }
        if (ts.isStringLiteral(unwrapped)) {
            return {
                kind: "string",
                value: unwrapped.text,
            };
        }
        if (ts.isNumericLiteral(unwrapped)) {
            return {
                kind: "number",
                value: Number(unwrapped.text),
            };
        }
        if (ts.isIdentifier(unwrapped)) {
            return this.context.lookupOptional(unwrapped)
                ?.browserValue;
        }
        if (
            ts.isNewExpression(unwrapped) &&
            ts.isIdentifier(unwrapped.expression) &&
            unwrapped.expression.text === "URLSearchParams"
        ) {
            return { kind: "search-params" };
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            unwrapped.name.text === "search" &&
            ts.isPropertyAccessExpression(
                unwrapped.expression,
            ) &&
            unwrapped.expression.name.text === "location" &&
            ts.isIdentifier(
                unwrapped.expression.expression,
            ) &&
            unwrapped.expression.expression.text === "window"
        ) {
            return { kind: "string", value: "" };
        }
        if (
            ts.isPrefixUnaryExpression(unwrapped) &&
            unwrapped.operator ===
                ts.SyntaxKind.ExclamationToken
        ) {
            const operand = this.evaluateBrowserValue(
                unwrapped.operand,
            );
            const truthy = this.browserTruthy(operand);
            return truthy === undefined
                ? undefined
                : { kind: "boolean", value: !truthy };
        }
        if (ts.isBinaryExpression(unwrapped)) {
            const left = this.evaluateBrowserValue(
                unwrapped.left,
            );
            if (
                unwrapped.operatorToken.kind ===
                ts.SyntaxKind.AmpersandAmpersandToken
            ) {
                const truthy = this.browserTruthy(left);
                if (truthy === false) {
                    return {
                        kind: "boolean",
                        value: false,
                    };
                }
                return truthy
                    ? this.evaluateBrowserValue(
                          unwrapped.right,
                      )
                    : undefined;
            }
            if (
                unwrapped.operatorToken.kind ===
                ts.SyntaxKind.BarBarToken
            ) {
                const truthy = this.browserTruthy(left);
                if (truthy === true) {
                    return left;
                }
                return truthy === false
                    ? this.evaluateBrowserValue(
                          unwrapped.right,
                      )
                    : undefined;
            }
            return undefined;
        }
        if (ts.isCallExpression(unwrapped)) {
            if (
                ts.isPropertyAccessExpression(
                    unwrapped.expression,
                ) &&
                ts.isIdentifier(
                    unwrapped.expression.expression,
                )
            ) {
                const owner = this.context.lookupOptional(
                    unwrapped.expression.expression,
                )?.browserValue;
                if (owner?.kind === "search-params") {
                    if (
                        unwrapped.expression.name.text ===
                        "has"
                    ) {
                        return {
                            kind: "boolean",
                            value: false,
                        };
                    }
                    if (
                        unwrapped.expression.name.text ===
                        "get"
                    ) {
                        return { kind: "null" };
                    }
                }
            }
            if (
                ts.isIdentifier(unwrapped.expression) &&
                unwrapped.expression.text === "parseFloat"
            ) {
                const argument =
                    this.evaluateBrowserValue(
                        unwrapped.arguments[0]!,
                    );
                const text =
                    argument?.kind === "string"
                        ? argument.value
                        : "";
                return {
                    kind: "number",
                    value: Number.parseFloat(text),
                };
            }
            if (
                ts.isIdentifier(unwrapped.expression) &&
                unwrapped.expression.text === "isNaN"
            ) {
                const argument =
                    this.evaluateBrowserValue(
                        unwrapped.arguments[0]!,
                    );
                return argument?.kind === "number"
                    ? {
                          kind: "boolean",
                          value: Number.isNaN(
                              argument.value,
                          ),
                      }
                    : undefined;
            }
            if (
                ts.isPropertyAccessExpression(
                    unwrapped.expression,
                ) &&
                ts.isIdentifier(
                    unwrapped.expression.expression,
                ) &&
                unwrapped.expression.expression.text ===
                    "Number" &&
                unwrapped.expression.name.text === "isFinite"
            ) {
                const argument =
                    this.evaluateBrowserValue(
                        unwrapped.arguments[0]!,
                    );
                return argument?.kind === "number"
                    ? {
                          kind: "boolean",
                          value: Number.isFinite(
                              argument.value,
                          ),
                      }
                    : undefined;
            }
        }
        return undefined;
    }

    private browserTruthy(
        value: Value["browserValue"] | undefined,
    ): boolean | undefined {
        if (!value) {
            return undefined;
        }
        switch (value.kind) {
            case "boolean":
                return value.value;
            case "null":
                return false;
            case "number":
                return (
                    value.value !== 0 &&
                    !Number.isNaN(value.value)
                );
            case "search-params":
                return true;
            case "string":
                return value.value.length > 0;
        }
    }

    public isBrowserInstrumentationCall(call: ts.CallExpression): boolean {
        const objectAssign =
            ts.isPropertyAccessExpression(call.expression) &&
            ts.isIdentifier(call.expression.expression) &&
            call.expression.expression.text === "Object" &&
            call.expression.name.text === "assign";
        const deviceEvent =
            ts.isPropertyAccessExpression(call.expression) &&
            call.expression.name.text ===
                "addEventListener" &&
            ts.isPropertyAccessExpression(
                call.expression.expression,
            ) &&
            call.expression.expression.name.text ===
                "_device";
        return objectAssign || deviceEvent;
    }
}

import ts from "typescript";
import { isRecord } from "../json-fields.js";
import { readAssetBytesSync } from "./asset-bytes-sync.js";
import { resolveBundledAsset } from "./assets.js";
import { someAnalysisNode } from "./analysis-walk.js";
import type { LoweringServices } from "./lowering-services.js";
import { notJson, staticJsonValue } from "./option-helpers.js";
import { resolvedSymbol } from "./symbols.js";

interface StaticDocumentContext extends Pick<
    LoweringServices,
    | "checker"
    | "bindings"
    | "compileValue"
    | "compileBoolean"
    | "probeEmission"
    | "resolveStaticExpression"
    | "unwrap"
    | "libraryGlobal"
    | "options"
    | "fail"
> {}

/** A document sink can specialize immutable packaged text and local JSON edits.
 * Native fetch, parsing and assignments still execute; this evaluator only
 * proves the bytes the pinned shader compiler must see before native startup.
 */
export function staticDocumentText(
    context: StaticDocumentContext,
    expression: ts.Expression,
): string | undefined {
    if (
        (context.checker.getTypeAtLocation(expression).flags &
            ts.TypeFlags.StringLike) ===
        0
    )
        return undefined;
    const active = new Set<ts.Node>();
    const decline = Symbol("dynamic document");
    const symbolAt = (node: ts.Node): ts.Symbol | undefined =>
        resolvedSymbol(context.checker, node);
    const globalMethod = (
        node: ts.Expression,
        object: string,
        method: string,
    ): boolean => {
        const value = context.unwrap(node);
        return (
            ts.isPropertyAccessExpression(value) &&
            value.name.text === method &&
            context.libraryGlobal(value.expression) === object
        );
    };
    const evaluate = (
        source: ts.Expression,
        before = source.getStart(),
    ): unknown => {
        const node = context.unwrap(source);
        if (active.has(node)) return decline;
        active.add(node);
        try {
            if (ts.isIdentifier(node)) {
                const symbol = symbolAt(node);
                const declaration = symbol?.valueDeclaration;
                if (
                    declaration &&
                    ts.isVariableDeclaration(declaration) &&
                    declaration.initializer &&
                    declaration.getSourceFile() === node.getSourceFile() &&
                    declaration.end < before &&
                    ts.isVariableDeclarationList(declaration.parent) &&
                    ts.isVariableStatement(declaration.parent.parent) &&
                    ts.isBlock(declaration.parent.parent.parent)
                ) {
                    let result = evaluate(
                        declaration.initializer,
                        declaration.initializer.getStart(),
                    );
                    if (result === decline) return decline;
                    const block = declaration.parent.parent.parent;
                    const refers = (root: ts.Node): boolean =>
                        someAnalysisNode(
                            root,
                            (child) =>
                                ts.isIdentifier(child) &&
                                symbolAt(child) === symbol,
                            { types: "skip", memberNames: "skip" },
                        );
                    const statements = (statement: ts.Statement): boolean => {
                        if (
                            statement.end <= declaration.parent.parent.end ||
                            statement.getStart() >= before
                        )
                            return true;
                        if (ts.isBlock(statement))
                            return statement.statements.every(statements);
                        if (ts.isIfStatement(statement)) {
                            if (!refers(statement)) return true;
                            const condition = context.probeEmission(
                                () =>
                                    context.compileBoolean(
                                        statement.expression,
                                    ),
                                () => false,
                            );
                            if (condition !== "true" && condition !== "false")
                                return false;
                            const branch =
                                condition === "true"
                                    ? statement.thenStatement
                                    : statement.elseStatement;
                            return !branch || statements(branch);
                        }
                        if (statement.end > before) return true;
                        if (
                            ts.isExpressionStatement(statement) &&
                            ts.isBinaryExpression(statement.expression)
                        ) {
                            const assignment = statement.expression;
                            const left = context.unwrap(assignment.left);
                            if (
                                ts.isIdentifier(left) &&
                                symbolAt(left) === symbol
                            ) {
                                if (
                                    assignment.operatorToken.kind !==
                                    ts.SyntaxKind.EqualsToken
                                )
                                    return false;
                                result = evaluate(
                                    assignment.right,
                                    assignment.right.getStart(),
                                );
                                return result !== decline;
                            }
                            if (
                                ts.isPropertyAccessExpression(left) &&
                                ts.isIdentifier(left.expression) &&
                                symbolAt(left.expression) === symbol
                            ) {
                                if (
                                    assignment.operatorToken.kind !==
                                        ts.SyntaxKind.EqualsToken ||
                                    !isRecord(result) ||
                                    left.name.text === "__proto__"
                                )
                                    return false;
                                const member = evaluate(
                                    assignment.right,
                                    assignment.right.getStart(),
                                );
                                if (member === decline) return false;
                                Object.defineProperty(result, left.name.text, {
                                    value: member,
                                    enumerable: true,
                                    writable: true,
                                    configurable: true,
                                });
                                return true;
                            }
                        }
                        // A primitive has no aliases that can mutate it. Parsed
                        // objects may only undergo the direct writes above.
                        return (
                            (!isRecord(result) && !Array.isArray(result)) ||
                            !refers(statement)
                        );
                    };
                    return block.statements.every(statements)
                        ? result
                        : decline;
                }
                const bound = context.bindings.lookupOptional(node);
                if (bound?.staticString !== undefined)
                    return bound.staticString;
                if (bound?.staticNumber !== undefined)
                    return bound.staticNumber;
                if (bound?.staticBoolean !== undefined)
                    return bound.staticBoolean;
            }
            const literal = staticJsonValue(context, node);
            if (literal !== notJson) return literal;
            if (ts.isCallExpression(node) && node.arguments.length === 1) {
                if (globalMethod(node.expression, "JSON", "parse")) {
                    const text = evaluate(node.arguments[0]!, node.getStart());
                    if (typeof text !== "string") return decline;
                    try {
                        return JSON.parse(text);
                    } catch (error: unknown) {
                        return context.fail(
                            node,
                            `Packaged graph document is not JSON: ${error instanceof Error ? error.message : String(error)}`,
                        );
                    }
                }
                if (globalMethod(node.expression, "JSON", "stringify")) {
                    const value = evaluate(node.arguments[0]!, node.getStart());
                    return value === decline ? decline : JSON.stringify(value);
                }
            }
            const compiled = context.probeEmission(
                () => context.compileValue(source),
                () => false,
            );
            const value =
                compiled.kind === "promise" ? compiled.promiseResult : compiled;
            if (value?.staticString !== undefined) return value.staticString;
            if (value?.packagedBodySource) {
                const asset = resolveBundledAsset(
                    value.packagedBodySource,
                    context.options.fileName,
                    context.options,
                );
                return new TextDecoder().decode(
                    readAssetBytesSync(asset, context.options.fileName),
                );
            }
            return decline;
        } finally {
            active.delete(node);
        }
    };
    const result = evaluate(expression);
    return typeof result === "string" ? result : undefined;
}

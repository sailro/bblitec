/**
 * The pinned-expression renderer the glTF leaf lowerings (matrix leaves,
 * SH prescale) and the animation manager clock share: one
 * `PinnedNumericLowerer` per scope, with the scope's names, substitutions
 * and reads as its leaves and everything else refused in the family's voice.
 */
import ts from "typescript";
import { PinnedNumericLowerer } from "../pinned-numeric-lowerer.js";
import { cppPrecedence } from "../pinned-numeric-expression.js";
import { pinnedNumericMathCalls, pinnedMathCall } from "../pinned-operators.js";
import { CppExpressionScope, RenderedCpp, refuseNode } from "./shared.js";

const expressionLowerers = new WeakMap<
    CppExpressionScope,
    PinnedNumericLowerer
>();
const expressionMathCalls = pinnedNumericMathCalls();

export function renderCppExpression(
    scope: CppExpressionScope,
    expression: ts.Expression,
): RenderedCpp {
    let lowerer = expressionLowerers.get(scope);
    if (!lowerer) {
        lowerer = new PinnedNumericLowerer(scope.file, {
            bindings: new Map(),
            calls: expressionMathCalls,

            foldConditions: false,
            expressionSpelling: {
                parentheses: "minimal",
                numeric: scope.numeric,
                remainder: "integral",
            },
            expression: (node) => renderCppLeaf(scope, node),
        });
        expressionLowerers.set(scope, lowerer);
    }
    return lowerer.renderExpression(expression);
}

function renderCppLeaf(
    scope: CppExpressionScope,
    expression: ts.Expression,
): RenderedCpp | undefined {
    if (ts.isIdentifier(expression)) {
        const substituted = scope.substitutions?.get(expression.text);
        if (substituted) return substituted;
        const name = scope.names.get(expression.text);
        if (name !== undefined) {
            return { text: name, precedence: cppPrecedence.primary };
        }
        refuseNode(
            scope.symbol,
            scope.file,
            expression,
            "reads an identifier with no C++ correspondence",
        );
    }
    if (ts.isPropertyAccessChain(expression)) {
        if (!scope.chainRead) {
            refuseNode(
                scope.symbol,
                scope.file,
                expression,
                "reads an optional property where none lowers",
            );
        }
        return scope.chainRead(expression);
    }
    if (ts.isElementAccessExpression(expression)) {
        if (!scope.elementRead) {
            refuseNode(
                scope.symbol,
                scope.file,
                expression,
                "indexes a buffer where none lowers",
            );
        }
        return scope.elementRead(expression);
    }
    if (ts.isPropertyAccessExpression(expression) && scope.propertyRead) {
        return scope.propertyRead(expression);
    }
    if (ts.isCallExpression(expression)) {
        const math = pinnedMathCall(expression);
        if (math) return undefined;
        const callee = expression.expression;
        if (scope.callRead) return scope.callRead(expression);
        refuseNode(
            scope.symbol,
            scope.file,
            expression,
            ts.isPropertyAccessExpression(callee) &&
                ts.isIdentifier(callee.expression) &&
                callee.expression.text === "Math"
                ? `calls Math.${callee.name.text}, which has no lowering`
                : "calls a function this lowering cannot carry",
        );
    }
    if (
        ts.isNumericLiteral(expression) ||
        ts.isPrefixUnaryExpression(expression) ||
        ts.isConditionalExpression(expression) ||
        ts.isBinaryExpression(expression) ||
        expression.kind === ts.SyntaxKind.TrueKeyword ||
        expression.kind === ts.SyntaxKind.FalseKeyword
    )
        return undefined;
    refuseNode(
        scope.symbol,
        scope.file,
        expression,
        "uses an expression this lowering cannot carry",
    );
}

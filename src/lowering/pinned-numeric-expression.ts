import ts from "typescript";
import { doubleLiteral } from "../cpp-literals.js";
import { PINNED_BOOLEAN_OPERATORS, pinnedRemainderCall } from "./pinned-operators.js";

export interface RenderedCpp {
    text: string;
    precedence: number;
}

export const cppPrecedence = {
    conditional: 0, logicalOr: 1, logicalAnd: 2, equality: 3,
    relational: 4, additive: 5, multiplicative: 6, unary: 7, primary: 8,
} as const;

export interface PinnedExpressionSpelling {
    parentheses?: "grouped" | "source" | "minimal";
    numeric?: (literal: ts.NumericLiteral) => string;
    remainder?: "floating" | "integral";
}

export function cppPrimary(text: string): RenderedCpp {
    return { text, precedence: cppPrecedence.primary };
}

const precedence = new Map<ts.SyntaxKind, number>([
    [ts.SyntaxKind.BarBarToken, cppPrecedence.logicalOr],
    [ts.SyntaxKind.AmpersandAmpersandToken, cppPrecedence.logicalAnd],
    ...[ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken]
        .map(kind => [kind, cppPrecedence.equality] as const),
    ...[ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
        ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken]
        .map(kind => [kind, cppPrecedence.relational] as const),
    [ts.SyntaxKind.PlusToken, cppPrecedence.additive],
    [ts.SyntaxKind.MinusToken, cppPrecedence.additive],
    [ts.SyntaxKind.AsteriskToken, cppPrecedence.multiplicative],
    [ts.SyntaxKind.SlashToken, cppPrecedence.multiplicative],
    [ts.SyntaxKind.PercentToken, cppPrecedence.multiplicative],
]);

/** Scalar arithmetic shared by numeric bodies, UBO writers and glTF leaves. */
export function renderPinnedArithmetic(
    node: ts.Expression,
    render: (expression: ts.Expression) => RenderedCpp,
    spelling: PinnedExpressionSpelling = {},
): RenderedCpp | undefined {
    const style = spelling.parentheses ?? "grouped";
    const operand = (value: RenderedCpp, minimum: number): string =>
        style === "minimal" && value.precedence < minimum ? `(${value.text})` : value.text;
    const result = (text: string, precedence: number, conditional = false): RenderedCpp =>
        style === "grouped" || (style === "source" && conditional)
            ? cppPrimary(`(${text})`) : { text, precedence };
    if (ts.isNumericLiteral(node)) return cppPrimary(spelling.numeric?.(node) ?? doubleLiteral(Number(node.text)));
    if (node.kind === ts.SyntaxKind.TrueKeyword) return cppPrimary("true");
    if (node.kind === ts.SyntaxKind.FalseKeyword) return cppPrimary("false");
    if (ts.isPrefixUnaryExpression(node)) {
        const operator = node.operator === ts.SyntaxKind.MinusToken ? "-"
            : node.operator === ts.SyntaxKind.PlusToken ? "+"
            : node.operator === ts.SyntaxKind.ExclamationToken ? "!" : undefined;
        if (operator === undefined) return undefined;
        const value = render(node.operand);
        const minimum = (operator === "+" || operator === "-") && value.text.startsWith(operator)
            ? cppPrecedence.primary : cppPrecedence.unary;
        return result(operator + operand(value, minimum), cppPrecedence.unary);
    }
    if (ts.isConditionalExpression(node)) {
        return result(`${operand(render(node.condition), cppPrecedence.logicalOr)} ? ` +
            `${render(node.whenTrue).text} : ${render(node.whenFalse).text}`, cppPrecedence.conditional, true);
    }
    if (!ts.isBinaryExpression(node)) return undefined;
    const kind = node.operatorToken.kind;
    if (kind === ts.SyntaxKind.PercentToken && spelling.remainder !== "integral") {
        return cppPrimary(pinnedRemainderCall(render(node.left).text, render(node.right).text));
    }
    if (kind === ts.SyntaxKind.AsteriskAsteriskToken) {
        return cppPrimary(`std::pow(${render(node.left).text}, ${render(node.right).text})`);
    }
    const operator = kind === ts.SyntaxKind.PercentToken ? "%" : PINNED_BOOLEAN_OPERATORS.get(kind);
    const level = precedence.get(kind);
    if (operator === undefined || level === undefined) return undefined;
    return result(`${operand(render(node.left), level)} ${operator} ${operand(render(node.right), level + 1)}`, level);
}

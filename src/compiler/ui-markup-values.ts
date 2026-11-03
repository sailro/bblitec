import ts from "typescript";
import { finalReturn } from "./loop-control.js";
import { resolvedSymbol } from "./symbols.js";
import {
    isOperandSelection,
    unwrapExpression,
    yieldedOperands,
} from "./syntax.js";
import { valueKindOf } from "./type-facts.js";

/** Fixed authored fragments around runtime text. Null spans never carry markup. */
export type UiMarkupShape = readonly (string | null)[];

/** The most shapes one value is followed through; past it the value is runtime text. */
const shapeLimit = 32;

const runtimeText: readonly UiMarkupShape[] = [[null]];

function sameShape(left: UiMarkupShape, right: UiMarkupShape): boolean {
    return (
        left.length === right.length &&
        left.every((part, index) => part === right[index])
    );
}

/** Each shape once, in first-seen order; too many read as runtime text. */
function distinct(shapes: readonly UiMarkupShape[]): readonly UiMarkupShape[] {
    const result: UiMarkupShape[] = [];
    for (const shape of shapes)
        if (!result.some((seen) => sameShape(seen, shape))) result.push(shape);
    return result.length > shapeLimit ? runtimeText : result;
}

interface ShapeContext {
    checker: ts.TypeChecker;
    immutable(declaration: ts.Node): boolean;
    rebound(identifier: ts.Identifier): boolean;
}

function join(parts: UiMarkupShape): UiMarkupShape {
    const result: Array<string | null> = [];
    for (const part of parts) {
        const last = result.at(-1);
        if (typeof part === "string" && typeof last === "string")
            result[result.length - 1] = last + part;
        else if (part !== "") result.push(part);
    }
    return result;
}

/** Every shape the concatenation of one shape per operand spells. */
function concatenated(
    operands: readonly (readonly UiMarkupShape[])[],
): readonly UiMarkupShape[] {
    let shapes: readonly UiMarkupShape[] = [[]];
    for (const operand of operands) {
        if (shapes.length * operand.length > shapeLimit) return runtimeText;
        shapes = shapes.flatMap((prefix) =>
            operand.map((shape) => join([...prefix, ...shape])),
        );
    }
    return distinct(shapes);
}

/**
 * The shapes a value can take, one per authored way of building it: a choice
 * between fixed fragments keeps each branch. Inspect provenance only; the
 * consumer reads the already evaluated string.
 */
export function uiMarkupValueShapes(
    expression: ts.Expression,
    context: ShapeContext,
    active: ReadonlySet<ts.Node> = new Set(),
): readonly UiMarkupShape[] {
    const node = unwrapExpression(expression);
    if (active.has(node) || active.size > 64) return runtimeText;
    const nested = new Set([...active, node]);
    const shapes = (value: ts.Expression): readonly UiMarkupShape[] =>
        uiMarkupValueShapes(value, context, nested);
    if (ts.isStringLiteralLike(node)) return [[node.text]];
    if (ts.isTemplateExpression(node))
        return concatenated([
            [[node.head.text]],
            ...node.templateSpans.flatMap((span) => [
                shapes(span.expression),
                [[span.literal.text]],
            ]),
        ]);
    if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        valueKindOf(context.checker.getTypeAtLocation(node)) === "string"
    )
        return concatenated([shapes(node.left), shapes(node.right)]);
    if (ts.isIdentifier(node)) {
        const declaration = resolvedSymbol(
            context.checker,
            node,
        )?.valueDeclaration;
        if (
            declaration &&
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer &&
            context.immutable(declaration)
        )
            return shapes(declaration.initializer);
    }
    if (isOperandSelection(node))
        return distinct(
            yieldedOperands(node).flatMap(({ operand }) => shapes(operand)),
        );
    if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        !context.rebound(node.expression)
    ) {
        const declaration = resolvedSymbol(
            context.checker,
            node.expression,
        )?.valueDeclaration;
        const called =
            declaration && ts.isFunctionDeclaration(declaration)
                ? declaration
                : declaration &&
                    ts.isVariableDeclaration(declaration) &&
                    context.immutable(declaration) &&
                    declaration.initializer &&
                    (ts.isArrowFunction(declaration.initializer) ||
                        ts.isFunctionExpression(declaration.initializer))
                  ? declaration.initializer
                  : undefined;
        if (called?.body) {
            if (!ts.isBlock(called.body)) return shapes(called.body);
            const returns: UiMarkupShape[] = [];
            const visit = (child: ts.Node): void => {
                if (ts.isFunctionLike(child)) return;
                if (ts.isReturnStatement(child))
                    returns.push(
                        ...(child.expression
                            ? shapes(child.expression)
                            : runtimeText),
                    );
                else ts.forEachChild(child, visit);
            };
            visit(called.body);
            // A trailing return ensures that a normal fallthrough cannot produce undefined.
            if (finalReturn(called.body) && returns.length)
                return distinct(returns);
        }
    }
    return runtimeText;
}

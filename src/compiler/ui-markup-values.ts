import ts from "typescript";
import { finalReturn } from "./loop-control.js";
import { resolvedSymbol } from "./symbols.js";
import {
    isOperandSelection,
    unwrapExpression,
    yieldedOperands,
} from "./syntax.js";
import { valueKindOf } from "./type-facts.js";

/**
 * A run-time span of a markup value: the expressions whose texts it
 * concatenates, in order (none when the value is followed no further).
 * Spans never carry markup.
 */
export interface UiMarkupSpan {
    readonly sources: readonly ts.Expression[];
}

/** Fixed authored fragments around run-time spans. */
export type UiMarkupShape = readonly (string | UiMarkupSpan)[];

/** The fixed text of fragments; a span spells nothing. */
export function uiMarkupText(parts: UiMarkupShape): string {
    return parts.map((part) => (typeof part === "string" ? part : "")).join("");
}

/** The index of a shape's first run-time span, or -1. */
export function uiMarkupSpanIndex(shape: UiMarkupShape): number {
    return shape.findIndex((part) => typeof part !== "string");
}

/** The most shapes one value is followed through; past it the value is runtime text. */
const shapeLimit = 32;

const unfollowedText: readonly UiMarkupShape[] = [[{ sources: [] }]];

/** The value of `node` as one run-time span. */
const runtimeText = (node: ts.Expression): readonly UiMarkupShape[] => [
    [{ sources: [node] }],
];

function sameShape(left: UiMarkupShape, right: UiMarkupShape): boolean {
    return (
        left.length === right.length &&
        left.every((part, index) => {
            const other = right[index];
            return typeof part === "string"
                ? part === other
                : typeof other !== "string";
        })
    );
}

/**
 * Each shape once, in first-seen order, a span keeping the sources of every
 * shape it stands for; too many read as runtime text.
 */
function distinct(shapes: readonly UiMarkupShape[]): readonly UiMarkupShape[] {
    const result: UiMarkupShape[] = [];
    for (const shape of shapes) {
        const index = result.findIndex((seen) => sameShape(seen, shape));
        if (index < 0) result.push(shape);
        else
            result[index] = result[index]!.map((part, at) => {
                const other = shape[at]!;
                return typeof part === "string" || typeof other === "string"
                    ? part
                    : { sources: [...part.sources, ...other.sources] };
            });
    }
    return result.length > shapeLimit ? unfollowedText : result;
}

interface ShapeContext {
    checker: ts.TypeChecker;
    immutable(declaration: ts.Node): boolean;
    rebound(identifier: ts.Identifier): boolean;
}

/** Adjacent fragments, and adjacent spans, joined: run-time text beside run-time text is one span. */
function join(parts: UiMarkupShape): UiMarkupShape {
    const result: Array<string | UiMarkupSpan> = [];
    for (const part of parts) {
        const last = result.at(-1);
        if (typeof part === "string" && typeof last === "string")
            result[result.length - 1] = last + part;
        else if (
            typeof part !== "string" &&
            last !== undefined &&
            typeof last !== "string"
        )
            result[result.length - 1] = {
                sources: [...last.sources, ...part.sources],
            };
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
        if (shapes.length * operand.length > shapeLimit) return unfollowedText;
        shapes = shapes.flatMap((prefix) =>
            operand.map((shape) => join([...prefix, ...shape])),
        );
    }
    return distinct(shapes);
}

/**
 * The shapes a value can take, one per authored way of building it: a choice
 * between fixed fragments keeps each branch. Inspect provenance only; the
 * consumer reads the already evaluated string. A value that is run-time text
 * as a whole is one span of the expression itself.
 */
export function uiMarkupValueShapes(
    expression: ts.Expression,
    context: ShapeContext,
    active: ReadonlySet<ts.Node> = new Set(),
): readonly UiMarkupShape[] {
    const node = unwrapExpression(expression);
    const shapes = followedShapes(node, context, active);
    return shapes.length === 1 &&
        shapes[0]!.length === 1 &&
        typeof shapes[0]![0] !== "string"
        ? runtimeText(node)
        : shapes;
}

function followedShapes(
    node: ts.Expression,
    context: ShapeContext,
    active: ReadonlySet<ts.Node>,
): readonly UiMarkupShape[] {
    if (active.has(node) || active.size > 64) return runtimeText(node);
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
                            : unfollowedText),
                    );
                else ts.forEachChild(child, visit);
            };
            visit(called.body);
            // A trailing return ensures that a normal fallthrough cannot produce undefined.
            if (finalReturn(called.body) && returns.length)
                return distinct(returns);
        }
    }
    return runtimeText(node);
}

import ts from "typescript";
import { resolvedSymbol } from "./symbols.js";
import { unwrapExpression } from "./syntax.js";

/** Fixed authored fragments around runtime text. Null spans never carry markup. */
export type UiMarkupShape = readonly (string | null)[];

function sameShape(left: UiMarkupShape, right: UiMarkupShape): boolean {
    return (
        left.length === right.length &&
        left.every((part, index) => part === right[index])
    );
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

/** Inspect provenance only; the consumer reads the already evaluated string. */
export function uiMarkupValueShape(
    expression: ts.Expression,
    context: ShapeContext,
    active: ReadonlySet<ts.Node> = new Set(),
): UiMarkupShape {
    const node = unwrapExpression(expression);
    if (active.has(node) || active.size > 64) return [null];
    const nested = new Set([...active, node]);
    const shape = (value: ts.Expression): UiMarkupShape =>
        uiMarkupValueShape(value, context, nested);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        return [node.text];
    if (ts.isTemplateExpression(node))
        return join([
            node.head.text,
            ...node.templateSpans.flatMap((span) => [
                ...shape(span.expression),
                span.literal.text,
            ]),
        ]);
    if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        (context.checker.getTypeAtLocation(node).flags &
            ts.TypeFlags.StringLike) !==
            0
    )
        return join([...shape(node.left), ...shape(node.right)]);
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
            return shape(declaration.initializer);
    }
    if (ts.isConditionalExpression(node)) {
        const yes = shape(node.whenTrue),
            no = shape(node.whenFalse);
        if (sameShape(yes, no)) return yes;
    }
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
            if (!ts.isBlock(called.body)) return shape(called.body);
            const returns: UiMarkupShape[] = [];
            const visit = (child: ts.Node): void => {
                if (ts.isFunctionLike(child)) return;
                if (ts.isReturnStatement(child))
                    returns.push(
                        child.expression ? shape(child.expression) : [null],
                    );
                else ts.forEachChild(child, visit);
            };
            visit(called.body);
            // A trailing return ensures that a normal fallthrough cannot produce undefined.
            const last = called.body.statements.at(-1);
            if (
                last &&
                ts.isReturnStatement(last) &&
                returns.length &&
                returns.every((value) => sameShape(value, returns[0]!))
            )
                return returns[0]!;
        }
    }
    return [null];
}

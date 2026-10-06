import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { unwrapExpression } from "./syntax.js";

/**
 * Whether evaluating an expression yields an object no other reference can
 * hold: an object or array literal or a construction, a selection among such
 * objects and nullish literals, or a call whose callee returns only such
 * objects. Storing that object in another representation (a record as
 * another record type, a tuple as a growable array) copies or adopts an
 * object nothing else can write, read or compare, so the change is
 * unobservable. Anything else may name an object the program still reaches.
 */
export function yieldsFreshObject(
    checker: ts.TypeChecker,
    node: ts.Node,
): boolean {
    return fresh(checker, node, new Set());
}

/**
 * Whether every element of an array expression is a fresh record: an array
 * literal of them, or a `map` / `flatMap` whose callback returns only them.
 */
export function yieldsFreshRecordElements(
    checker: ts.TypeChecker,
    node: ts.Node,
): boolean {
    if (!ts.isExpression(node)) return false;
    const expression = unwrapExpression(node);
    if (ts.isArrayLiteralExpression(expression))
        return expression.elements.every(
            (element) =>
                !ts.isSpreadElement(element) &&
                fresh(checker, element, new Set()),
        );
    if (
        ts.isCallExpression(expression) &&
        ts.isPropertyAccessExpression(expression.expression) &&
        expression.expression.name.text === "map"
    ) {
        const callback = expression.arguments[0];
        return (
            callback !== undefined &&
            (ts.isArrowFunction(callback) ||
                ts.isFunctionExpression(callback)) &&
            returnsOnlyFresh(checker, callback, new Set())
        );
    }
    return false;
}

function fresh(
    checker: ts.TypeChecker,
    node: ts.Node,
    active: Set<ts.Node>,
): boolean {
    if (!ts.isExpression(node)) return false;
    const expression = unwrapExpression(node);
    if (
        ts.isObjectLiteralExpression(expression) ||
        ts.isArrayLiteralExpression(expression) ||
        ts.isNewExpression(expression)
    )
        return true;
    if (
        expression.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(expression) && expression.text === "undefined")
    )
        return true;
    if (ts.isConditionalExpression(expression))
        return (
            fresh(checker, expression.whenTrue, active) &&
            fresh(checker, expression.whenFalse, active)
        );
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))
        return returnsOnlyFresh(checker, expression, active);
    if (ts.isCallExpression(expression)) {
        const declaration =
            checker.getResolvedSignature(expression)?.declaration;
        return (
            declaration !== undefined &&
            (ts.isFunctionDeclaration(declaration) ||
                ts.isArrowFunction(declaration) ||
                ts.isFunctionExpression(declaration) ||
                ts.isMethodDeclaration(declaration)) &&
            returnsOnlyFresh(checker, declaration, active)
        );
    }
    return false;
}

/** Every value the function can return is a fresh object or nullish. */
function returnsOnlyFresh(
    checker: ts.TypeChecker,
    declaration: ts.FunctionLikeDeclaration,
    active: Set<ts.Node>,
): boolean {
    const body = declaration.body;
    if (!body || active.has(declaration) || active.size > 8) return false;
    if (!ts.isBlock(body)) {
        active.add(declaration);
        try {
            return fresh(checker, body, active);
        } finally {
            active.delete(declaration);
        }
    }
    active.add(declaration);
    try {
        let returns = 0;
        let only = true;
        forEachAnalysisNode(
            body,
            (node) => {
                if (!only) return "skip";
                if (ts.isReturnStatement(node)) {
                    returns++;
                    if (
                        !node.expression ||
                        !fresh(checker, node.expression, active)
                    )
                        only = false;
                }
            },
            { functions: "skip", types: "skip" },
        );
        return only && returns > 0;
    } finally {
        active.delete(declaration);
    }
}

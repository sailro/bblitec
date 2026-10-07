import ts from "typescript";
import { someAnalysisNode } from "./analysis-walk.js";
import { declaredSymbol } from "./symbols.js";
import { unwrapExpression } from "./syntax.js";
import type { Value } from "./types.js";

/** A void annotation alone does not constrain a JavaScript return value. */
export function hasUndefinedCompletion(
    checker: ts.TypeChecker,
    declaration: ts.SignatureDeclaration | ts.JSDocSignature | undefined,
): boolean {
    if (
        !declaration ||
        !(
            ts.isFunctionDeclaration(declaration) ||
            ts.isFunctionExpression(declaration) ||
            ts.isArrowFunction(declaration) ||
            ts.isMethodDeclaration(declaration)
        ) ||
        !declaration.body
    )
        return false;
    const isUndefined = (expression: ts.Expression): boolean =>
        ts.isVoidExpression(unwrapExpression(expression)) ||
        (checker.getTypeAtLocation(expression).flags &
            ts.TypeFlags.Undefined) !==
            0;
    return ts.isBlock(declaration.body)
        ? !someAnalysisNode(
              declaration.body,
              (node) =>
                  ts.isReturnStatement(node) &&
                  !!node.expression &&
                  !isUndefined(node.expression),
              { functions: "skip" },
          )
        : isUndefined(declaration.body);
}

interface UndefinedContext {
    checker: ts.TypeChecker;
    bindings: {
        lookupOptional(identifier: ts.Identifier): Value | undefined;
        isImmutableVariable(node: ts.Node | undefined): boolean;
    };
    sharedClosures: { identifierIsRebound(identifier: ts.Identifier): boolean };
    dataTypes: { resolveTypeParameter(type: ts.Type): ts.Type };
}

/** Follow immutable results to a concrete completion, never an erased void type. */
export function provenUndefinedValue(
    context: UndefinedContext,
    node: ts.Node,
): boolean {
    const seen = new Set<ts.Node>();
    const visit = (source: ts.Node): boolean => {
        if (!ts.isExpression(source)) return false;
        const expression = unwrapExpression(source);
        if (seen.has(expression)) return false;
        seen.add(expression);
        // A type parameter answers through the substitution in force.
        if (
            ts.isVoidExpression(expression) ||
            (context.dataTypes.resolveTypeParameter(
                context.checker.getTypeAtLocation(expression),
            ).flags &
                ts.TypeFlags.Undefined) !==
                0
        )
            return true;
        if (ts.isAwaitExpression(expression))
            return visit(expression.expression);
        if (ts.isIdentifier(expression)) {
            const declaration = declaredSymbol(
                context.checker,
                expression,
            )?.valueDeclaration;
            return (
                !!declaration &&
                ts.isVariableDeclaration(declaration) &&
                context.bindings.isImmutableVariable(declaration) &&
                !!declaration.initializer &&
                visit(declaration.initializer)
            );
        }
        if (!ts.isCallExpression(expression)) return false;
        const callee = unwrapExpression(expression.expression);
        if (ts.isIdentifier(callee)) {
            const stored = context.bindings.lookupOptional(callee)?.dataType;
            if (stored?.kind === "function" && stored.undefinedCompletion)
                return true;
            if (context.sharedClosures.identifierIsRebound(callee))
                return false;
            const declaration = declaredSymbol(
                context.checker,
                callee,
            )?.valueDeclaration;
            if (
                !declaration ||
                !(
                    ts.isFunctionDeclaration(declaration) ||
                    context.bindings.isImmutableVariable(declaration)
                )
            )
                return false;
        } else if (
            !ts.isArrowFunction(callee) &&
            !ts.isFunctionExpression(callee)
        )
            return false;
        return hasUndefinedCompletion(
            context.checker,
            context.checker.getResolvedSignature(expression)?.declaration,
        );
    };
    return visit(node);
}

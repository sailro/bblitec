import ts from "typescript";
import { someAnalysisNode } from "./analysis-walk.js";
import {
    declarationInDefaultLibrary,
    declaredSymbol,
    libraryGlobal,
} from "./symbols.js";
import { hasNoValueCompletion } from "./native-return-type.js";
import { unwrapExpression } from "./syntax.js";
import type { Value } from "./types.js";
import type { DataType } from "./data-types.js";

/** Existing library operations with an actual undefined completion. */
function undefinedLibraryCall(
    checker: ts.TypeChecker,
    node: ts.Expression,
): boolean {
    const expression = unwrapExpression(node);
    if (!ts.isCallExpression(expression)) return false;
    const callee = unwrapExpression(expression.expression);
    const signature = checker.getResolvedSignature(expression);
    const declaration = signature?.declaration;
    const global = libraryGlobal(checker, callee);
    const consoleMethod =
        ts.isPropertyAccessExpression(callee) &&
        libraryGlobal(checker, callee.expression) === "console";
    return (
        !!signature &&
        !!declaration &&
        (global !== undefined || consoleMethod) &&
        (ts.isFunctionDeclaration(declaration) ||
            ts.isMethodSignature(declaration)) &&
        declarationInDefaultLibrary(declaration) &&
        hasNoValueCompletion(checker.getReturnTypeOfSignature(signature))
    );
}

/** A void annotation alone does not constrain a JavaScript return value. */
export function hasUndefinedCompletion(
    checker: ts.TypeChecker,
    declaration: ts.SignatureDeclaration | ts.JSDocSignature | undefined,
    awaited = false,
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
    if (
        (!ts.isArrowFunction(declaration) && declaration.asteriskToken) ||
        (!awaited &&
            ts
                .getModifiers(declaration)
                ?.some(
                    (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
                ))
    )
        return false;
    const isUndefined = (expression: ts.Expression): boolean =>
        ts.isVoidExpression(unwrapExpression(expression)) ||
        undefinedLibraryCall(checker, expression) ||
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

/** A source-specialized callback retains the body behind an immutable alias. */
export function hasUndefinedCallbackCompletion(
    checker: ts.TypeChecker,
    value: Value | undefined,
    awaited = false,
): boolean {
    if (value?.kind !== "callback" || value.cpp) return false;
    const declaration = value.callbackDeclaration;
    if (!declaration) return false;
    const source = ts.isIdentifier(declaration)
        ? declaredSymbol(checker, declaration)?.valueDeclaration
        : declaration;
    return (
        !!source &&
        (ts.isFunctionDeclaration(source) ||
            ts.isFunctionExpression(source) ||
            ts.isArrowFunction(source) ||
            ts.isMethodDeclaration(source)) &&
        hasUndefinedCompletion(checker, source, awaited)
    );
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
    const visit = (source: ts.Node, awaited = false): boolean => {
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
            return visit(expression.expression, true);
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
                visit(declaration.initializer, awaited)
            );
        }
        if (!ts.isCallExpression(expression)) return false;
        const callee = unwrapExpression(expression.expression);
        const signature = context.checker.getResolvedSignature(expression);
        const declaration = signature?.declaration;
        if (undefinedLibraryCall(context.checker, expression)) return true;
        if (ts.isIdentifier(callee)) {
            const bound = context.bindings.lookupOptional(callee);
            const stored = bound?.dataType;
            if (
                stored?.kind === "function" &&
                (stored.undefinedCompletion ||
                    (awaited && stored.awaitedUndefinedCompletion))
            )
                return true;
            if (context.sharedClosures.identifierIsRebound(callee))
                return false;
            // A name bound at generation to one function literal or
            // declaration (a specialized callback parameter) calls it.
            if (hasUndefinedCallbackCompletion(context.checker, bound, awaited))
                return true;
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
        return hasUndefinedCompletion(context.checker, declaration, awaited);
    };
    return visit(node);
}

/** Primitive return lanes cannot participate in thenable adoption. */
export function isNonThenableDataType(type: DataType | undefined): boolean {
    if (!type) return false;
    if (type.kind === "optional" || type.kind === "tagged")
        return isNonThenableDataType(type.inner);
    if (type.kind === "union") return type.members.every(isNonThenableDataType);
    return [
        "number",
        "boolean",
        "string",
        "enum",
        "undefined",
        "null",
    ].includes(type.kind);
}

/** A concrete synchronous body may discard a scalar result in finally. */
export function hasNonThenableCompletion(
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
        !declaration.body ||
        (!ts.isArrowFunction(declaration) && declaration.asteriskToken) ||
        ts
            .getModifiers(declaration)
            ?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    )
        return false;
    const scalar = (expression: ts.Expression): boolean => {
        if (
            ts.isVoidExpression(unwrapExpression(expression)) ||
            undefinedLibraryCall(checker, expression)
        )
            return true;
        const type = checker.getTypeAtLocation(expression);
        return (type.isUnion() ? type.types : [type]).every(
            (member) =>
                (member.flags &
                    (ts.TypeFlags.NumberLike |
                        ts.TypeFlags.StringLike |
                        ts.TypeFlags.BooleanLike |
                        ts.TypeFlags.BigIntLike |
                        ts.TypeFlags.ESSymbolLike |
                        ts.TypeFlags.Null |
                        ts.TypeFlags.Undefined |
                        ts.TypeFlags.Never)) !==
                0,
        );
    };
    return ts.isBlock(declaration.body)
        ? !someAnalysisNode(
              declaration.body,
              (node) =>
                  ts.isReturnStatement(node) &&
                  !!node.expression &&
                  !scalar(node.expression),
              { functions: "skip" },
          )
        : scalar(declaration.body);
}

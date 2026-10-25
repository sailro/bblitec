import ts from "typescript";
import { someAnalysisNode } from "./analysis-walk.js";
import {
    declarationInDefaultLibrary,
    declaredSymbol,
    libraryGlobal,
    calledDeclaration,
    libraryStaticMember,
} from "./symbols.js";
import {
    unwrapExpression,
    isAsyncFunction,
    isGeneratorFunction,
    functionOfDeclaration,
} from "./syntax.js";
import type { Value } from "./types.js";
import type { DataType } from "./data-types.js";
import { undefinedOnly, holdsOnly, PRIMITIVE_KINDS } from "./type-facts.js";
import { undefinedValue } from "./values/model.js";
import type { ClassHierarchy } from "./class-members.js";

/** Existing library operations with an actual undefined completion. */
function undefinedLibraryCall(
    checker: ts.TypeChecker,
    node: ts.Expression,
): boolean {
    const expression = unwrapExpression(node);
    if (!ts.isCallExpression(expression)) return false;
    const callee = unwrapExpression(expression.expression);
    const signature = checker.getResolvedSignature(expression);
    const declaration = calledDeclaration(checker, expression);
    const global = libraryGlobal(checker, callee);
    const consoleMethod =
        libraryStaticMember(checker, callee)?.owner === "console";
    return (
        !!signature &&
        !!declaration &&
        (global !== undefined || consoleMethod) &&
        (ts.isFunctionDeclaration(declaration) ||
            ts.isMethodSignature(declaration)) &&
        declarationInDefaultLibrary(declaration) &&
        undefinedOnly(checker.getReturnTypeOfSignature(signature))
    );
}

/**
 * Whether a concrete non-generator body (an async one only when `awaited`)
 * completes only through values `completes` accepts: each returned
 * expression, or an arrow's expression body. Running off the end completes
 * with undefined.
 */
function everyCompletion(
    declaration: ts.SignatureDeclaration | ts.JSDocSignature | undefined,
    awaited: boolean,
    completes: (expression: ts.Expression) => boolean,
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
        isGeneratorFunction(declaration) ||
        (!awaited && isAsyncFunction(declaration))
    )
        return false;
    return ts.isBlock(declaration.body)
        ? !someAnalysisNode(
              declaration.body,
              (node) =>
                  ts.isReturnStatement(node) &&
                  !!node.expression &&
                  !completes(node.expression),
              { functions: "skip" },
          )
        : completes(declaration.body);
}

/** A void annotation alone does not constrain a JavaScript return value. */
export function hasUndefinedCompletion(
    checker: ts.TypeChecker,
    declaration: ts.SignatureDeclaration | ts.JSDocSignature | undefined,
    awaited = false,
): boolean {
    return everyCompletion(
        declaration,
        awaited,
        (expression) =>
            ts.isVoidExpression(unwrapExpression(expression)) ||
            undefinedLibraryCall(checker, expression) ||
            (checker.getTypeAtLocation(expression).flags &
                ts.TypeFlags.Undefined) !==
                0,
    );
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
    dataTypes: {
        resolveTypeParameter(type: ts.Type): ts.Type;
        classHierarchy: Pick<ClassHierarchy, "dispatchBodies">;
    };
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
        const declaration = calledDeclaration(context.checker, expression);
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
            const binding = declaredSymbol(
                context.checker,
                callee,
            )?.valueDeclaration;
            if (
                !binding ||
                !(
                    ts.isFunctionDeclaration(binding) ||
                    context.bindings.isImmutableVariable(binding)
                )
            )
                return false;
            // A name bound to a function literal calls that literal, whatever
            // signature its annotation declares (`const f: () => void = ...`).
            const literal = ts.isVariableDeclaration(binding)
                ? functionOfDeclaration(binding)
                : undefined;
            if (literal)
                return hasUndefinedCompletion(
                    context.checker,
                    literal,
                    awaited,
                );
        } else if (
            declaration &&
            ts.isMethodDeclaration(declaration) &&
            ts.isClassLike(declaration.parent)
        ) {
            // A class method call runs one of the bodies its dispatch reaches.
            const bodies =
                context.dataTypes.classHierarchy.dispatchBodies(declaration);
            return (
                !!bodies &&
                bodies.every((body) =>
                    hasUndefinedCompletion(context.checker, body, awaited),
                )
            );
        } else if (
            !ts.isArrowFunction(callee) &&
            !ts.isFunctionExpression(callee)
        )
            return false;
        return hasUndefinedCompletion(context.checker, declaration, awaited);
    };
    return visit(node);
}

/**
 * Whether reading `value` as `undefined` would guess. A void annotation
 * erases whatever the function returned, so a void result is `undefined`
 * only when its completion is proven so ({@link provenUndefinedValue});
 * `erasedVoidCompletion` marks an `undefined` converted without that proof.
 * `node` is the expression that produced `value`; without one, only the
 * mark counts.
 */
export function readsErasedVoid(
    context: UndefinedContext,
    value: Value,
    node: ts.Node | undefined,
): boolean {
    return (
        value.erasedVoidCompletion === true ||
        (node !== undefined &&
            value.kind === "void" &&
            !provenUndefinedValue(context, node))
    );
}

/**
 * The `undefined` a void result converts to where nothing reads it yet:
 * marked when its completion is not proven, so the read that comes refuses.
 */
export function undefinedFromVoid(
    context: UndefinedContext,
    node: ts.Node,
): Value {
    return {
        ...undefinedValue(),
        ...(provenUndefinedValue(context, node)
            ? {}
            : { erasedVoidCompletion: true as const }),
    };
}

/**
 * The `undefined` a void result reads as, its call run first; none when its
 * completion is not proven, it never completes normally, or it is a
 * coroutine's.
 */
export function provenVoidAsUndefined(
    context: UndefinedContext & { emitDiscardedValue(value: Value): void },
    value: Value,
    node: ts.Node,
): Value | undefined {
    if (
        value.kind !== "void" ||
        value.abruptCompletion ||
        value.coroutineResult ||
        readsErasedVoid(context, value, node)
    )
        return undefined;
    context.emitDiscardedValue(value);
    return undefinedValue();
}

/**
 * A member read's receiver: a void result runs, then reads as the
 * `undefined` it converts to, so a call, property or element read through
 * it takes the absent-receiver path. One only a void annotation types
 * refuses: the annotation erased whatever the function returned.
 */
export function voidReceiver(
    context: UndefinedContext & {
        emitDiscardedValue(value: Value): void;
        fail(node: ts.Node, message: string): never;
    },
    value: Value,
    node: ts.Expression,
): Value {
    if (value.kind !== "void") return value;
    if (!value.abruptCompletion && readsErasedVoid(context, value, node))
        context.fail(
            node,
            "A void receiver requires a proven undefined completion.",
        );
    context.emitDiscardedValue(value);
    return undefinedValue();
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
    return everyCompletion(declaration, false, (expression) => {
        if (
            ts.isVoidExpression(unwrapExpression(expression)) ||
            undefinedLibraryCall(checker, expression)
        )
            return true;
        // A void result may be any value, a thenable included.
        return holdsOnly(
            checker.getTypeAtLocation(expression),
            PRIMITIVE_KINDS,
        );
    });
}

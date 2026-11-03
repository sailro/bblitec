import ts from "typescript";
import { someAnalysisNode } from "./analysis-walk.js";
import {
    declarationInDefaultLibrary,
    declaredSymbol,
    libraryGlobal,
    calledDeclaration,
    libraryStaticMember,
    namedMember,
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
import { ownKeysKnown, undefinedValue } from "./values/model.js";
import type { ClassHierarchy } from "./class-members.js";
import { engineBodies, isEngineDeclaration } from "./engine-bodies.js";

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

/**
 * Whether a concrete body completes only with `undefined`, each returned
 * expression (or an arrow's expression body) proven by following immutable
 * results ({@link provenUndefinedValue}, whose options it passes on).
 */
export function hasProvenUndefinedCompletion(
    context: UndefinedContext,
    declaration: ts.SignatureDeclaration | undefined,
    options: ProvenUndefinedOptions = {},
): boolean {
    return everyCompletion(
        declaration,
        options.awaited ?? false,
        (expression) => provenUndefinedValue(context, expression, options),
    );
}

interface ProvenUndefinedOptions {
    /** The value is awaited: a settled promise of `undefined` counts. */
    readonly awaited?: boolean;
    /**
     * Hears each struct function field a completion calls through whose
     * storage does not yet require the proof.
     */
    readonly unproven?: (field: DataType<"function">) => void;
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
        recordPropertiesAreCurrent(value: Value): boolean;
    };
    sharedClosures: { identifierIsRebound(identifier: ts.Identifier): boolean };
    dataTypes: {
        resolveTypeParameter(type: ts.Type): ts.Type;
        classHierarchy: Pick<ClassHierarchy, "dispatchBodies">;
        ownKeysDecided(name: string, node: ts.Node): boolean;
        structFields(
            name: string,
            node: ts.Node,
            accessors?: "accessors",
        ): readonly { readonly sourceName: string; readonly type: DataType }[];
    };
}

/** Follow immutable results to a concrete completion, never an erased void type. */
function provenUndefinedValue(
    context: UndefinedContext,
    node: ts.Node,
    { awaited: awaitedNode = false, unproven }: ProvenUndefinedOptions = {},
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
        const accessed = namedMember(context.checker, callee);
        const declaration = calledDeclaration(context.checker, expression);
        if (undefinedLibraryCall(context.checker, expression)) return true;
        // A Babylon Lite function runs its pinned body, proven as a source
        // function's is: its typing's `void` proves nothing.
        const pinned =
            declaration && isEngineDeclaration(declaration)
                ? engineBodies().bodies(declaration)
                : undefined;
        if (pinned)
            return pinned.every((body) =>
                hasUndefinedCompletion(
                    engineBodies().checkerFor(body),
                    body,
                    awaited,
                ),
            );
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
        } else if (accessed && ts.isIdentifier(accessed.expression)) {
            // A member of a record known at generation calls the function it
            // holds; an absent one called optionally yields `undefined`.
            const receiver = accessed.expression;
            const name = accessed.name;
            const owner = context.bindings.lookupOptional(receiver);
            // A struct's function field stores only functions proven to
            // complete as its type requires.
            if (owner?.kind === "data" && owner.dataType?.kind === "struct") {
                const field = context.dataTypes
                    .structFields(owner.dataType.name, callee, "accessors")
                    .find((candidate) => candidate.sourceName === name)?.type;
                if (field?.kind !== "function") return false;
                if (
                    field.undefinedCompletion === true ||
                    (awaited && field.awaitedUndefinedCompletion === true)
                )
                    return true;
                unproven?.(field);
                return false;
            }
            if (
                owner?.kind !== "record" ||
                !owner.recordProperties ||
                !context.bindings.recordPropertiesAreCurrent(owner) ||
                context.sharedClosures.identifierIsRebound(receiver)
            )
                return false;
            const member = owner.recordProperties[name];
            const method = owner.recordMethods?.[name];
            // A method the record was written with runs its own body, or
            // the function literal the immutable name it holds is bound to.
            if (member === undefined && method) {
                const named = ts.isIdentifier(method)
                    ? declaredSymbol(context.checker, method)?.valueDeclaration
                    : method;
                const body =
                    named &&
                    ts.isVariableDeclaration(named) &&
                    context.bindings.isImmutableVariable(named)
                        ? functionOfDeclaration(named)
                        : named;
                return (
                    !!body &&
                    ts.isFunctionLike(body) &&
                    hasUndefinedCompletion(context.checker, body, awaited)
                );
            }
            if (member === undefined)
                return (
                    expression.questionDotToken !== undefined &&
                    owner.recordGetters?.[name] === undefined &&
                    ownKeysKnown(context, owner, callee)
                );
            return hasUndefinedCallbackCompletion(
                context.checker,
                member,
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
    return visit(node, awaitedNode);
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

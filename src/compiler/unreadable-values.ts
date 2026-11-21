// Reads of a part of plain data generation cannot read (`unreadableValue`).
//
// Such a part passes on with the data holding it: a binding, a return, an
// argument of a program function, an object or array literal and a spread
// of what holds it keep it whole. A use that asks what any array answers
// (`typeof`, truthiness, presence) folds. Every other use reads it, and
// refuses there with the part's refusal: a member, element or method read,
// iteration, a library or pinned call it is handed to, a comparison of its
// identity, a conversion, and a write of it into storage.
import ts from "typescript";
import { CompileError } from "./compile-error.js";
import { calledOrigin, nullishComparison } from "./symbols.js";
import { valueConsumer, valueUse, wrappedParent } from "./syntax.js";
import type { Value } from "./types.js";
import { heldUnreadableRefusal, unreadableRefusal } from "./values/model.js";

interface UnreadableContext {
    readonly checker: ts.TypeChecker;
    fail(
        node: ts.Node,
        message: string,
        reason?: CompileError["reason"],
    ): never;
}

/**
 * Whether the use an expression's value goes to reads it, rather than
 * passing it on or asking what any array answers.
 */
function readsValue(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): boolean {
    // A node generation built reads what it compiles.
    if (expression.parent === undefined) return true;
    const use = valueUse(expression);
    // A pinned call reads the plain data a literal hands it.
    if (use.held)
        return (
            use.kind === "argument" &&
            calledOrigin(checker, use.call) === "babylon"
        );
    switch (use.kind) {
        case "discarded":
        case "returned":
        case "bound":
            return false;
        case "argument":
            return calledOrigin(checker, use.call) !== "program";
        case "read": {
            const consumer = valueConsumer(use.at);
            if (consumer.kind === "operand") return false;
            if (consumer.kind === "compared")
                return (
                    nullishComparison(checker, consumer.comparison) ===
                    undefined
                );
            if (consumer.kind !== "tested") return true;
            const parent = wrappedParent(use.at);
            return (
                ts.isPrefixUnaryExpression(parent) &&
                parent.operator !== ts.SyntaxKind.ExclamationToken
            );
        }
        default:
            return true;
    }
}

/** Refuses where `expression` yields an unreadable value its use reads. */
export function refuseUnreadableRead(
    context: UnreadableContext,
    value: Value,
    expression: ts.Expression,
): void {
    const refusal = unreadableRefusal(value);
    if (refusal !== undefined && readsValue(context.checker, expression))
        context.fail(expression, refusal, "unreadable-value");
}

/** Refuses where a reader takes an unreadable value (a sink storing it). */
export function refuseUnreadable(
    context: Pick<UnreadableContext, "fail">,
    value: Value,
    node: ts.Node,
): void {
    const refusal = unreadableRefusal(value);
    if (refusal !== undefined) context.fail(node, refusal, "unreadable-value");
}

/** Refuses where a value a reader takes whole holds an unreadable part. */
export function refuseUnreadablePart(
    context: Pick<UnreadableContext, "fail">,
    value: Value,
    node: ts.Node,
): void {
    const refusal = heldUnreadableRefusal(value);
    if (refusal !== undefined) context.fail(node, refusal, "unreadable-value");
}

/** `attempt`'s result, or nothing where it reads an unreadable part (other errors propagate). */
export function unlessUnreadable<T>(attempt: () => T): T | undefined {
    try {
        return attempt();
    } catch (error) {
        if (
            error instanceof CompileError &&
            error.reason === "unreadable-value"
        )
            return undefined;
        throw error;
    }
}

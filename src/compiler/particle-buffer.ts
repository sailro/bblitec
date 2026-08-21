/**
 * A particle buffer is generation-time state, and the two shapes a scene
 * writes about it move to the bake driver rather than emitting anything.
 *
 * The simulation runs at generation, so `buffer.alive` and every column
 * exist only there: a scene that checks the live count is asserting about
 * the bake, and one that writes a column is editing the state the bake
 * hands on. Both are recorded as steps, in the order the scene wrote them,
 * because a write before the last `animateParticleSystem` means something
 * different from one after it.
 */
import ts from "typescript";
import {
    staticNumberValue,
    type PositiveIntegerContext,
} from "./option-helpers.js";
import type { CompiledNodeParticles } from "./types.js";

export interface ParticleBufferContext extends PositiveIntegerContext {
    readonly reachedNodeParticles: CompiledNodeParticles;
    unwrap(expression: ts.Expression): ts.Expression;
}

/** The system a `<local>.buffer` path names, or undefined. */
function bufferOwner(
    context: ParticleBufferContext,
    expression: ts.Expression,
): { set: number; system: number } | undefined {
    const unwrapped = context.unwrap(expression);
    if (
        !ts.isPropertyAccessExpression(unwrapped) ||
        unwrapped.name.text !== "buffer" ||
        !ts.isIdentifier(unwrapped.expression)
    ) {
        return undefined;
    }
    const owner = context.lookupOptional(unwrapped.expression);
    if (
        owner?.kind !== "node-particle-system" ||
        owner.nodeParticleSetIndex === undefined ||
        owner.nodeParticleSystemIndex === undefined
    ) {
        return undefined;
    }
    return {
        set: owner.nodeParticleSetIndex,
        system: owner.nodeParticleSystemIndex,
    };
}

/**
 * `system.buffer.<column>[<index>] = <number>`, recorded as a bake step.
 * Returns false when the assignment is not one, so the ordinary paths keep
 * their own diagnostics.
 */
export function emitParticleBufferWrite(
    context: ParticleBufferContext,
    expression: ts.BinaryExpression,
): boolean {
    const left = context.unwrap(expression.left);
    if (!ts.isElementAccessExpression(left)) return false;
    const column = context.unwrap(left.expression);
    if (!ts.isPropertyAccessExpression(column)) return false;
    const owner = bufferOwner(context, column.expression);
    if (!owner) return false;
    if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
        context.fail(
            expression.operatorToken,
            "A particle column takes a plain assignment.",
        );
    }
    const index = staticNumberValue(context, left.argumentExpression);
    const value = staticNumberValue(context, expression.right);
    if (
        index === undefined ||
        !Number.isInteger(index) ||
        index < 0
    ) {
        context.fail(
            left.argumentExpression,
            "A particle column is written at a static slot: the write " +
                "happens while the simulation is still running.",
        );
    }
    if (value === undefined) {
        context.fail(
            expression.right,
            "A particle column takes a static number: the simulation runs " +
                "at generation.",
        );
    }
    context.reachedNodeParticles.steps.push({
        op: "buffer-write",
        set: owner.set,
        system: owner.system,
        column: column.name.text,
        index,
        value,
    });
    return true;
}

/**
 * `if (system.buffer.alive <op> <n>) { throw new Error("...") }`, the
 * fixture guard both pure-2D corpus scenes write about their own frozen
 * state. It travels as the comparison it is, and the driver raises the
 * count it actually produced, so a bake that disagrees with the scene's
 * own expectation fails generation instead of rendering something else.
 */
export function emitParticleAliveGuard(
    context: ParticleBufferContext,
    statement: ts.IfStatement,
): boolean {
    const condition = context.unwrap(statement.expression);
    if (!ts.isBinaryExpression(condition)) return false;
    const left = context.unwrap(condition.left);
    if (
        !ts.isPropertyAccessExpression(left) ||
        left.name.text !== "alive"
    ) {
        return false;
    }
    const owner = bufferOwner(context, left.expression);
    if (!owner) return false;
    const operator =
        condition.operatorToken.kind ===
        ts.SyntaxKind.EqualsEqualsEqualsToken
            ? "==="
            : condition.operatorToken.kind ===
                ts.SyntaxKind.ExclamationEqualsEqualsToken
              ? "!=="
              : undefined;
    if (!operator) {
        context.fail(
            condition.operatorToken,
            "A particle buffer's live count is compared with === or !==.",
        );
    }
    const value = staticNumberValue(context, condition.right);
    if (value === undefined) {
        context.fail(
            condition.right,
            "A particle buffer's live count is compared against a static " +
                "number.",
        );
    }
    if (!guardThrows(context, statement)) {
        context.fail(
            statement,
            "A particle buffer's live count is checked by a guard that " +
                "throws; nothing else about it reaches native code.",
        );
    }
    if (statement.elseStatement) {
        context.fail(
            statement.elseStatement,
            "A particle live-count guard carries no else branch.",
        );
    }
    context.reachedNodeParticles.steps.push({
        op: "expect-alive",
        set: owner.set,
        system: owner.system,
        operator,
        value,
    });
    return true;
}

/**
 * Whether a guard body is a single throw of a new Error.
 *
 * The message itself does not travel: the corpus writes it as a template
 * over the very count the guard rejects, and the driver knows that count
 * exactly, so it reports the real one rather than replaying the scene's
 * text with an interpolation this compiler would have to evaluate.
 */
function guardThrows(
    context: ParticleBufferContext,
    statement: ts.IfStatement,
): boolean {
    const body = statement.thenStatement;
    const only = ts.isBlock(body)
        ? body.statements.length === 1
            ? body.statements[0]
            : undefined
        : body;
    if (!only || !ts.isThrowStatement(only) || !only.expression) {
        return false;
    }
    const thrown = context.unwrap(only.expression);
    return (
        ts.isNewExpression(thrown) &&
        ts.isIdentifier(thrown.expression) &&
        thrown.expression.text === "Error"
    );
}

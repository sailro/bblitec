/**
 * Particle simulation and initialization writes execute in the ordered bake.
 * Buffer and column aliases retain the originating system identity. Native
 * reads expose its final snapshot, including Float64 ages and inactive slots;
 * writes after that boundary refuse instead of silently moving an earlier read.
 */
import ts from "typescript";
import {
    staticNumberValue,
    type PositiveIntegerContext,
} from "./option-helpers.js";
import type { CompiledNodeParticles, Value } from "./types.js";
import {
    nodeParticleColumnWidths,
    type NodeParticleColumn,
    type NodeParticleFrozenBufferRequest,
} from "../pinned-node-particle.js";

interface ParticleBufferContext extends PositiveIntegerContext {
    readonly reachedNodeParticles: CompiledNodeParticles;
    unwrap(expression: ts.Expression): ts.Expression;
    isDefaultLibraryIdentifier(identifier: ts.Identifier): boolean;
    isRuntimeResourceConstruction(): boolean;
}

type BufferIdentity = { set: number; system: number };

export function frozenParticleBuffer(
    context: Pick<ParticleBufferContext, "reachedNodeParticles" | "fail">,
    owner: BufferIdentity,
    node: ts.Node,
): NodeParticleFrozenBufferRequest {
    if (context.reachedNodeParticles.steps.some((step) => step.op === "push-system" &&
        (step.set === owner.set || step.fromSet === owner.set))) {
        context.fail(node, "Native frozen particle buffer reads and sprite sheets cannot be combined with system-list composition; pushed systems share their original buffer identity.");
    }
    const previous = context.reachedNodeParticles.buffers.find(
        (entry) => entry.set === owner.set && entry.system === owner.system,
    );
    if (previous) return previous;
    const request: NodeParticleFrozenBufferRequest = { ...owner, columns: [] };
    context.reachedNodeParticles.buffers.push(request);
    return request;
}

/** A native read exposes the final snapshot; later simulation cannot move it. */
export function requireParticleBakeWritable(
    context: Pick<ParticleBufferContext, "reachedNodeParticles" | "fail" | "isRuntimeResourceConstruction">,
    owner: BufferIdentity,
    node: ts.Node,
): void {
    const program = context.reachedNodeParticles;
    if (program.sets[owner.set]?.native) {
        context.fail(node, "Native provider-backed particle buffers cannot be written through a generation snapshot.");
    }
    if (context.isRuntimeResourceConstruction() ||
        program.buffers.some((entry) => entry.set === owner.set &&
            entry.system === owner.system && entry.observed) ||
        program.billboards.some((entry) => entry.set === owner.set && entry.system === owner.system) ||
        program.registrations.some((entry) => entry.set === owner.set) ||
        program.sprite2d.some((entry) => entry.set === owner.set)) {
        context.fail(node, "A frozen particle buffer can only change during definite initialization, before a native snapshot read or renderer registration.");
    }
}

function identity(value: Value | undefined): BufferIdentity | undefined {
    return value && !value.nodeParticleLive &&
        value.nodeParticleSetIndex !== undefined &&
        value.nodeParticleSystemIndex !== undefined
        ? { set: value.nodeParticleSetIndex, system: value.nodeParticleSystemIndex }
        : undefined;
}

export function readFrozenParticleProperty(
    context: Pick<ParticleBufferContext, "reachedNodeParticles" | "fail">,
    owner: Value,
    name: string,
    node: ts.Node,
): Value | undefined {
    const buffer = identity(owner);
    if (!buffer) return undefined;
    if (owner.kind === "node-particle-system" && name === "buffer") {
        return { ...owner, kind: "node-particle-buffer" };
    }
    if (owner.kind !== "node-particle-buffer" && owner.kind !== "node-particle-column") return undefined;
    if (context.reachedNodeParticles.sets[buffer.set]?.native) {
        if (owner.kind === "node-particle-buffer" && (name === "alive" || name === "capacity")) {
            return { kind: "number", cpp: `bbl::upstream::native_node_particle_${name}(${buffer.set}, ${buffer.system})`, dataType: { kind: "number" } };
        }
        context.fail(node, `Native provider-backed particle buffer property '${name}' is not lowered.`);
    }
    if (owner.kind === "node-particle-buffer" && Object.hasOwn(nodeParticleColumnWidths, name)) {
        return { ...owner, kind: "node-particle-column", nodeParticleColumn: name as NodeParticleColumn };
    }
    if ((owner.kind === "node-particle-buffer" && (name === "alive" || name === "capacity")) ||
        (owner.kind === "node-particle-column" && name === "length")) {
        const request = frozenParticleBuffer(context, buffer, node);
        const field = name === "alive" ? "alive" : "capacity";
        if (field === "alive") request.observed = true;
        return {
            kind: "number",
            cpp: `bbl::upstream::node_particle_frozen_${field}(${buffer.set}, ${buffer.system})`,
            dataType: { kind: "number" },
        };
    }
    context.fail(node, `Frozen particle ${owner.kind === "node-particle-buffer" ? "buffer" : "column"} property '${name}' is not lowered.`);
}

export function readFrozenParticleElement(
    context: Pick<ParticleBufferContext, "reachedNodeParticles" | "fail">,
    owner: Value,
    indexCpp: string,
    node: ts.Node,
): Value {
    const buffer = identity(owner)!;
    const request = frozenParticleBuffer(context, buffer, node);
    const column = owner.nodeParticleColumn!;
    if (!request.columns.includes(column)) request.columns.push(column);
    request.observed = true;
    return {
        kind: "data",
        cpp: `bbl::upstream::node_particle_frozen_column(${buffer.set}, ${buffer.system}, "${column}", ${indexCpp})`,
        dataType: { kind: "optional", inner: { kind: "number" } },
    };
}

/** The system a `<local>.buffer` path names, or undefined. */
function bufferOwner(
    context: ParticleBufferContext,
    expression: ts.Expression,
): BufferIdentity | undefined {
    const unwrapped = context.unwrap(expression);
    if (ts.isIdentifier(unwrapped)) {
        const value = context.lookupOptional(unwrapped);
        return value?.kind === "node-particle-buffer" ? identity(value) : undefined;
    }
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
    return identity(owner);
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
    const alias = ts.isIdentifier(column) ? context.lookupOptional(column) : undefined;
    const owner = alias?.kind === "node-particle-column"
        ? identity(alias)
        : ts.isPropertyAccessExpression(column) ? bufferOwner(context, column.expression) : undefined;
    if (!owner) return false;
    const name = alias?.nodeParticleColumn ?? (column as ts.PropertyAccessExpression).name.text;
    if (!Object.hasOwn(nodeParticleColumnWidths, name)) {
        context.fail(column, `Particle buffer column '${name}' is not lowered.`);
    }
    requireParticleBakeWritable(context, owner, expression);
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
        column: name,
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
    if (context.reachedNodeParticles.sets[owner.set]?.native) return false;
    if (context.isRuntimeResourceConstruction() ||
        context.reachedNodeParticles.sprite2d.some((entry) => entry.set === owner.set) ||
        context.reachedNodeParticles.buffers.some((entry) => entry.set === owner.set &&
            entry.system === owner.system && entry.observed)) return false;
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
        thrown.expression.text === "Error" &&
        context.isDefaultLibraryIdentifier(thrown.expression)
    );
}

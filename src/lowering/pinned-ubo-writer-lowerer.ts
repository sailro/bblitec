/**
 * Lowers Babylon Lite's own material-UBO writers to C++.
 *
 * Each PBR extension fills its own fields through a `writeUbo` hook, and those
 * hooks compute: the clearcoat's `Math.pow(-a / b, 2)` and `1 / ior`, the
 * volume's `Math.log(Math.max(tint, 1e-6)) / distance`, the UV transform's
 * `cos`/`sin` pair with its sign flips. Restating any of that here would be a
 * second copy that agrees with the pin only until the pin changes, so the
 * arithmetic comes from the pinned declaration's own AST — the shape
 * `light-lowerer.ts#lowerMatrix` uses for `localMatrixFromDirection`.
 *
 * This module owns the translation, never the formula: `data[off + n]` becomes
 * the field the composer placed at that offset, `x ?? default` becomes the
 * record field (which always carries a value natively), and `Math.*` becomes
 * `std::*`. Anything else in the pinned body fails generation, which is what
 * keeps a changed writer visible instead of silently stale. The discarded
 * `?? default` is not thrown away blind: it is folded and asserted against
 * `pinned-material-defaults.ts`, the table the intrinsics seed the record
 * from, so a pin that moves a default fails generation by name.
 */
import ts from "typescript";
import type { LoweringContext } from "./context.js";
import {
    pinnedDefaultForDiscard,
    type PinnedMaterialDefault,
} from "./pinned-material-defaults.js";
import {
    PINNED_BOOLEAN_OPERATORS,
    PINNED_MATH_FUNCTIONS,
} from "./pinned-operators.js";

export interface UboFieldSlot {
    /** The composer's field name. */
    name: string;
    /** Byte offset, as the pin's `_offsets` publishes it. */
    offset: number;
    /** Float lanes the field occupies: 1 for f32, 3 or 4 for a vector. */
    lanes: number;
}

export interface UboWriterRequest {
    modulePath: string;
    symbolName: string;
    /** The pinned local the writer reads values from, e.g. `cc`. */
    sourceLocal: string;
    /**
     * How that local's properties map onto our own record.
     *
     * `null` marks a property our records genuinely do not carry. The pin
     * guards every optional property with `?? <default>`, so an absent one
     * lowers to that default — the pin's value, not one invented here. A
     * property that is neither mapped nor marked absent fails.
     */
    propertySources: Readonly<Record<string, string | null>>;
    /** The field the writer's `offsets.get(...)` names. */
    baseField: string;
    /**
     * The parameter carrying the base offset, where the pin passes it in rather
     * than looking it up. The light writers take `(data, offset)` and index from
     * there, so that parameter names the base field the same way an
     * `offsets.get` local would.
     */
    offsetParameter?: string;
    /** Every field of the variant, so `off + n` resolves to a name. */
    slots: readonly UboFieldSlot[];
    /**
     * Properties the pin binds to a local and then indexes — a colour read as
     * `color[0]`. Lowered as a reference to our record's own colour, with the
     * lane resolved to its member, rather than as a float.
     */
    vectorProperties?: Readonly<Record<string, number>>;
    /**
     * Per-lane sources for a property our records do not store whole.
     *
     * The light writers read `light.worldMatrix` and take specific lanes from
     * it; the record keeps the values those lanes carry — position and
     * direction — rather than the matrix, so each lane names its own source.
     */
    laneSources?: Readonly<Record<string, Readonly<Record<number, string>>>>;
    /**
     * Sibling writers this one calls, keyed by symbol name. Each pinned ext
     * writer ends by delegating its texture transforms to a shared helper
     * (`writeUvTransform(data, offsets, "iridescenceUV", iri.texture)`), whose
     * base fields are `<name>m` / `<name>t`. The helper's own guard returns when
     * the variant declares neither, so a variant without the transform lowers
     * to nothing here — the same outcome, reached the same way.
     */
    nestedWriters?: Readonly<
        Record<
            string,
            (baseName: string) => Readonly<Record<string, string | null>>
        >
    >;
    /**
     * Module-level installed hooks this port leaves uninstalled.
     *
     * The Standard UV writer reads `_uvOffsetResolver?.(material) ?? null`,
     * where the resolver only exists after `enableStandardUvOffset()` — which
     * no reached scene calls. The pin's own evaluation of the uninstalled
     * state is `null`, so a local bound to such a call is null at generation
     * and every read through it folds to its `?? default` arm — the pin's
     * value, decided the way the pin decides it.
     */
    absentHooks?: readonly string[];
}

interface WriterState {
    file: ts.SourceFile;
    request: UboWriterRequest;
    baseLane: number;
    /**
     * Offset locals the pin binds, by the field each names. A writer can fill
     * more than one base field — the refraction writer fills `refractionParams`,
     * `volumeParams` and `thicknessParams` from three separate lookups — so the
     * lane a `data[x + n]` write lands in depends on which local `x` is.
     */
    offsetLocals: Map<string, string>;
    /**
     * A nested helper's parameters bound to the field names its caller passed,
     * for a helper keyed on a plain parameter rather than a literal or template.
     */
    parameterFields?: Readonly<Record<string, string>>;
    locals: Set<string>;
    /**
     * Locals bound to null at generation: an uninstalled hook's `?.()` result.
     * Reads through them fold to their `?? default` arms.
     */
    nullLocals: Set<string>;
    /**
     * Locals the pinned body reassigns. They lower as mutable floats where
     * everything else stays `const` — and because an assignment to a local
     * used to fail generation outright, every writer lowered before this
     * construct existed has none, which keeps their emitted text identical.
     */
    mutatedLocals: ReadonlySet<string>;
    /**
     * Locals bound to a vector rather than a scalar, and how to index them: a
     * record colour by member (`.r`), the pin's own array default by lane.
     */
    vectorLocals: Map<string, { lanes: number; kind: "colour" | "array" }>;
    /** The property a vector local was bound from, for lane resolution. */
    vectorLocalOrigins: Map<string, string>;
    /** Resolves a lane of a vector local through the request's laneSources. */
    laneSourceFor(local: string, lane: number): string | undefined;
    /** The sibling helper declarations, resolved once by the entry point. */
    nestedDeclarations: Record<
        string,
        { declaration: ts.FunctionLikeDeclarationBase & { body: ts.Block } }
    >;
}

/** The float-lane index a field starts at. */
function fieldLane(request: UboWriterRequest, name: string): number {
    const slot = request.slots.find((entry) => entry.name === name);
    if (!slot) {
        throw new Error(
            `Pinned writer names field '${name}', which this variant does not ` +
                "declare.",
        );
    }
    return slot.offset / 4;
}

/** The field and lane a `data[...]` write lands in. */
function slotAtLane(
    request: UboWriterRequest,
    lane: number,
): { field: string; lane: number; lanes: number } {
    for (const slot of request.slots) {
        const start = slot.offset / 4;
        if (lane >= start && lane < start + slot.lanes) {
            return { field: slot.name, lane: lane - start, lanes: slot.lanes };
        }
    }
    throw new Error(
        `Pinned writer writes lane ${lane}, which no declared field covers.`,
    );
}

function isOffsetsLookup(expression: ts.Expression): boolean {
    return /offsets\s*\.\s*get\s*\(/.test(expression.getText());
}

/** The field name inside an `offsets.get("x")` lookup. */
function offsetsLookupField(expression: ts.Expression): string | undefined {
    const match = /offsets\s*\.\s*get\s*\(\s*["']([^"']+)["']/.exec(
        expression.getText(),
    );
    return match?.[1];
}

/**
 * The field an `offsets.get(param)` names, for a helper whose key is a plain
 * parameter rather than a literal or a template.
 *
 * `writeSheenUvTransform(data, offsets, mName, tName, tex)` is this shape: the
 * caller passes the field names themselves, so the parameter binding recorded at
 * the call site is what says which field each local indexes. Without it the
 * locals never register and the helper's writes resolve against nothing.
 */
function parameterOffsetField(
    state: WriterState,
    expression: ts.Expression,
): string | undefined {
    const match = /offsets\s*\.\s*get\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(
        expression.getText(state.file),
    );
    if (!match) return undefined;
    return state.parameterFields?.[match[1]!];
}

/**
 * The field a templated `offsets.get(`${x}...m`)` names, resolved against the
 * base field the caller passed for this helper.
 */
function templateOffsetField(
    state: WriterState,
    expression: ts.Expression,
): string | undefined {
    const match = /offsets\s*\.\s*get\s*\(\s*`\$\{\w+\}\w*([mt])`/.exec(
        expression.getText(),
    );
    if (!match) return undefined;
    const base = state.request.baseField;
    return match[1] === "m" ? base : base.replace(/m$/, "t");
}

/** The absolute float lane a `data[...]` index refers to. */
function dataLane(state: WriterState, expression: ts.Expression): number {
    const base = (local: ts.Expression): number => {
        if (!ts.isIdentifier(local)) {
            throw new Error(
                `Unsupported data index in pinned ` +
                    `${state.request.symbolName}: ` +
                    `${expression.getText(state.file)}.`,
            );
        }
        const field = state.offsetLocals.get(local.text);
        if (field === undefined) return state.baseLane;
        return fieldLane(state.request, field);
    };
    if (ts.isNumericLiteral(expression)) {
        return Number.parseInt(expression.text, 10);
    }
    if (ts.isIdentifier(expression)) return base(expression);
    // `data[off / 4]`: the local holds the byte offset and the writer divides at
    // the index instead of at the binding. `offsetLocals` maps the local to its
    // field either way, so the division carries no information and is unwrapped.
    // The alpha-test extension is written this shape where the others bind the
    // lane directly.
    if (
        ts.isBinaryExpression(expression) &&
        expression.operatorToken.kind === ts.SyntaxKind.SlashToken &&
        ts.isNumericLiteral(expression.right) &&
        expression.right.text === "4"
    ) {
        return dataLane(state, expression.left);
    }
    if (ts.isParenthesizedExpression(expression)) {
        return dataLane(state, expression.expression);
    }
    if (
        ts.isBinaryExpression(expression) &&
        expression.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        ts.isNumericLiteral(expression.right)
    ) {
        return dataLane(state, expression.left) +
            Number.parseInt(expression.right.text, 10);
    }
    throw new Error(
        `Unsupported data index in pinned ${state.request.symbolName}: ` +
            `${expression.getText(state.file)}.`,
    );
}

/** The field a `x !== undefined` guard tests, if any. */
function guardedField(
    state: WriterState,
    condition: ts.Expression,
): string | undefined {
    return offsetLocalComparedToUndefined(state, condition, [
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
    ]);
}

/**
 * The offset field a `<local> <op> undefined` comparison names, for the
 * operators the caller accepts. `guardedField` reads the presence forms and
 * `absentOffsetGuardFields` the absence ones; the shape they test is the
 * same, so it is stated once.
 */
function offsetLocalComparedToUndefined(
    state: WriterState,
    condition: ts.Expression,
    operators: readonly ts.SyntaxKind[],
): string | undefined {
    if (!ts.isBinaryExpression(condition)) return undefined;
    if (!operators.includes(condition.operatorToken.kind)) return undefined;
    if (
        !ts.isIdentifier(condition.right) ||
        condition.right.text !== "undefined"
    ) {
        return undefined;
    }
    if (!ts.isIdentifier(condition.left)) return undefined;
    return state.offsetLocals.get(condition.left.text);
}

/** The field an `offsets.has("x")` guard tests. */
function guardedFieldByHas(condition: ts.Expression): string | undefined {
    const match = /offsets\s*\.\s*has\s*\(\s*["']([^"']+)["']/.exec(
        condition.getText(),
    );
    return match?.[1];
}

/**
 * Every local the pinned body reassigns (`scaleY = -scaleY`, `offsetY += x`).
 *
 * Collected up front so the declaration site knows whether to emit a mutable
 * float. Assignments to `data[...]` have an element-access target and never
 * land here.
 */
function collectMutatedLocals(body: ts.Node): Set<string> {
    const mutated = new Set<string>();
    const visit = (node: ts.Node): void => {
        if (
            ts.isBinaryExpression(node) &&
            ts.isIdentifier(node.left) &&
            (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
                node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ||
                node.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken ||
                node.operatorToken.kind ===
                    ts.SyntaxKind.AsteriskEqualsToken)
        ) {
            mutated.add(node.left.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(body);
    return mutated;
}

/**
 * Whether an initializer is an uninstalled hook's call — the pin's
 * `_uvOffsetResolver?.(material) ?? null` shape. The hook names come from the
 * request; the call's own result is the pin's uninstalled evaluation, null.
 */
function initializerIsAbsentHookCall(
    state: WriterState,
    expression: ts.Expression,
): boolean {
    let node = expression;
    // `hook?.(x) ?? null` — the fallback is itself null, so either side of the
    // `??` leaves the local null.
    if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
        (node.right.kind === ts.SyntaxKind.NullKeyword ||
            (ts.isIdentifier(node.right) &&
                node.right.text === "undefined"))
    ) {
        node = node.left;
    }
    return (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        (state.request.absentHooks ?? []).includes(node.expression.text)
    );
}

/** Whether an expression reads through a local that is null at generation. */
function readsNullLocal(
    state: WriterState,
    expression: ts.Expression,
): boolean {
    let node = expression;
    if (ts.isNonNullExpression(node)) node = node.expression;
    while (
        ts.isPropertyAccessExpression(node) ||
        ts.isPropertyAccessChain(node) ||
        ts.isElementAccessExpression(node) ||
        ts.isElementAccessChain(node)
    ) {
        node = node.expression;
    }
    return ts.isIdentifier(node) && state.nullLocals.has(node.text);
}

/** The lane count if this initializer reads a colour property. */
function vectorPropertyLanes(
    state: WriterState,
    expression: ts.Expression,
): number | undefined {
    let node = expression;
    while (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
        node = node.left;
    }
    if (ts.isNonNullExpression(node)) node = node.expression;
    if (!ts.isPropertyAccessExpression(node)) return undefined;
    return state.request.vectorProperties?.[node.name.getText()];
}

/** Whether a read names a property our records do not carry. */
function readsAbsentProperty(
    state: WriterState,
    expression: ts.Expression,
): boolean {
    let node = expression;
    if (ts.isNonNullExpression(node)) node = node.expression;
    if (
        !ts.isPropertyAccessExpression(node) &&
        !ts.isPropertyAccessChain(node)
    ) {
        return false;
    }
    const property = node.name.getText();
    return state.request.propertySources[property] === null;
}

/**
 * The lane count when the pin's `?? [..]` default is what a local binds to,
 * because our records do not carry the property it guards.
 */
function vectorDefaultLanes(
    state: WriterState,
    expression: ts.Expression,
): number | undefined {
    if (
        !ts.isBinaryExpression(expression) ||
        expression.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
        !ts.isArrayLiteralExpression(expression.right) ||
        !readsAbsentProperty(state, expression.left)
    ) {
        return undefined;
    }
    return expression.right.elements.length;
}

/**
 * How a comparison against a property our records do not carry evaluates.
 *
 * The pin guards some optional properties with a strict comparison rather than
 * `??`. An absent one is `undefined`, so `=== anything` is false and
 * `!== anything` is true; returning that lets the conditional fold at
 * generation to the arm the pin would have taken.
 */
function absentComparisonResult(
    state: WriterState,
    condition: ts.Expression,
): boolean | undefined {
    if (!ts.isBinaryExpression(condition)) return undefined;
    const equals = condition.operatorToken.kind ===
            ts.SyntaxKind.EqualsEqualsEqualsToken ||
        condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken;
    const notEquals = condition.operatorToken.kind ===
            ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        condition.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken;
    if (!equals && !notEquals) return undefined;
    if (!readsAbsentProperty(state, condition.left)) return undefined;
    return notEquals;
}

/**
 * Whether an initializer names the record itself rather than one of its values.
 *
 * A pinned writer walks down through sub-objects (`mat._subsurface`, then
 * `ss.refraction`); those all correspond to the one flat record here, so the
 * bindings are aliases and only the leaf reads carry data.
 */
function aliasesRecord(
    state: WriterState,
    expression: ts.Expression,
): boolean {
    let node = expression;
    while (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
        node = node.left;
    }
    if (ts.isNonNullExpression(node)) node = node.expression;
    if (
        !ts.isPropertyAccessExpression(node) &&
        !ts.isPropertyAccessChain(node)
    ) {
        return false;
    }
    const source = state.request.propertySources[node.name.getText()];
    return typeof source === "string" && !source.includes(".");
}

/** The property name a vector local was bound from. */
function vectorOriginProperty(
    expression: ts.Expression,
): string | undefined {
    let node = expression;
    while (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
        node = node.left;
    }
    if (ts.isNonNullExpression(node)) node = node.expression;
    return ts.isPropertyAccessExpression(node) ||
            ts.isPropertyAccessChain(node)
        ? node.name.getText()
        : undefined;
}

/**
 * The pin-side property a mapped `?? default` guards: the left-most read's
 * terminal name. A chained fallback (`a ?? b ?? c`) parses left-associated,
 * so descending the left spine lands on the property the whole chain guards.
 */
function discardedProperty(
    state: WriterState,
    expression: ts.Expression,
): string | undefined {
    let node = expression;
    while (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
        node = node.left;
    }
    if (ts.isNonNullExpression(node)) node = node.expression;
    if (
        ts.isPropertyAccessExpression(node) ||
        ts.isPropertyAccessChain(node)
    ) {
        return node.name.getText();
    }
    if (
        ts.isIdentifier(node) &&
        typeof state.request.propertySources[node.text] === "string"
    ) {
        return node.text;
    }
    return undefined;
}

/** A discarded pinned default, folded to what the pin would evaluate. */
type FoldedDefault =
    | { kind: "number"; value: number }
    | { kind: "vector"; value: number[] }
    /** The fallback reads another mapped record value — the same
     *  always-carried argument that lets the outer read discard it. */
    | { kind: "record" };

/**
 * Evaluates a discarded `?? default` right-hand side.
 *
 * The pin's defaults are numeric literals, small vectors of them, or — the
 * reflectance writer's `_specularWeight ?? _metallicF0Factor ?? 1.0` — a
 * chain over further record-carried properties; a chained fallback folds to
 * its all-absent ground state, which is the constant the chain terminates
 * in. Anything else returns undefined and fails at the assert.
 */
function foldDiscardedDefault(
    state: WriterState,
    expression: ts.Expression,
): FoldedDefault | undefined {
    let node = expression;
    if (ts.isParenthesizedExpression(node)) node = node.expression;
    if (ts.isNumericLiteral(node)) {
        return { kind: "number", value: Number(node.text) };
    }
    if (
        ts.isPrefixUnaryExpression(node) &&
        node.operator === ts.SyntaxKind.MinusToken
    ) {
        const operand = foldDiscardedDefault(state, node.operand);
        return operand?.kind === "number"
            ? { kind: "number", value: -operand.value }
            : undefined;
    }
    if (ts.isArrayLiteralExpression(node)) {
        const lanes: number[] = [];
        for (const element of node.elements) {
            const lane = foldDiscardedDefault(state, element);
            if (lane?.kind !== "number") return undefined;
            lanes.push(lane.value);
        }
        return { kind: "vector", value: lanes };
    }
    if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
        return foldDiscardedDefault(state, node.right);
    }
    // A fallback that is itself a MAPPED property read: `_specularWeight ??
    // _metallicF0Factor` discards a value the record carries either way. An
    // unmapped read stays unfoldable — the always-carried argument does not
    // hold for a property our records do not name.
    const property = discardedProperty(state, node);
    if (
        property !== undefined &&
        typeof state.request.propertySources[property] === "string"
    ) {
        return { kind: "record" };
    }
    return undefined;
}

/** Whether a folded default is a plain `?? 0`/`?? 1` (per lane). */
function isZeroOrOne(folded: FoldedDefault): boolean {
    if (folded.kind === "number") {
        return folded.value === 0 || folded.value === 1;
    }
    if (folded.kind === "vector") {
        return folded.value.every((lane) => lane === 0 || lane === 1);
    }
    return false;
}

function foldedText(folded: FoldedDefault | undefined): string {
    if (folded === undefined) return "<unfoldable>";
    if (folded.kind === "number") return String(folded.value);
    if (folded.kind === "vector") {
        return `[${folded.value.join(", ")}]`;
    }
    return "<another record property>";
}

function defaultText(value: PinnedMaterialDefault["value"]): string {
    return Array.isArray(value) ? `[${value.join(", ")}]` : String(value);
}

/** Whether the fold agrees with one of the entry's pinned values. */
function matchesEntry(
    entry: PinnedMaterialDefault,
    folded: FoldedDefault,
): boolean {
    const candidates = [entry.value, ...(entry.alsoPinned ?? [])];
    return candidates.some((candidate) => {
        if (folded.kind === "number") return candidate === folded.value;
        if (folded.kind === "vector") {
            return (
                Array.isArray(candidate) &&
                candidate.length === folded.value.length &&
                candidate.every(
                    (lane, index) => lane === folded.value[index],
                )
            );
        }
        return false;
    });
}

/**
 * The RD-4 guard: a mapped property's `?? default` lowers to the record
 * field alone, so the pin's fallback is discarded here — and the record's
 * seed (the intrinsics' defaults, the loader's) restates the same number
 * with nothing tying the copies together. Before discarding, the pin's own
 * default expression is evaluated and asserted against
 * `PINNED_MATERIAL_DEFAULTS`, the table the intrinsics read: a pin bump
 * that moves a default fails generation naming the property and both
 * values instead of silently splitting the reference from the record.
 *
 * Properties the table does not carry keep the silent discard only for the
 * plain `?? 0`/`?? 1` texture-transform and flag lanes with no
 * intrinsic-side twin; any other unlisted default demands a table entry.
 */
function assertDiscardedPinnedDefault(
    state: WriterState,
    node: ts.BinaryExpression,
): void {
    const folded = foldDiscardedDefault(state, node.right);
    if (folded?.kind === "record") return;
    const property = discardedProperty(state, node.left);
    const key = `${state.request.modulePath}#${state.request.symbolName}#${
        property ?? "<unnamed>"
    }`;
    const entry = pinnedDefaultForDiscard(key);
    if (entry === undefined) {
        if (folded !== undefined && isZeroOrOne(folded)) return;
        throw new Error(
            `Pinned ${state.request.symbolName} discards the default of ` +
                `'${property ?? node.left.getText(state.file)}' ` +
                `(${node.getText(state.file)}), which ` +
                "PINNED_MATERIAL_DEFAULTS does not anchor and which is " +
                "not a plain `?? 0`/`?? 1` fallback. Add the entry under " +
                `'${key}' in src/lowering/pinned-material-defaults.ts so ` +
                "the record seed and the pin cannot drift apart.",
        );
    }
    if (folded === undefined || !matchesEntry(entry, folded)) {
        throw new Error(
            `Pinned ${state.request.symbolName} defaults '${property}' to ` +
                `${foldedText(folded)}, but PINNED_MATERIAL_DEFAULTS ` +
                `carries ${defaultText(entry.value)} for '${key}'. The ` +
                "pin moved a discarded default; update the table (and the " +
                "record seed it feeds) rather than letting the reference " +
                "and the native record split.",
        );
    }
}

/** Colour members, in the order the pin indexes them. */
const colourMembers = ["r", "g", "b", "a"] as const;

/** Vec2 members, for the two-lane values the pin indexes the same way. */
const vec2Members = ["x", "y"] as const;

/**
 * The member a lane of a named vector reads. Our runtime carries a two-lane
 * value as a Vec2 and a wider one as a colour, so the lane count picks the
 * member set. Arrays and anything wider index by lane and never come here.
 */
function vectorMember(
    symbolName: string,
    owner: string,
    lanes: number,
    lane: number,
): string {
    const member = lanes === 2 ? vec2Members[lane] : colourMembers[lane];
    if (member === undefined) {
        throw new Error(
            `Pinned ${symbolName} reads lane ${lane} of '${owner}', which a ` +
                `${lanes}-lane value does not have.`,
        );
    }
    return member;
}

function emitExpression(state: WriterState, expression: ts.Expression): string {
    const node = expression;
    if (ts.isParenthesizedExpression(node)) {
        return `(${emitExpression(state, node.expression)})`;
    }
    if (ts.isNonNullExpression(node)) {
        return emitExpression(state, node.expression);
    }
    if (ts.isArrayLiteralExpression(node)) {
        return `{${
            node.elements
                .map((element) => emitExpression(state, element))
                .join(", ")
        }}`;
    }
    if (ts.isNumericLiteral(node)) {
        const text = node.text;
        return /[.e]/i.test(text) ? `${text}f` : `${text}.0f`;
    }
    if (
        ts.isPrefixUnaryExpression(node) &&
        node.operator === ts.SyntaxKind.MinusToken
    ) {
        return `-${emitExpression(state, node.operand)}`;
    }
    // `cc.intensity ?? 1` — the record always carries a value, so the fallback
    // the pin applies to an absent JavaScript property is unreachable and the
    // read lowers to the record field alone.
    if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
        // `offset?.[0] ?? 0` where `offset` is null at generation (an
        // uninstalled hook's result): the pin's own evaluation takes the
        // fallback, so the fallback is what lowers.
        if (readsNullLocal(state, node.left)) {
            return emitExpression(state, node.right);
        }
        if (readsAbsentProperty(state, node.left)) {
            return emitExpression(state, node.right);
        }
        // The discarded fallback is the pin's default for this property;
        // assert it against the one table the intrinsics seed the record
        // from before throwing it away.
        assertDiscardedPinnedDefault(state, node);
        return emitExpression(state, node.left);
    }
    if (ts.isBinaryExpression(node)) {
        // A writer's `||` is a boolean guard, so it lowers to C++'s own.
        const operator = PINNED_BOOLEAN_OPERATORS.get(
            node.operatorToken.kind,
        );
        if (!operator) {
            throw new Error(
                `Unsupported operator in pinned ${state.request.symbolName}: ` +
                    `${node.getText(state.file)}.`,
            );
        }
        return `${emitExpression(state, node.left)} ${operator} ` +
            `${emitExpression(state, node.right)}`;
    }
    // `sh.texture ? 1 : 0` and `mrc ? mrc[0] : 1`. The first is a real
    // presence test and lowers as one; the second guards a JavaScript property
    // that may be absent, which a native record never is, so the guard folds to
    // its present arm.
    if (ts.isConditionalExpression(node)) {
        // A comparison against an absent property folds the way JavaScript
        // evaluates it: `undefined === false` is false, so the pin's
        // `usePhysicalLightFalloff === false ? 0 : 1` yields its else arm. The
        // value is still the pin's, decided at generation rather than run time.
        const staticResult = absentComparisonResult(state, node.condition);
        if (staticResult !== undefined) {
            return emitExpression(
                state,
                staticResult ? node.whenTrue : node.whenFalse,
            );
        }
        const condition = ts.isNonNullExpression(node.condition)
            ? node.condition.expression
            : node.condition;
        const guardsVectorLocal = ts.isIdentifier(condition) &&
            state.vectorLocals.has(condition.text);
        if (guardsVectorLocal) {
            return emitExpression(state, node.whenTrue);
        }
        return `(${emitExpression(state, condition)} ? ${
            emitExpression(state, node.whenTrue)
        } : ${emitExpression(state, node.whenFalse)})`;
    }
    if (ts.isIdentifier(node)) {
        if (state.locals.has(node.text)) return node.text;
        // A closure variable the factory computed and the writer captured — the
        // spot light's `_cosHalfAngle` is one — is a value our record carries,
        // so it resolves the same way a property read does.
        const captured = state.request.propertySources[node.text];
        if (typeof captured === "string") return captured;
        throw new Error(
            `Pinned ${state.request.symbolName} reads '${node.text}', which is ` +
                "neither a lowered local nor a named source.",
        );
    }
    if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Math"
    ) {
        const name = node.expression.name.getText();
        const mapped = PINNED_MATH_FUNCTIONS[name];
        if (!mapped) {
            throw new Error(
                `Pinned ${state.request.symbolName} calls Math.${name}, which ` +
                    "has no lowering.",
            );
        }
        return `${mapped}(${
            node.arguments
                .map((argument) => emitExpression(state, argument))
                .join(", ")
        })`;
    }
    if (
        ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        state.vectorLocals.has(node.expression.text) &&
        ts.isNumericLiteral(node.argumentExpression)
    ) {
        const lane = Number.parseInt(node.argumentExpression.text, 10);
        const laneSource = state.laneSourceFor(node.expression.text, lane);
        if (laneSource !== undefined) return laneSource;
        const local = state.vectorLocals.get(node.expression.text)!;
        // A matrix or an array default indexes by lane; only a record colour
        // has named members, and only up to four of them.
        if (local.kind === "array" || local.lanes > 4) {
            return `${node.expression.text}[${lane}]`;
        }
        const member = vectorMember(
            state.request.symbolName,
            node.expression.text,
            local.lanes,
            lane,
        );
        return `${node.expression.text}.${member}`;
    }
    if (ts.isPropertyAccessChain(node) || ts.isElementAccessChain(node)) {
        // `thick?.max` — a native record member is never absent, so the
        // optional chain reads exactly like the plain access.
        const property = ts.isPropertyAccessChain(node)
            ? node.name.getText()
            : node.argumentExpression.getText().replace(/["']/g, "");
        const source = state.request.propertySources[property];
        if (source === undefined || source === null) {
            throw new Error(
                `Pinned ${state.request.symbolName} reads '${property}', which ` +
                    "has no usable source on our record.",
            );
        }
        return source;
    }
    // `light.diffuse[0]` indexes a vector property directly rather than through
    // a local, so the lane resolves against that property's own source.
    if (
        ts.isElementAccessExpression(node) &&
        ts.isNumericLiteral(node.argumentExpression) &&
        (ts.isPropertyAccessExpression(node.expression) ||
            ts.isPropertyAccessChain(node.expression))
    ) {
        const owner = node.expression.name.getText();
        const direct = state.request.laneSources?.[owner]?.[
            Number.parseInt(node.argumentExpression.text, 10)
        ];
        if (direct !== undefined) return direct;
        const lanes = state.request.vectorProperties?.[owner];
        const source = state.request.propertySources[owner];
        if (lanes !== undefined && typeof source === "string") {
            const lane = Number.parseInt(node.argumentExpression.text, 10);
            if (lanes > 4) return `${source}[${lane}]`;
            const member = vectorMember(
                state.request.symbolName,
                owner,
                lanes,
                lane,
            );
            return `${source}.${member}`;
        }
    }
    if (
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)
    ) {
        const property = ts.isPropertyAccessExpression(node)
            ? node.name.getText()
            : node.argumentExpression.getText().replace(/["']/g, "");
        const source = state.request.propertySources[property];
        if (source === undefined || source === null) {
            throw new Error(
                `Pinned ${state.request.symbolName} reads '${property}', which ` +
                    (source === null
                        ? "our records do not carry and which is read outside a " +
                            "`?? default` guard."
                        : "has no source on our record."),
            );
        }
        return source;
    }
    throw new Error(
        `Unsupported expression in pinned ${state.request.symbolName}: ` +
            `${node.getText(state.file)}.`,
    );
}

/**
 * Lowered statements, and whether a generation-decided `return` cut the body
 * off at them. Carrying the stop out of band is what lets each consumer
 * decide: a folded branch propagates it, because the pin's own control flow
 * would leave the enclosing body too, while a run-time branch cannot and
 * refuses instead.
 */
interface EmittedStatements {
    lines: string[];
    stopped: boolean;
}

/** Lowers a body, stopping where a generation-decided return cuts it off. */
function emitBody(
    state: WriterState,
    statements: readonly ts.Statement[],
): EmittedStatements {
    const lines: string[] = [];
    for (const statement of statements) {
        const emitted = emitStatement(state, statement);
        lines.push(...emitted.lines);
        if (emitted.stopped) return { lines, stopped: true };
    }
    return { lines, stopped: false };
}

/** A run-time branch cannot carry a generation-decided return out of itself. */
function requireNoStop(
    state: WriterState,
    emitted: EmittedStatements,
    statement: ts.Statement,
): string[] {
    if (emitted.stopped) {
        throw new Error(
            `Pinned ${state.request.symbolName} takes a generation-decided ` +
                "return inside a run-time branch, which the emitted writer " +
                `cannot express: ${statement.getText(state.file)}.`,
        );
    }
    return emitted.lines;
}

/**
 * The offset fields an early return tests for absence: `mOff === undefined`,
 * `!offsets.has("x")`, and `||` chains of either. The positive forms are
 * `guardedField` and `guardedFieldByHas`; this is their complement, and the
 * anisotropy writer guards its UV-transform tail with it.
 */
function absentOffsetGuardFields(
    state: WriterState,
    condition: ts.Expression,
): string[] | undefined {
    if (
        ts.isBinaryExpression(condition) &&
        condition.operatorToken.kind === ts.SyntaxKind.BarBarToken
    ) {
        const left = absentOffsetGuardFields(state, condition.left);
        const right = absentOffsetGuardFields(state, condition.right);
        if (left === undefined || right === undefined) return undefined;
        return [...left, ...right];
    }
    if (
        ts.isPrefixUnaryExpression(condition) &&
        condition.operator === ts.SyntaxKind.ExclamationToken
    ) {
        const field = guardedFieldByHas(condition.operand);
        return field === undefined ? undefined : [field];
    }
    const field = offsetLocalComparedToUndefined(state, condition, [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
    ]);
    return field === undefined ? undefined : [field];
}

/**
 * Lowers one pinned statement. Only an `if` can carry a generation-decided
 * return out of itself, so the other statement kinds keep their plain
 * `string[]` shape in `emitPlainStatement` below.
 */
function emitStatement(
    state: WriterState,
    statement: ts.Statement,
): EmittedStatements {
    // The pin's guards (`!cc?.isEnabled`, `!offsets.has(...)`) decide whether
    // the extension contributes at all. Generation already knows that from the
    // composed variant, so the guard is the caller's and is dropped rather than
    // lowered into a branch that can never be taken.
    if (ts.isIfStatement(statement) && !statement.elseStatement) {
        const then = statement.thenStatement;
        const onlyReturn = ts.isBlock(then)
            ? then.statements.length === 1 &&
                ts.isReturnStatement(then.statements[0]!)
            : ts.isReturnStatement(then);
        if (onlyReturn) {
            // The mirror of the fold below: `if (mOff === undefined) return;`
            // stops the writer when the variant does not declare that field.
            // Generation knows which fields the variant declares, so when one
            // is missing the return is taken and everything after it is dead.
            const absent = absentOffsetGuardFields(state, statement.expression);
            if (
                absent?.some((field) =>
                    !state.request.slots.some((slot) => slot.name === field)
                )
            ) {
                return { lines: [], stopped: true };
            }
            return { lines: [], stopped: false };
        }
        // `if (vOff !== undefined) { ... }` guards a block on whether the
        // variant declares that field. Generation knows the answer, so the
        // block is inlined or dropped rather than becoming a runtime branch.
        const guarded = guardedField(state, statement.expression) ??
            guardedFieldByHas(statement.expression);
        if (guarded !== undefined) {
            const declares = state.request.slots.some((slot) =>
                slot.name === guarded
            );
            if (!declares) return { lines: [], stopped: false };
            const body = ts.isBlock(then) ? then.statements : [then];
            // The block is inlined into the enclosing body, so a return
            // inside it leaves that body too -- exactly as the pin's would.
            return emitBody(state, body);
        }
        // A branch the pin takes at write time on caller state — the
        // Standard UV writer's `if (invertY)` — is a runtime condition here
        // too, exactly like the else-carrying branches below. This runs only
        // after every generation-time fold above declined, and a condition
        // with no named source still fails inside `emitExpression`.
        const body = ts.isBlock(then) ? then.statements : [then];
        return {
            lines: [
                `    if (${emitExpression(state, statement.expression)}) {`,
                ...requireNoStop(state, emitBody(state, body), statement),
                "    }",
            ],
            stopped: false,
        };
    }
    // A real branch the pin takes at write time — the UV transform picks its
    // rotation-free form when the angle is zero — is a runtime condition here,
    // because the angle is per-material data. Lowered as the branch it is.
    if (ts.isIfStatement(statement) && statement.elseStatement) {
        const thenBody = ts.isBlock(statement.thenStatement)
            ? statement.thenStatement.statements
            : [statement.thenStatement];
        const elseBody = ts.isBlock(statement.elseStatement)
            ? statement.elseStatement.statements
            : [statement.elseStatement];
        return {
            lines: [
                `    if (${emitExpression(state, statement.expression)}) {`,
                ...requireNoStop(state, emitBody(state, thenBody), statement),
                "    } else {",
                ...requireNoStop(state, emitBody(state, elseBody), statement),
                "    }",
            ],
            stopped: false,
        };
    }
    return { lines: emitPlainStatement(state, statement), stopped: false };
}

function emitPlainStatement(
    state: WriterState,
    statement: ts.Statement,
): string[] {
    if (ts.isVariableStatement(statement)) {
        const lines: string[] = [];
        for (const binding of statement.declarationList.declarations) {
            // `const { diffuseColor: dc, ... } = mat` — the Standard material
            // writer's shape. Each element is an alias of one record property,
            // exactly as if the pin had written `const dc = mat.diffuseColor`,
            // so each lowers through the same vector/scalar paths a property
            // binding does.
            if (
                ts.isObjectBindingPattern(binding.name) &&
                binding.initializer &&
                ts.isIdentifier(binding.initializer) &&
                binding.initializer.text === state.request.sourceLocal
            ) {
                for (const element of binding.name.elements) {
                    if (
                        !ts.isIdentifier(element.name) ||
                        element.dotDotDotToken ||
                        element.initializer
                    ) {
                        throw new Error(
                            `Unsupported destructuring in pinned ` +
                                `${state.request.symbolName}: ` +
                                `${element.getText(state.file)}.`,
                        );
                    }
                    const property =
                        element.propertyName?.getText(state.file) ??
                            element.name.text;
                    const local = element.name.text;
                    const source =
                        state.request.propertySources[property];
                    if (source === undefined || source === null) {
                        throw new Error(
                            `Pinned ${state.request.symbolName} destructures ` +
                                `'${property}', which has no source on our ` +
                                "record.",
                        );
                    }
                    const lanes =
                        state.request.vectorProperties?.[property];
                    if (lanes !== undefined) {
                        state.vectorLocals.set(local, {
                            lanes,
                            kind: "colour",
                        });
                        state.vectorLocalOrigins.set(local, property);
                        if (
                            state.request.laneSources?.[property] ===
                                undefined
                        ) {
                            lines.push(
                                `    const auto& ${local} = ${source};`,
                            );
                        }
                        continue;
                    }
                    state.locals.add(local);
                    lines.push(`    const float ${local} = ${source};`);
                }
                continue;
            }
            if (!ts.isIdentifier(binding.name) || !binding.initializer) {
                throw new Error(
                    `Unsupported binding in pinned ` +
                        `${state.request.symbolName}: ` +
                        `${binding.getText(state.file)}.`,
                );
            }
            const name = binding.name.text;
            // An uninstalled hook's result is the pin's own null; the local
            // carries that fact so reads through it fold to their defaults.
            if (initializerIsAbsentHookCall(state, binding.initializer)) {
                state.nullLocals.add(name);
                continue;
            }
            // `const off = offsets.get("x") / 4` is the pin's own indexing, and
            // the offsets are known at generation, so the local folds away.
            if (isOffsetsLookup(binding.initializer)) {
                const field = offsetsLookupField(binding.initializer) ??
                    // A shared helper builds its key from a template
                    // (`offsets.get(`${texName}UVm`)`), so the literal name is
                    // the caller's base field; only the trailing `m`/`t` says
                    // which of the pair this local indexes.
                    templateOffsetField(state, binding.initializer) ??
                    // And a helper keyed on a plain parameter takes the field
                    // from the binding the call site recorded.
                    parameterOffsetField(state, binding.initializer);
                if (field !== undefined) state.offsetLocals.set(name, field);
                continue;
            }
            // `const o = offset` and `const o = off / 4` both re-bind an
            // offset local; carry its field across either way.
            if (
                ts.isIdentifier(binding.initializer) &&
                state.offsetLocals.has(binding.initializer.text)
            ) {
                state.offsetLocals.set(
                    name,
                    state.offsetLocals.get(binding.initializer.text)!,
                );
                continue;
            }
            if (
                ts.isBinaryExpression(binding.initializer) &&
                ts.isIdentifier(binding.initializer.left) &&
                state.offsetLocals.has(binding.initializer.left.text)
            ) {
                state.offsetLocals.set(
                    name,
                    state.offsetLocals.get(binding.initializer.left.text)!,
                );
                continue;
            }
            // `const cc = material._clearCoat` is our record.
            if (name === state.request.sourceLocal) continue;
            // A local bound to a sub-object of the record (`const refr =
            // ss.refraction`) is an alias, not a value: the pin then reads
            // `refr.intensity`, which resolves through propertySources on its
            // own. Emitting it would try to copy the whole record into a float.
            if (aliasesRecord(state, binding.initializer)) continue;
            // A colour local (`const mrc = material._metallicReflectanceColor`)
            // binds by reference; the pin then reads `mrc[0]`.
            const colourLanes = vectorPropertyLanes(state, binding.initializer);
            const defaultLanes = vectorDefaultLanes(state, binding.initializer);
            if (colourLanes !== undefined) {
                const origin = vectorOriginProperty(binding.initializer);
                if (origin !== undefined) {
                    state.vectorLocalOrigins.set(name, origin);
                }
                state.vectorLocals.set(name, {
                    lanes: colourLanes,
                    kind: "colour",
                });
                // When every lane resolves to its own source, the alias itself
                // is never read — and our records may not even carry the whole
                // value it names.
                if (
                    origin !== undefined &&
                    state.request.laneSources?.[origin] !== undefined
                ) {
                    continue;
                }
                lines.push(
                    `    const auto& ${name} = ` +
                        `${emitExpression(state, binding.initializer)};`,
                );
                continue;
            }
            if (defaultLanes !== undefined) {
                // The pin's own vector default, as a typed array so the lanes
                // index rather than an initializer list that cannot.
                state.vectorLocals.set(name, {
                    lanes: defaultLanes,
                    kind: "array",
                });
                lines.push(
                    `    const std::array<float, ${defaultLanes}> ${name}` +
                        `${emitExpression(state, binding.initializer)};`,
                );
                continue;
            }
            const value = emitExpression(state, binding.initializer);
            state.locals.add(name);
            // A local the pin later reassigns is mutable there, so it is
            // mutable here; everything else keeps the const the pin's
            // single-assignment form expresses.
            lines.push(
                state.mutatedLocals.has(name)
                    ? `    float ${name} = ${value};`
                    : `    const float ${name} = ${value};`,
            );
        }
        return lines;
    }
    // A reassignment of the pin's own local — the Standard UV writer flips
    // `scaleY` and accumulates `offsetY` under its invert arm. The target must
    // already be a lowered local; anything else stays unsupported below.
    if (
        ts.isExpressionStatement(statement) &&
        ts.isBinaryExpression(statement.expression) &&
        ts.isIdentifier(statement.expression.left) &&
        state.locals.has(statement.expression.left.text) &&
        (statement.expression.operatorToken.kind ===
            ts.SyntaxKind.EqualsToken ||
            statement.expression.operatorToken.kind ===
                ts.SyntaxKind.PlusEqualsToken ||
            statement.expression.operatorToken.kind ===
                ts.SyntaxKind.MinusEqualsToken ||
            statement.expression.operatorToken.kind ===
                ts.SyntaxKind.AsteriskEqualsToken)
    ) {
        const operators = new Map<ts.SyntaxKind, string>([
            [ts.SyntaxKind.EqualsToken, "="],
            [ts.SyntaxKind.PlusEqualsToken, "+="],
            [ts.SyntaxKind.MinusEqualsToken, "-="],
            [ts.SyntaxKind.AsteriskEqualsToken, "*="],
        ]);
        return [
            `    ${statement.expression.left.text} ${
                operators.get(statement.expression.operatorToken.kind)
            } ${emitExpression(state, statement.expression.right)};`,
        ];
    }
    if (
        ts.isExpressionStatement(statement) &&
        ts.isBinaryExpression(statement.expression) &&
        statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
        const target = statement.expression.left;
        if (
            !ts.isElementAccessExpression(target) ||
            !ts.isIdentifier(target.expression) ||
            target.expression.text !== "data"
        ) {
            throw new Error(
                `Pinned ${state.request.symbolName} assigns to something other ` +
                    `than data[...]: ${statement.getText(state.file)}.`,
            );
        }
        const lane = dataLane(state, target.argumentExpression);
        const slot = slotAtLane(state.request, lane);
        const member = slot.lanes === 1
            ? `out.${slot.field}`
            : `out.${slot.field}[${slot.lane}]`;
        return [
            `    ${member} = static_cast<float>(` +
            `${emitExpression(state, statement.expression.right)});`,
        ];
    }
    // `for (const ext of _getPbrExts().values()) { ext.writeUbo(...) }` — each
    // extension writer is lowered into its own function, so the pin's own
    // delegation loop has no body to inline here.
    if (ts.isForOfStatement(statement)) return [];
    if (
        ts.isExpressionStatement(statement) &&
        ts.isCallExpression(statement.expression) &&
        ts.isIdentifier(statement.expression.expression)
    ) {
        const call = statement.expression;
        const callee = (call.expression as ts.Identifier).text;
        const nestedSources = state.request.nestedWriters?.[callee];
        if (nestedSources !== undefined) {
            // The pin passes the transform's base name as a string literal.
            const nameArgument = call.arguments.find((argument) =>
                ts.isStringLiteral(argument)
            );
            if (!nameArgument || !ts.isStringLiteral(nameArgument)) {
                throw new Error(
                    `Pinned ${state.request.symbolName} calls ${callee} without ` +
                        "a literal transform name.",
                );
            }
            const literal = nameArgument.text;
            const suffix = nestedFieldSuffix(state, callee);
            const declares = (field: string): boolean =>
                state.request.slots.some((slot) => slot.name === field);
            // Two shapes reach here. The uv-transform helper is passed a base its
            // key is built from — `writeOne(..., "baseColor")` fills
            // `baseColorUVm`/`baseColorUVt` — while the sheen helper is passed
            // the field names themselves: `writeSheenUvTransform(..., "sheenUVm",
            // "sheenUVt", ...)`. Appending the suffix to the second shape looks
            // for `sheenUVmUVm`, which used to resolve to nothing and emit
            // nothing, leaving four fields at zero.
            const base = declares(`${literal}${suffix}m`)
                ? `${literal}${suffix}`
                : declares(literal) && literal.endsWith("m")
                ? literal.slice(0, -1)
                : undefined;
            if (base === undefined) return [];
            // Every string literal the call passes, against the helper's own
            // parameter names, so a key read off a parameter resolves.
            const nested = state.nestedDeclarations[callee];
            const parameterFields: Record<string, string> = {};
            if (nested) {
                const literals = call.arguments.filter((argument) =>
                    ts.isStringLiteral(argument)
                ) as ts.StringLiteral[];
                const named = nested.declaration.parameters.filter(
                    (parameter) => ts.isIdentifier(parameter.name),
                );
                // The literals fill the trailing name parameters in order.
                const offset = named.length - literals.length - 1;
                literals.forEach((value, index) => {
                    const parameter = named[offset + index];
                    if (parameter && ts.isIdentifier(parameter.name)) {
                        parameterFields[parameter.name.text] = value.text;
                    }
                });
            }
            // Each call is its own block: the pin calls the helper once per
            // slot and its locals (`sx`, `ang`, ...) are function-scoped there,
            // so they would collide once inlined side by side.
            return [
                `    { // ${callee}("${literal}")`,
                ...lowerNested(
                    state,
                    callee,
                    base,
                    // The sources map is keyed on what the caller passed, not on
                    // the derived field base: `writeOne(..., "baseColor")` maps
                    // under "baseColor" where the field base is "baseColorUV".
                    // Passing the suffixed base here missed every entry and fell
                    // back to the identity `transform` parameter — which zeroed
                    // no field, so only a captured-block diff (Scene 29, all
                    // four base UV transforms at 1/1 against the browser's
                    // 30/-30) made it visible.
                    nestedSources(
                        base === `${literal}${suffix}` ? literal : base,
                    ),
                    parameterFields,
                ),
                "    }",
            ];
        }
    }
    throw new Error(
        `Unsupported statement in pinned ${state.request.symbolName}: ` +
            `${statement.getText(state.file)}.`,
    );
}

/**
 * The infix a helper puts between the base name and `m`/`t`.
 *
 * Taken from the helper's own `offsets.get(`${x}...m`)` template, because the
 * pinned helpers disagree: `writeUvTransform` writes `<base>m`, while the
 * uv-transform extension's `writeOne` writes `<base>UVm`.
 */
function nestedFieldSuffix(state: WriterState, callee: string): string {
    const { declaration } = state.nestedDeclarations[callee]!;
    const text = declaration.body.getText();
    const match = /offsets\s*\.\s*get\s*\(\s*`\$\{\w+\}(\w*)m`/.exec(text);
    return match?.[1] ?? "";
}

/** Lowers a shared transform helper against one variant's `<base>m`/`<base>t`. */
function lowerNested(
    state: WriterState,
    symbolName: string,
    base: string,
    propertySources: Readonly<Record<string, string | null>>,
    parameterFields: Readonly<Record<string, string>> = {},
): string[] {
    const { declaration } = state.nestedDeclarations[symbolName]!;
    const nestedState: WriterState = {
        file: state.file,
        request: {
            ...state.request,
            symbolName,
            sourceLocal: "tex",
            baseField: `${base}m`,
            propertySources,
        },
        baseLane: fieldLane(state.request, `${base}m`),
        parameterFields,
        locals: new Set<string>(),
        nullLocals: new Set<string>(),
        mutatedLocals: collectMutatedLocals(declaration.body),
        vectorLocals: new Map(),
        offsetLocals: new Map<string, string>(),
        vectorLocalOrigins: new Map<string, string>(),
        laneSourceFor: () => undefined,
        nestedDeclarations: state.nestedDeclarations,
    };
    return emitBody(nestedState, declaration.body.statements).lines;
}

/**
 * Lowers one pinned writer into C++ statements.
 *
 * The caller wraps them: the signature belongs to the variant, not to the
 * pinned function.
 */
export function lowerPinnedUboWriter(
    context: LoweringContext,
    request: UboWriterRequest,
): string[] {
    // Three shapes the pin uses: a top-level declaration, a member of a
    // module-level object literal (`pbrExt.writeUbo`), and a property of an
    // object a factory builds (`createPointLight#_writeLightUbo`).
    const resolved = request.symbolName.includes("#")
        ? context.propertyFunction(
            request.modulePath,
            request.symbolName.split("#")[0]!,
            request.symbolName.split("#")[1]!,
        )
        : request.symbolName.includes(".")
        ? context.methodDeclaration(request.modulePath, request.symbolName)
        : context.functionDeclaration(request.modulePath, request.symbolName);
    const { file } = resolved;
    const declaration = resolved.declaration;
    if (!declaration.body || !ts.isBlock(declaration.body)) {
        throw new Error(`Pinned ${request.symbolName} has no body.`);
    }
    const nestedDeclarations: Record<
        string,
        { declaration: ts.FunctionLikeDeclarationBase & { body: ts.Block } }
    > = {};
    for (const symbolName of Object.keys(request.nestedWriters ?? {})) {
        const nested = symbolName.includes(".")
            ? context.methodDeclaration(request.modulePath, symbolName)
            : context.functionDeclaration(request.modulePath, symbolName);
        if (!nested.declaration.body || !ts.isBlock(nested.declaration.body)) {
            throw new Error(`Pinned ${symbolName} has no body.`);
        }
        nestedDeclarations[symbolName] = {
            declaration: nested.declaration as ts.FunctionLikeDeclarationBase & {
                body: ts.Block;
            },
        };
    }
    const offsetLocals = new Map<string, string>();
    if (request.offsetParameter !== undefined) {
        offsetLocals.set(request.offsetParameter, request.baseField);
    }
    const state: WriterState = {
        file,
        request,
        baseLane: fieldLane(request, request.baseField),
        locals: new Set<string>(),
        nullLocals: new Set<string>(),
        mutatedLocals: collectMutatedLocals(declaration.body),
        vectorLocals: new Map(),
        offsetLocals,
        vectorLocalOrigins: new Map<string, string>(),
        laneSourceFor(local, lane) {
            const origin = this.vectorLocalOrigins.get(local);
            return origin === undefined
                ? undefined
                : request.laneSources?.[origin]?.[lane];
        },
        nestedDeclarations,
    };
    return emitBody(state, declaration.body.statements).lines;
}

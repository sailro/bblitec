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
 * keeps a changed writer visible instead of silently stale.
 */
import ts from "typescript";
import type { LoweringContext } from "./context.js";

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
}

const mathFunctions: Readonly<Record<string, string>> = {
    pow: "std::pow",
    log: "std::log",
    max: "std::max",
    min: "std::min",
    cos: "std::cos",
    sin: "std::sin",
    sqrt: "std::sqrt",
    abs: "std::abs",
};

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
    if (!ts.isBinaryExpression(condition)) return undefined;
    const isComparison =
        condition.operatorToken.kind ===
            ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        condition.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken;
    if (!isComparison) return undefined;
    const local = ts.isIdentifier(condition.left) ? condition.left.text : '';
    return state.offsetLocals.get(local);
}

/** The field an `offsets.has("x")` guard tests. */
function guardedFieldByHas(condition: ts.Expression): string | undefined {
    const match = /offsets\s*\.\s*has\s*\(\s*["']([^"']+)["']/.exec(
        condition.getText(),
    );
    return match?.[1];
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

/** Colour members, in the order the pin indexes them. */
const colourMembers = ["r", "g", "b", "a"] as const;

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
        if (readsAbsentProperty(state, node.left)) {
            return emitExpression(state, node.right);
        }
        return emitExpression(state, node.left);
    }
    if (ts.isBinaryExpression(node)) {
        const operators = new Map<ts.SyntaxKind, string>([
            [ts.SyntaxKind.PlusToken, "+"],
            [ts.SyntaxKind.MinusToken, "-"],
            [ts.SyntaxKind.AsteriskToken, "*"],
            [ts.SyntaxKind.SlashToken, "/"],
            [ts.SyntaxKind.AmpersandAmpersandToken, "&&"],
            [ts.SyntaxKind.BarBarToken, "||"],
            [ts.SyntaxKind.GreaterThanToken, ">"],
            [ts.SyntaxKind.LessThanToken, "<"],
            [ts.SyntaxKind.EqualsEqualsEqualsToken, "=="],
            [ts.SyntaxKind.EqualsEqualsToken, "=="],
        ]);
        const operator = operators.get(node.operatorToken.kind);
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
        const mapped = mathFunctions[name];
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
        const member = colourMembers[lane];
        if (member === undefined) {
            throw new Error(
                `Pinned ${state.request.symbolName} reads lane ${lane} of ` +
                    `'${node.expression.text}', which a colour does not have.`,
            );
        }
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
            const member = colourMembers[lane];
            if (member === undefined) {
                throw new Error(
                    `Pinned ${state.request.symbolName} reads lane ${lane} of ` +
                        `'${owner}', which a colour does not have.`,
                );
            }
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

function emitStatement(state: WriterState, statement: ts.Statement): string[] {
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
        if (onlyReturn) return [];
        // `if (vOff !== undefined) { ... }` guards a block on whether the
        // variant declares that field. Generation knows the answer, so the
        // block is inlined or dropped rather than becoming a runtime branch.
        const guarded = guardedField(state, statement.expression) ??
            guardedFieldByHas(statement.expression);
        if (guarded !== undefined) {
            const declares = state.request.slots.some((slot) =>
                slot.name === guarded
            );
            if (!declares) return [];
            const body = ts.isBlock(then) ? then.statements : [then];
            return body.flatMap((inner) => emitStatement(state, inner));
        }
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
        return [
            `    if (${emitExpression(state, statement.expression)}) {`,
            ...thenBody.flatMap((inner) => emitStatement(state, inner)),
            "    } else {",
            ...elseBody.flatMap((inner) => emitStatement(state, inner)),
            "    }",
        ];
    }
    if (ts.isVariableStatement(statement)) {
        const lines: string[] = [];
        for (const binding of statement.declarationList.declarations) {
            if (!ts.isIdentifier(binding.name) || !binding.initializer) {
                throw new Error(
                    `Unsupported binding in pinned ` +
                        `${state.request.symbolName}: ` +
                        `${binding.getText(state.file)}.`,
                );
            }
            const name = binding.name.text;
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
            lines.push(`    const float ${name} = ${value};`);
        }
        return lines;
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
                    nestedSources(base),
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
        vectorLocals: new Map(),
        offsetLocals: new Map<string, string>(),
        vectorLocalOrigins: new Map<string, string>(),
        laneSourceFor: () => undefined,
        nestedDeclarations: state.nestedDeclarations,
    };
    const { declaration } = state.nestedDeclarations[symbolName]!;
    return declaration.body.statements.flatMap((statement) =>
        emitStatement(nestedState, statement)
    );
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
    return declaration.body.statements.flatMap((statement) =>
        emitStatement(state, statement)
    );
}

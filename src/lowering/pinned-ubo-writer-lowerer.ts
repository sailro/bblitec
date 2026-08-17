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
    /** Every field of the variant, so `off + n` resolves to a name. */
    slots: readonly UboFieldSlot[];
    /**
     * Properties the pin binds to a local and then indexes — a colour read as
     * `color[0]`. Lowered as a reference to our record's own colour, with the
     * lane resolved to its member, rather than as a float.
     */
    vectorProperties?: Readonly<Record<string, number>>;
    /**
     * Sibling writers this one calls, keyed by symbol name. Each pinned ext
     * writer ends by delegating its texture transforms to a shared helper
     * (`writeUvTransform(data, offsets, "iridescenceUV", iri.texture)`), whose
     * base fields are `<name>m` / `<name>t`. The helper's own guard returns when
     * the variant declares neither, so a variant without the transform lowers
     * to nothing here — the same outcome, reached the same way.
     */
    nestedWriters?: Readonly<
        Record<string, Readonly<Record<string, string>>>
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
    locals: Set<string>;
    /** Locals bound to a colour rather than a scalar, by lane count. */
    vectorLocals: Map<string, number>;
    /** The sibling helper declarations, resolved once by the entry point. */
    nestedDeclarations: Record<
        string,
        { declaration: ts.FunctionDeclaration }
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
    if (ts.isIdentifier(expression)) return base(expression);
    if (
        ts.isBinaryExpression(expression) &&
        expression.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        ts.isNumericLiteral(expression.right)
    ) {
        return base(expression.left) +
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
        throw new Error(
            `Pinned ${state.request.symbolName} reads '${node.text}', which is ` +
                "not a lowered local.",
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
        const guarded = guardedField(state, statement.expression);
        if (guarded !== undefined) {
            const declares = state.request.slots.some((slot) =>
                slot.name === guarded
            );
            if (!declares) return [];
            const body = ts.isBlock(then) ? then.statements : [then];
            return body.flatMap((inner) => emitStatement(state, inner));
        }
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
                const field = offsetsLookupField(binding.initializer);
                if (field !== undefined) state.offsetLocals.set(name, field);
                continue;
            }
            // `const o = off / 4` re-binds an offset local; carry its field.
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
            // A colour local (`const mrc = material._metallicReflectanceColor`)
            // binds by reference; the pin then reads `mrc[0]`.
            const vectorLanes = vectorPropertyLanes(state, binding.initializer) ??
                vectorDefaultLanes(state, binding.initializer);
            if (vectorLanes !== undefined) {
                const value = emitExpression(state, binding.initializer);
                state.vectorLocals.set(name, vectorLanes);
                lines.push(`    const auto& ${name} = ${value};`);
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
    if (
        ts.isExpressionStatement(statement) &&
        ts.isCallExpression(statement.expression) &&
        ts.isIdentifier(statement.expression.expression)
    ) {
        const call = statement.expression;
        const callee = (call.expression as ts.Identifier).text;
        const nested = state.request.nestedWriters?.[callee];
        if (nested !== undefined) {
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
            const base = nameArgument.text;
            const declares = state.request.slots.some((slot) =>
                slot.name === `${base}m`
            );
            if (!declares) return [];
            return [
                `    // ${callee}("${base}")`,
                ...lowerNested(state, callee, base, nested),
            ];
        }
    }
    throw new Error(
        `Unsupported statement in pinned ${state.request.symbolName}: ` +
            `${statement.getText(state.file)}.`,
    );
}

/** Lowers a shared transform helper against one variant's `<base>m`/`<base>t`. */
function lowerNested(
    state: WriterState,
    symbolName: string,
    base: string,
    propertySources: Readonly<Record<string, string>>,
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
        locals: new Set<string>(),
        vectorLocals: new Map<string, number>(),
        offsetLocals: new Map<string, string>(),
        nestedDeclarations: state.nestedDeclarations,
    };
    const { declaration } = state.nestedDeclarations[symbolName]!;
    return declaration.body!.statements.flatMap((statement) =>
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
    const { file, declaration } = context.functionDeclaration(
        request.modulePath,
        request.symbolName,
    );
    if (!declaration.body) {
        throw new Error(`Pinned ${request.symbolName} has no body.`);
    }
    const nestedDeclarations: Record<
        string,
        { declaration: ts.FunctionDeclaration }
    > = {};
    for (const symbolName of Object.keys(request.nestedWriters ?? {})) {
        nestedDeclarations[symbolName] = context.functionDeclaration(
            request.modulePath,
            symbolName,
        );
    }
    const state: WriterState = {
        file,
        request,
        baseLane: fieldLane(request, request.baseField),
        locals: new Set<string>(),
        vectorLocals: new Map<string, number>(),
        offsetLocals: new Map<string, string>(),
        nestedDeclarations,
    };
    return declaration.body.statements.flatMap((statement) =>
        emitStatement(state, statement)
    );
}

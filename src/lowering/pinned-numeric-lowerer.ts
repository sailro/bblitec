/**
 * Translates a pinned numeric function body to C++, statement by statement.
 *
 * The splat loaders are arithmetic over typed arrays: the covariance build in
 * `splat-data.ts` and the counting sort in `splat-sort-core.ts`. Restating
 * either here would be a second copy that agrees with the pin only until the
 * pin changes, so the arithmetic comes from the pinned declaration's own AST
 * — the shape `light-lowerer.ts#lowerMatrix` and
 * `pinned-ubo-writer-lowerer.ts` already use, widened to the statements these
 * bodies actually contain (loops, blocks, compound assignment).
 *
 * This module owns the TRANSLATION, never the formula. Two rules make the
 * translation faithful rather than approximate:
 *
 *  - **A JS number is an f64.** Every local becomes `double`, so an
 *    intermediate keeps the width the pin computed it at.
 *  - **A typed array is its element width.** `Float32Array` becomes
 *    `std::vector<float>`, so a store rounds to f32 exactly where the pin's
 *    store does — which `sortSplatsBackToFront` depends on by name, tracking
 *    its min/max from the value round-tripped through `depths` rather than
 *    from the f64 it computed.
 *
 * Anything the translator does not recognise fails generation, which is what
 * keeps a changed pinned body visible instead of silently stale.
 */
import ts from "typescript";
import { cppIdentifier } from "../cpp-literals.js";
import { isAssignmentExpression, isUpdateExpression } from "../compiler/syntax.js";
import { sourceLocation } from "../source-location.js";
import { cppPrimary, renderPinnedArithmetic, type PinnedExpressionSpelling, type RenderedCpp } from "./pinned-numeric-expression.js";
import { cppCondition } from "../cpp-expressions.js";
import { moduleScopeConstant, unwrapExpression } from "./context.js";
import { CPP_RECORD, type CppRecordShape, cppVector } from "./cpp-types.js";
import {
    PINNED_ARITHMETIC_OPERATORS,
    PINNED_ASSIGNMENT_OPERATORS,
} from "./pinned-operators.js";

/**
 * Each list-shaped binding's C++ storage, and what indexing it yields.
 *
 * One table, so the declaration path and the expression path cannot
 * disagree about what a row of a jagged list, or a point of a path, is.
 */
const LIST_SHAPES: ReadonlyMap<
    string,
    { storage: string; element?: PinnedBinding["type"] }
> = new Map([
    ["f64-list", { storage: cppVector("f64") }],
    [
        "f64-list-2d",
        { storage: cppVector(cppVector("f64")), element: "f64-list" },
    ],
    ["vec3-list", { storage: cppVector(CPP_RECORD.vec3.storage), element: "vec3" }],
    [
        "vec3-list-2d",
        { storage: cppVector(cppVector(CPP_RECORD.vec3.storage)), element: "vec3-list" },
    ],
]);

/** Whether a binding is one of the list shapes above. */
function isListShape(type: string): boolean {
    return LIST_SHAPES.has(type);
}

/** The storage one list-shaped binding declares. */
function listStorage(type: string): string | undefined {
    return LIST_SHAPES.get(type)?.storage;
}

/** What indexing one binding yields, where it can be indexed. */
function elementType(type: string): PinnedBinding["type"] | undefined {
    return LIST_SHAPES.get(type)?.element;
}

/** The list shape whose ELEMENT is `type` -- for a literal list of lists. */
function listOfType(type: string): string | undefined {
    for (const [shape, spec] of LIST_SHAPES) {
        if (spec.element === type) return shape;
    }
    return undefined;
}

/** The pin's three small positional records. */
export type RecordShapeType = CppRecordShape;

/**
 * The pin's three small positional records, by the storage each one takes
 * and the members the pin reads off it -- the shared registry, as the map
 * the declaration and expression paths look a binding's type up in. A
 * store into one keeps the pin's f64 width exactly as a `Vec3d` store does.
 */
export const RECORD_SHAPES: ReadonlyMap<
    string,
    { storage: string; members: readonly string[]; annotation: string }
> = new Map(Object.entries(CPP_RECORD));

/** Whether a binding is one of the record shapes above. */
export function isRecordType(type: string): type is RecordShapeType {
    return RECORD_SHAPES.has(type);
}

/**
 * The record shape a pinned type annotation names, if it names one -- the
 * annotation node, or its text where a caller reads annotations as text.
 */
export function recordTypeOfAnnotation(
    annotation: ts.TypeNode | string,
): RecordShapeType | undefined {
    const name =
        typeof annotation === "string"
            ? annotation
            : ts.isTypeReferenceNode(annotation) &&
                ts.isIdentifier(annotation.typeName)
              ? annotation.typeName.text
              : undefined;
    for (const [type, shape] of RECORD_SHAPES) {
        if (shape.annotation === name) return type as RecordShapeType;
    }
    return undefined;
}

/** The record shape whose members are exactly `names`, in that order. */
export function recordTypeOfMembers(
    names: readonly string[],
): RecordShapeType | undefined {
    for (const [type, shape] of RECORD_SHAPES) {
        if (
            shape.members.length === names.length &&
            shape.members.every((member, index) => member === names[index])
        ) {
            return type as RecordShapeType;
        }
    }
    return undefined;
}

/**
 * A positional record literal as its native storage: `Vec3d{x, y, z}`.
 * The default `recordLiteral` spelling, for a caller whose records land on
 * the storage the table names.
 */
export function recordLiteralCpp(
    type: string,
    components: readonly string[],
): string {
    const storage = RECORD_SHAPES.get(type)?.storage;
    if (!storage) throw new Error(`'${type}' is not a positional record.`);
    return `${storage}{${components.join(", ")}}`;
}

/**
 * The binding for a value the reached slice never supplies: a pinned
 * optional parameter no caller passes, a hook no graph installs, a record
 * a static test resolved to `null`. Its spelling is never emitted -- every
 * guard on it folds -- so the one spelling lives here.
 */
export function absentBinding(): PinnedBinding {
    return { cpp: "false", type: "bool", staticallyAbsent: true };
}

/**
 * The shape a call returns, by the caller's `callShapes`: the whole call's
 * text first (an instantiated helper is keyed by its call), then the
 * callee's text (`getter`, `system.createColor`).
 */
export function callShapeOf(
    callShapes: ReadonlyMap<string, PinnedBinding["type"]> | undefined,
    call: ts.CallExpression,
    file: ts.SourceFile,
): PinnedBinding["type"] | undefined {
    return (
        callShapes?.get(call.getText(file)) ??
        callShapes?.get(call.expression.getText(file))
    );
}

/** How one pinned identifier is spelled and typed in the emitted C++. */
export interface PinnedBinding {
    cpp: string;
    /** An effectful buffer getter must be read when a local aliases it. */
    materializeAlias?: true;
    /** Indexed stores through a platform view, including its bounds and rounding rules. */
    indexedStore?: (owner: string, index: string, value: string) => string;
    /** For a view, the C++ expression giving its byte length. */
    bytesCpp?: string;
    /**
     * The C++ test for this binding being ABSENT, where the pin tests a
     * nullable container's own truthiness (`!positions`,
     * `normals && ...`). A native container has no JavaScript truthiness,
     * and `!vector` does not compile at all -- so the binding that stands
     * in for `Float32Array | undefined` says how absence is spelled, and
     * the two boolean positions the pin uses read it. Every other
     * position still names the container itself.
     */
    absentCpp?: string;
    /**
     * This binding stands in for a value the reached slice NEVER supplies
     * -- a pinned optional parameter no caller passes. A guard on it takes
     * its else arm at generation and its then arm is not translated, which
     * is what keeps the machinery behind such a parameter out of a port
     * that has none of it.
     */
    staticallyAbsent?: true;
    /**
     * Whether a view aliases storage the body may WRITE through.
     *
     * A view is read-only by default, which is what every reading fold
     * needs and what keeps a store into one a generation failure rather
     * than a silent write into a temporary. `bakeTransformIntoVertices` is
     * the one pinned body that writes through its views: it copies the row
     * buffer and then rewrites each splat's position, scale and packed
     * quaternion through a `U8` and an `F32` over those same bytes. Marking
     * the SOURCE mutable is what carries through to both, because the pin
     * derives them from one buffer and expects a store through either to be
     * visible in the other.
     */
    mutable?: true;
    /**
     * `f32`/`u32`/`u8` are owned buffers whose stores round to that width;
     * `f32-view`/`u8-view` are read-only aliases over a byte buffer;
     * `f64-list` is a GROWABLE `number[]` the pin pushes onto, which holds
     * its elements at the pin's own double width until a `new F32(list)`
     * rounds them; `f64-buffer` is the pin's own `new F64(n)` scratch --
     * the same storage, but sized once and indexed inside its own bounds,
     * so a store goes straight through the way an `f32` or `u32` buffer's
     * does, and an out-of-range one is the bug a typed array would drop; `f64-list-2d` is a jagged `number[][]` whose rows are
     * themselves `f64-list`s; `vec3`, `vec3-list` and `vec3-list-2d` are
     * the same three shapes over the pin's `{x, y, z}` record, which the
     * mesh builders pass around whole; `scalar` is an f64 local or
     * parameter.
     */
    type:
        | "f32"
        | "u32"
        | "u8"
        | "f32-view"
        | "u8-view"
        | "f64-list"
        | "f64-buffer"
        | "f64-list-2d"
        | "vec2"
        | "vec3"
        | "color4"
        | "vec3-list"
        | "vec3-list-2d"
        | "scalar"
        | "index"
        | "bool"
        /**
         * A fixed list of per-particle steps the pin calls by index
         * (`steps[s]!(i)`); `length` is its size and an indexed call goes
         * through the caller's `indexedCall`.
         */
        | "function-list"
        /**
         * A record the body only aliases and reads members off by their
         * dotted text (`const buffer = system.buffer`): it has no members
         * of its own here, so every read resolves through a text-keyed
         * binding the caller supplied.
         */
        | "opaque";
    /**
     * A value generation already knows. A `===` against a literal or a
     * module constant, a `typeof` test, a `switch` or a guard over one
     * folds to the arm it selects, and the untaken arm is never translated
     * -- the same specialization `staticallyAbsent` performs for a guard,
     * widened to the block evaluators, whose shape tests over a graph's
     * static wiring are all of this kind.
     */
    staticNumber?: number;
    staticBoolean?: boolean;
    /**
     * A record the pin reads through an optional chain (`texture?.uScale`).
     *
     * `present` is the C++ test that says the record exists, and `members`
     * spells each property the body may read off it. What an ABSENT record
     * yields is the pin's own answer rather than one invented here: a read
     * under `??` takes that operator's right side, and a read the pin
     * coerces instead (`!!texture?.invertY`) takes the member's own
     * `absent`. A member with neither, read outside a `??`, fails.
     */
    optional?: {
        present: string;
        members: ReadonlyMap<string, { cpp: string; absent?: string }>;
    };
}

export interface PinnedNumericScope {
    /** Domain-owned records and library values; arithmetic still recurses through this lowerer. */
    expression?: (expression: ts.Expression, lowerer: PinnedNumericLowerer) => string | RenderedCpp | undefined;
    expressionSpelling?: PinnedExpressionSpelling;
    foldConditions?: boolean;
    /** An explicitly validated platform boundary within an otherwise lowered
     * body. Undefined retains the ordinary translator and its refusals. */
    statement?: (statement: ts.Statement, lowerer: PinnedNumericLowerer, indent: string) => readonly string[] | undefined;
    /** Unbounded platform inputs require the full JS ToInt32 conversion. */
    checkedBitwiseCoercions?: boolean;
    /** Identifiers already bound when the body starts (parameters, locals). */
    bindings: Map<string, PinnedBinding>;
    /** Calls this body may make, as a C++ spelling per pinned callee. */
    calls: ReadonlyMap<string, (args: readonly string[]) => string>;
    /**
     * Methods called ON a bound buffer, spelled from the RESOLVED receiver.
     * Keyed by method name alone: `counts.fill(0)` reaches the same rule
     * whichever local the pin happened to alias the buffer through.
     */
    methods?: ReadonlyMap<
        string,
        (receiver: string, args: readonly string[], binding: PinnedBinding) => string
    >;
    /**
     * How a bare `set` on a bound buffer spells its source, where the source
     * is another bound buffer rather than an expression. `typed.set(a, n)`
     * copies a whole array in, which is not an expression the translator can
     * produce.
     */
    arrayCopy?: (
        receiver: string,
        source: string,
        offset: string,
    ) => string;
    /**
     * What a `return` produces. `undefined` means the pinned function returns
     * nothing and a bare `return;` is emitted.
     */
    returnValue?: (expression: ts.Expression | undefined) => string;
    /**
     * Which of `calls`' pinned names return a 4x4 matrix rather than a
     * number, so a `const` bound to one declares the matrix instead of a
     * double. The translator carries no types of its own, and the caller
     * owns every spelling in `calls`, so the caller is what can answer
     * this — a name outside `calls` is a contract error either way.
     */
    matrixCalls?: ReadonlySet<string>;
    /** Matrix-valued calls whose singular/absent result remains observable. */
    nullableMatrixCalls?: ReadonlySet<string>;
    /**
     * Calls whose result is a `number[]` rather than a number.
     *
     * The translator has no types, so a call's SHAPE is the caller's to
     * declare — the same split `matrixCalls` already draws. Without it a
     * `const normals = computeNormals(...)` would bind a double and the
     * `new F32(normals)` after it would have nothing to convert.
     */
    listCalls?: ReadonlySet<string>;
    /**
     * Calls whose result is a fixed-length numeric TUPLE the pin
     * destructures at the call site (`const [x, y, z] = f(...)`).
     *
     * The same split `matrixCalls` and `listCalls` draw, one shape further:
     * the translator carries no types, so which of `calls`' names returns a
     * tuple is the caller's to declare. The native spelling those callers
     * give such a name must be indexable, which `std::array` is — and the
     * declared ARITY is what keeps a destructuring of a different length a
     * generation error instead of an index past that array's end.
     */
    tupleCalls?: ReadonlyMap<string, number>;
    /**
     * Calls returning a FIXED tuple the body binds whole and then indexes,
     * as `const bounds = projectedSphereBounds(...)` then `bounds[0]`.
     *
     * `tupleCalls` above serves the destructuring form and `listCalls` the
     * growable one; this is the third, and it is the one that must not
     * allocate: the cluster cull runs it once per light per frame, so it
     * lands in a `std::array` sized by the arity the caller declares.
     */
    fixedTupleCalls?: ReadonlyMap<string, number>;
    /**
     * Calls whose result is a small numeric RECORD, and which members the
     * body may read off one (`const q = _quatFromRotationBasis(...)`, then
     * `q.x`).
     *
     * The third of the same split: the translator has no types, so a call's
     * shape is the caller's to declare. Listing the members rather than
     * accepting any is what makes a pin that renames one fail here instead
     * of emitting a member the native struct does not have.
     */
    recordCalls?: ReadonlyMap<string, readonly string[]>;
    /**
     * Methods that mutate their receiver IN PLACE and hand it back, so the
     * pin can write `a = a.reverse()` for what is one operation.
     *
     * `Array.prototype.reverse` is the shape: it reverses the array and
     * returns that same array, and `createCapsuleData` stores the result
     * over its own source. The native spelling in `methods` is the
     * mutation, which has no value to store -- so the assignment around it
     * is the identity and this set is what says which names it holds for.
     * A method outside it keeps the ordinary store, which is what stops a
     * copying method from silently losing its result.
     */
    receiverReturningMethods?: ReadonlySet<string>;
    /** This body uses `||` only to join boolean conditions. */
    booleanOr?: boolean;
    /** This body uses `&&` only to join boolean conditions. */
    booleanAnd?: boolean;
    /** Native option specialization may make a pinned fallback local dead. */
    maybeUnusedConst?: boolean;
    /**
     * How a `for (const x of xs)` spells its range, and what `x` binds to.
     *
     * The translator has no types, so it cannot know what a pinned
     * collection is or what its element exposes; the caller that owns the
     * native carrier answers both. Returning `undefined` refuses the loop
     * by name rather than guessing a range.
     */
    forOf?: (
        iterated: string,
        element: string,
    ) => {
        /** The C++ range expression, e.g. `scene.caster_meshes`. */
        range: string;
        /** What the element name and its member paths resolve to. */
        bindings: ReadonlyMap<string, PinnedBinding>;
    } | undefined;
    /**
     * How a `{ x, y, z }` object literal spells the native record it is.
     *
     * The pin passes small positional records around by value -- a point
     * handed to a placement callback, a direction folded into a rotation --
     * and the translator has no types, so which native struct one becomes
     * is the caller's to name. Absent, an object literal refuses by name
     * exactly as it did before this option existed. The member ORDER is
     * the pin's own and is checked: a literal whose members are not `x`,
     * `y`, `z` in that order fails rather than being reordered silently.
     */
    vec3Literal?: (x: string, y: string, z: string) => string;
    /**
     * The general form of `vec3Literal`: how an `{x, y}`, `{x, y, z}` or
     * `{r, g, b, a}` literal spells the native record it is, given the
     * shape its member names select and its lowered components in the
     * pin's own order.
     */
    recordLiteral?: (
        type: PinnedBinding["type"],
        components: readonly string[],
    ) => string;
    /**
     * The SHAPE each of `calls`' names returns, where it is not a number.
     *
     * The translator has no types, so a `const min = minGetter(i)` binds a
     * double unless the caller says the getter yields a record -- and
     * which record decides every `typeof`/`in` test the body makes on it.
     * A name absent here returns a number, as every other call does.
     */
    callShapes?: ReadonlyMap<string, PinnedBinding["type"]>;
    /**
     * How a call through an indexed function list is spelled:
     * `steps[s]!(i)` on a `function-list` binding. The caller owns the
     * native list and what each entry is handed beyond the pin's own
     * arguments.
     */
    indexedCall?: (
        list: PinnedBinding,
        index: string,
        args: readonly string[],
    ) => string;
}

/**
 * The `new <ctor>(list)` spellings that end a grown `number[]`, and the
 * conversion each one performs.
 *
 * Two names reach one constructor. `src/engine/typed-arrays.ts` declares
 * `export const F32 = Float32Array` and `export const U32 = Uint32Array`
 * purely so the minifier can shrink the token, and states that the aliases
 * have "identical runtime semantics" — so a pinned module spells whichever
 * it happened to import (`create-disc.ts` the alias, `create-torus-knot.ts`
 * the global) and both mean the same store width. A spelling this table
 * does not carry converts nothing, which leaves the `new` unrecognised and
 * fails generation rather than silently dropping the rounding.
 */
const TYPED_ARRAY_CONVERSIONS: ReadonlyMap<
    string,
    { conversion: string; type: PinnedBinding["type"] }
> = new Map([
    ["F32", { conversion: "f32_array_from", type: "f32" as const }],
    ["Float32Array", { conversion: "f32_array_from", type: "f32" as const }],
    ["U32", { conversion: "u32_array_from", type: "u32" as const }],
    ["Uint32Array", { conversion: "u32_array_from", type: "u32" as const }],
]);

export class PinnedNumericLowerer {
    public constructor(
        private readonly file: ts.SourceFile,
        private readonly scope: PinnedNumericScope,
    ) {
        this.callerBindings = new Set(scope.bindings.keys());
    }

    /** Module-scope constants resolved so far, undefined while resolving. */
    private readonly moduleConstants = new Map<
        string,
        PinnedBinding | undefined
    >();

    private fail(node: ts.Node, what: string): never {
        const location = sourceLocation(node);
        throw new Error(
            `${this.file.fileName}:${location.line}:${location.character}: Unsupported pinned ${what}: ${node.getText(this.file)}.`,
        );
    }

    /** The names the CALLER bound before this body started. */
    private readonly callerBindings: ReadonlySet<string>;

    /** Local helper closures a builder declares and calls; see below. */
    private readonly helpers = new Map<string, ts.ArrowFunction>();

    /** How many helper bodies are being written out right now. */
    private inlining = 0;

    private localName(name: string): string {
        // Caller aliases can name locals declared later (options.offset ->
        // defaultOffset); reserve declarations, not those substitutions.
        const occupied = new Set(["pi", ...Array.from(this.scope.bindings)
            .filter(([source, binding]) => !this.callerBindings.has(source) || source === binding.cpp)
            .map(([, binding]) => binding.cpp)]);
        const base = cppIdentifier(name);
        let cpp = base;
        for (let suffix = 1; occupied.has(cpp); suffix++) cpp = `${base}_${suffix}`;
        return cpp;
    }

    protected withBindings<T>(action: () => T): T {
        const saved = new Map(this.scope.bindings);
        try { return action(); }
        finally {
            this.scope.bindings.clear();
            for (const [name, binding] of saved) this.scope.bindings.set(name, binding);
        }
    }

    public statement(statement: ts.Statement, indent: string): string[] {
        const adapted = this.scope.statement?.(statement, this, indent);
        if (adapted !== undefined) return [...adapted];
        if (ts.isContinueStatement(statement) && !statement.label) {
            return [`${indent}continue;`];
        }
        if (ts.isVariableStatement(statement)) {
            const helper = this.localHelper(statement.declarationList);
            if (helper) {
                // A builder's own `const createCap = (isTop) => {...}`.
                // Recorded rather than emitted: it closes over the arrays
                // the body is already growing, and every call names a
                // literal argument, so inlining at each call site is what
                // the pin's own two calls mean.
                this.helpers.set(helper.name, helper.arrow);
                return [];
            }
            return this.declarations(
                statement.declarationList,
                indent,
            );
        }
        if (
            this.inlining > 0 &&
            ts.isReturnStatement(statement) &&
            !statement.expression
        ) {
            return [`${indent}break;`];
        }
        if (ts.isExpressionStatement(statement)) {
            const expression = unwrapExpression(statement.expression);
            if (ts.isBinaryExpression(expression) &&
                expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                const right = unwrapExpression(expression.right);
                if (ts.isBinaryExpression(right) && right.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                    if (!ts.isIdentifier(expression.left) || !ts.isIdentifier(right.left)) {
                        const arrayStores = this.chainedArrayStores(expression, indent);
                        if (arrayStores) return arrayStores;
                        return this.fail(expression, "scalar chained assignment targets");
                    }
                    return [
                        ...this.statement(ts.factory.createExpressionStatement(right), indent),
                        ...this.statement(ts.factory.createExpressionStatement(
                            ts.factory.updateBinaryExpression(expression, expression.left, expression.operatorToken, right.left)), indent),
                    ];
                }
            }
            // `system._prepareFrame?.()` on a hook the reached slice never
            // installs: the pin's own optional call over an absent member
            // is no statement at all, exactly as its guarded `if` would be.
            if (this.absentOptionalCall(statement.expression)) return [];
            const inlined = this.inlinedHelperCall(
                statement.expression,
                indent,
            );
            if (inlined) return inlined;
            return [
                `${indent}${this.expressionStatement(statement.expression)};`,
            ];
        }
        if (ts.isBreakStatement(statement) && !statement.label) {
            return [`${indent}break;`];
        }
        if (ts.isContinueStatement(statement) && !statement.label) {
            return [`${indent}continue;`];
        }
        if (ts.isSwitchStatement(statement)) {
            return this.switchStatement(statement, indent);
        }
        if (ts.isIfStatement(statement)) {
            // A guard generation can already answer keeps the arm it
            // selects and translates nothing of the other. Two kinds of
            // guard fold here: a shape test over a getter whose shape the
            // graph fixed, or a lock mode the block serialized; and a guard
            // on a binding the caller declared statically ABSENT -- a
            // pinned optional parameter the reached slice never supplies,
            // whose then arm reaches machinery this port does not have
            // (the deformed-triangle scratch behind `deformTriangle`), so
            // emitting a dead call to it would be inventing a native name
            // for something no scene reaches. The parameter's own name and
            // annotation are still asserted, so the pin cannot move the
            // seam without failing here.
            const known = this.staticCondition(statement.expression);
            if (known !== undefined) {
                if (known) return this.statement(statement.thenStatement, indent);
                return statement.elseStatement
                    ? this.statement(statement.elseStatement, indent)
                    : [];
            }
            const lines = [
                `${indent}if (${this.condition(statement.expression)}) {`,
                ...this.branch(statement.thenStatement, indent),
            ];
            if (!statement.elseStatement) {
                lines.push(`${indent}}`);
                return lines;
            }
            lines.push(`${indent}} else {`);
            lines.push(...this.branch(statement.elseStatement, indent));
            lines.push(`${indent}}`);
            return lines;
        }
        if (ts.isWhileStatement(statement)) {
            return [
                `${indent}while (${this.condition(statement.expression)}) {`,
                ...this.branch(statement.statement, indent),
                `${indent}}`,
            ];
        }
        if (ts.isForStatement(statement)) {
            const initializer = statement.initializer;
            // A hoisted loop variable's `for` assigns rather than declares
            // (`for (y = 0; ...)`); it is the same loop, and the index it
            // binds lives for the same body either way.
            const assigned =
                initializer !== undefined &&
                ts.isBinaryExpression(initializer) &&
                initializer.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken &&
                ts.isIdentifier(initializer.left)
                    ? { name: initializer.left.text, initial: initializer.right }
                    : undefined;
            const declaring =
                initializer !== undefined &&
                ts.isVariableDeclarationList(initializer)
                    ? initializer
                    : undefined;
            if (
                (!assigned && !declaring) ||
                !statement.condition
            ) {
                this.fail(statement, "for statement");
            }
            // The loop variable indexes typed arrays, so it is an integer
            // rather than the f64 every other local is.
            const { condition, incrementor } = statement;
            return this.withBindings(() => {
                const declared = assigned
                    ? this.declaredLoopVariable(
                          assigned.name,
                          assigned.initial,
                      )
                    : this.loopVariable(declaring!);
                return [
                    `${indent}for (${declared}; ` +
                        `${this.condition(condition)}; ` +
                        `${incrementor ? this.expressionStatement(incrementor) : ""}) {`,
                    ...this.branch(statement.statement, indent),
                    `${indent}}`,
                ];
            });
        }
        if (ts.isForOfStatement(statement)) {
            const initializer = statement.initializer;
            if (
                !ts.isVariableDeclarationList(initializer) ||
                initializer.declarations.length !== 1 ||
                !ts.isIdentifier(initializer.declarations[0]!.name)
            ) {
                this.fail(statement, "for-of initializer");
            }
            const element = initializer.declarations[0]!.name.getText(
                this.file,
            );
            const iterated = statement.expression.getText(this.file);
            const resolved = this.scope.forOf?.(iterated, element);
            if (!resolved) {
                this.fail(
                    statement,
                    `for-of over '${iterated}'`,
                );
            }
            // The element's bindings live only for the body, so a later
            // loop over a different collection cannot see them.
            return this.withBindings(() => {
                for (const [name, binding] of resolved.bindings) this.scope.bindings.set(name, binding);
                return [
                    `${indent}for (const auto& ${element} : ${resolved.range}) {`,
                    ...this.branch(statement.statement, indent),
                    `${indent}}`,
                ];
            });
        }
        if (ts.isThrowStatement(statement)) {
            const thrown = statement.expression;
            if (
                !ts.isNewExpression(thrown) ||
                !ts.isIdentifier(thrown.expression) ||
                thrown.expression.text !== "Error" ||
                thrown.arguments?.length !== 1 ||
                !ts.isStringLiteral(thrown.arguments[0]!)
            ) {
                this.fail(statement, "throw statement");
            }
            const message = (thrown.arguments[0] as ts.StringLiteral).text;
            return [
                `${indent}throw std::runtime_error(` +
                    `${JSON.stringify(message)});`,
            ];
        }
        if (ts.isReturnStatement(statement)) {
            if (!this.scope.returnValue) {
                if (statement.expression) {
                    this.fail(statement, "return value");
                }
                return [`${indent}return;`];
            }
            // A bare `return;` is the same statement whatever the caller's
            // return contract; the contract still sees it, so a caller
            // that requires a value refuses there.
            if (!statement.expression) {
                this.scope.returnValue(undefined);
                return [`${indent}return;`];
            }
            return [
                `${indent}return ${this.scope.returnValue(statement.expression)};`,
            ];
        }
        if (ts.isBlock(statement)) {
            return [`${indent}{`, ...this.branch(statement, indent), `${indent}}`];
        }
        return this.fail(statement, "statement");
    }

    private branch(statement: ts.Statement, indent: string): string[] {
        const inner = `${indent}    `;
        return this.withBindings(() => ts.isBlock(statement)
            ? this.statements(statement.statements, inner)
            : this.statement(statement, inner));
    }

    /**
     * A statement list, stopped at the first statement that definitely
     * returns. What follows a `return` is unreachable in the pin too; it
     * matters here because a shape test that folded to its returning arm
     * leaves behind the arms for the other shapes, which read members the
     * selected shape does not have.
     */
    public statements(
        list: readonly ts.Statement[],
        indent: string,
    ): string[] {
        const lines: string[] = [];
        for (const statement of list) {
            lines.push(...this.statement(statement, indent));
            if (this.terminates(statement)) break;
        }
        return lines;
    }

    /** Whether control never continues past `statement`. */
    private terminates(statement: ts.Statement): boolean {
        if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
            return true;
        }
        if (ts.isBlock(statement)) {
            const last = statement.statements[statement.statements.length - 1];
            return last !== undefined && this.terminates(last);
        }
        if (ts.isIfStatement(statement)) {
            const known = this.staticCondition(statement.expression);
            if (known === true) return this.terminates(statement.thenStatement);
            if (known === false) {
                return statement.elseStatement !== undefined &&
                    this.terminates(statement.elseStatement);
            }
            return (
                statement.elseStatement !== undefined &&
                this.terminates(statement.thenStatement) &&
                this.terminates(statement.elseStatement)
            );
        }
        return false;
    }

    private loopVariable(list: ts.VariableDeclarationList): string {
        if (!list.declarations.length) this.fail(list, "for initializer");
        return list.declarations.map((declaration,index) => {
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
                this.fail(declaration, "for initializer");
            return this.declaredLoopVariable(declaration.name.text,declaration.initializer,index===0);
        }).join(", ");
    }

    /** `for (<name> = <initial>; ...)`, whichever spelling declared it. */
    private declaredLoopVariable(
        name: string,
        initial: ts.Expression,
        declareType = true,
    ): string {
        const cpp = this.localName(name);
        const value = this.expression(initial);
        this.scope.bindings.set(name, { cpp, type: "index" });
        return (
            `${declareType ? "std::int64_t " : ""}${cpp} = ` +
            `static_cast<std::int64_t>(${value})`
        );
    }

    /**
     * A `let x: number;` hoisted above the loops that own it.
     *
     * `createCapsuleData` declares `x` and `y` once and then writes
     * `for (y = 0; ...)` four times -- the same loop variable the rest of
     * the family spells `for (let y = 0; ...)`, hoisted because two of
     * those loops sit at the same level. Where every reference to the name
     * lies inside a `for` whose own initializer assigns it, the hoisted
     * declaration carries no value that outlives a loop, so it declares
     * nothing here and each `for` declares its own index -- the same C++
     * the inline spelling produces. A name read or written anywhere else
     * keeps the ordinary zeroed local, because there the hoisting is what
     * the body means.
     */
    private hoistedLoopVariable(
        declaration: ts.VariableDeclaration,
        name: string,
    ): boolean {
        const owner = ts.findAncestor(
            declaration,
            (node) =>
                ts.isFunctionDeclaration(node) ||
                ts.isFunctionExpression(node) ||
                ts.isArrowFunction(node) ||
                ts.isMethodDeclaration(node) ||
                ts.isSourceFile(node),
        );
        if (!owner) return false;
        const initializes = (node: ts.Node): boolean => {
            if (!ts.isForStatement(node)) return false;
            const initializer = node.initializer;
            return (
                initializer !== undefined &&
                ts.isBinaryExpression(initializer) &&
                initializer.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken &&
                ts.isIdentifier(initializer.left) &&
                initializer.left.text === name
            );
        };
        let owned = true;
        let references = 0;
        const visit = (node: ts.Node): void => {
            if (!owned) return;
            if (
                ts.isIdentifier(node) &&
                node.text === name &&
                node !== declaration.name
            ) {
                references += 1;
                if (
                    !ts.findAncestor(node, (ancestor) =>
                        ancestor === owner ? "quit" : initializes(ancestor),
                    )
                ) {
                    owned = false;
                }
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(owner);
        return owned && references > 0;
    }

    private declarations(
        list: ts.VariableDeclarationList,
        indent: string,
    ): string[] {
        const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
        const lines: string[] = [];
        for (const declaration of list.declarations) {
            // `const { width, height } = f(...)` -- the one destructuring the
            // pinned bodies use, bound field by field off a named temporary.
            if (ts.isObjectBindingPattern(declaration.name)) {
                if (!declaration.initializer) {
                    this.fail(declaration, "binding pattern");
                }
                const temporary = this.temporaryName(
                    declaration,
                    lines.length,
                );
                lines.push(
                    `${indent}const auto ${temporary} = ` +
                        `${this.expression(declaration.initializer)};`,
                );
                for (const element of declaration.name.elements) {
                    if (
                        !ts.isIdentifier(element.name) ||
                        element.propertyName ||
                        element.dotDotDotToken
                    ) {
                        this.fail(element, "binding element");
                    }
                    const name = element.name.text;
                    this.scope.bindings.set(name, {
                        cpp: `${temporary}.${name}`,
                        type: "scalar",
                    });
                }
                continue;
            }
            // `const [x, y, z] = f(...)` -- the tuple twin of the object
            // destructuring above, bound element by element off a named
            // temporary. Only a call the caller declared tuple-valued
            // qualifies: without that the initializer is a number and the
            // indexing below would be nonsense, so an undeclared callee
            // fails here rather than emitting it.
            if (ts.isArrayBindingPattern(declaration.name)) {
                const initializer = declaration.initializer
                    ? unwrapExpression(declaration.initializer)
                    : undefined;
                const callee =
                    initializer &&
                    ts.isCallExpression(initializer) &&
                    ts.isIdentifier(initializer.expression)
                        ? initializer.expression.text
                        : undefined;
                const arity = callee
                    ? this.scope.tupleCalls?.get(callee)
                    : undefined;
                if (arity === undefined) {
                    this.fail(declaration, "tuple binding pattern");
                }
                if (declaration.name.elements.length !== arity) {
                    this.fail(
                        declaration,
                        `tuple binding of ${declaration.name.elements.length}` +
                            ` from a ${arity}-element call`,
                    );
                }
                const temporary = this.temporaryName(
                    declaration,
                    lines.length,
                );
                lines.push(
                    `${indent}const auto ${temporary} = ` +
                        `${this.expression(declaration.initializer!)};`,
                );
                declaration.name.elements.forEach((element, index) => {
                    if (
                        ts.isOmittedExpression(element) ||
                        !ts.isIdentifier(element.name) ||
                        element.propertyName ||
                        element.dotDotDotToken
                    ) {
                        this.fail(declaration, "tuple binding element");
                    }
                    this.scope.bindings.set(element.name.text, {
                        cpp: `${temporary}[${index}]`,
                        type: "scalar",
                    });
                });
                continue;
            }
            // `const q = f(...)` where the caller declared `f` record-valued,
            // and `const q = f(...).member` where it declared the member: the
            // temporary carries the record and each member the caller listed
            // binds through it, so a later `q.x` resolves by its own text the
            // way every other bound path does.
            if (
                ts.isIdentifier(declaration.name) &&
                declaration.initializer &&
                this.scope.recordCalls
            ) {
                const bound = this.recordCallBinding(
                    declaration.name.text,
                    declaration.initializer,
                    indent,
                    lines.length,
                );
                if (bound) {
                    lines.push(...bound);
                    continue;
                }
            }
            if (!ts.isIdentifier(declaration.name)) {
                this.fail(declaration, "declaration");
            }
            const name = declaration.name.text;
            // A local the CALLER bound is one generation resolved: a
            // compile-time option selection, or a table row picked before
            // the body runs. Re-emitting the pin's own statement for it
            // would either recompute what is already decided or need every
            // shape that statement reaches; taking the binding is the same
            // specialization a resolved `??` takes.
            //
            // Tested against the names the caller supplied rather than
            // against what is bound NOW, because a body may declare the
            // same name twice in two scopes -- `computeNormals` has two
            // `let len` -- and the second is a declaration, not a
            // resolution.
            if (this.callerBindings.has(name)) {
                continue;
            }
            const cpp = this.localName(name);
            if (!declaration.initializer) {
                // A loop variable the pin hoisted above its `for`s owns no
                // storage outside them, so the loops declare it instead.
                if (this.hoistedLoopVariable(declaration, name)) {
                    continue;
                }
                // `let key: number;` assigned on both arms of an if. Zeroed
                // rather than left indeterminate so the emitted C++ stays
                // warning-clean; every reached path writes it first. A
                // `let v1: Vec3;` is the same statement over the pin's own
                // record, and its annotation is the only place that says so.
                const annotation = declaration.type;
                const record =
                    annotation !== undefined
                        ? recordTypeOfAnnotation(annotation)
                        : undefined;
                this.scope.bindings.set(name, {
                    cpp,
                    type: record ?? "scalar",
                });
                lines.push(
                    record
                        ? `${indent}${RECORD_SHAPES.get(record)!.storage} ${cpp}{};`
                        : `${indent}double ${cpp} = 0.0;`,
                );
                continue;
            }
            const specialized = this.specializedDeclaration(
                declaration,
                name,
                cpp,
                isConst,
                indent,
            );
            if (Array.isArray(specialized)) {
                lines.push(...specialized);
                continue;
            }
            // A conditional whose arm generation selected declares that
            // arm through every ordinary path below.
            const source: ts.Expression = specialized ?? declaration.initializer;
            // `const counts = scratch[1]` -- an alias for a buffer the
            // caller pre-registered under the initializer's own text. Bound
            // to the same storage rather than copied, which is what the pin
            // means and what keeps the stores visible to the caller. Only a
            // BUFFER aliases: a scalar initializer that names another local
            // (`let rz = fx`) copies the number the way JavaScript does --
            // aliasing it would leak a later mutation into the original.
            // A `??` whose left side is the bound buffer and whose right
            // side is a CONSTANT array aliases the buffer: taking the
            // present arm is the same specialization the `??` expression
            // itself makes (`const boundMin = mesh.boundMin ?? [...]`).
            // A `??` over an allocation (`out ?? new F32(16)`) means the
            // opposite -- allocate when absent -- so it is left alone.
            const aliasSource = unwrapExpression(source);
            const aliasKey =
                ts.isBinaryExpression(aliasSource) &&
                aliasSource.operatorToken.kind ===
                    ts.SyntaxKind.QuestionQuestionToken &&
                ts.isArrayLiteralExpression(unwrapExpression(aliasSource.right))
                    ? unwrapExpression(aliasSource.left).getText(this.file)
                    // The UNWRAPPED text: `const mi = info.pickedMesh as
                    // Mesh | undefined` names the same binding the read
                    // beside it does, and keeping the assertion in the key
                    // would miss it and copy a nullable into a double.
                    : aliasSource.getText(this.file);
            const alias = this.scope.bindings.get(aliasKey);
            // A binding the caller declared NULLABLE aliases for the same
            // reason a buffer does: `const ray = info.ray` names the same
            // optional, and copying it into a double would lose both its
            // presence test and the members the body reads off it.
            // A fixed f64 scratch, a per-particle step list, an opaque
            // record and the pin's positional records alias for the same
            // reason a buffer does: `const age = buffer.age` and
            // `const leftColor = a as Color4` name storage the body then
            // reads and writes in place.
            if (
                alias &&
                (alias.type === "f32" ||
                    alias.type === "u32" ||
                    alias.type === "u8" ||
                    alias.type === "f32-view" ||
                    alias.type === "u8-view" ||
                    alias.type === "f64-buffer" ||
                    alias.type === "function-list" ||
                    alias.type === "opaque" ||
                    isRecordType(alias.type) ||
                    alias.absentCpp !== undefined)
            ) {
                if (alias.materializeAlias) {
                    if (!isConst) this.fail(declaration, "mutable getter alias binding");
                    const { materializeAlias: _materializeAlias, ...value } = alias;
                    lines.push(`${indent}auto&& ${cpp} = ${alias.cpp};`);
                    this.scope.bindings.set(name, { ...value, cpp });
                } else {
                    this.scope.bindings.set(name, alias);
                }
                // An opaque record's members are bound by their dotted
                // text, so the alias carries every member path the
                // original had: `const buffer = system.buffer` makes
                // `buffer.age` the binding `system.buffer.age` was.
                if (alias.type === "opaque") {
                    const prefix = `${aliasKey}.`;
                    const members: Array<[string, PinnedBinding]> = [];
                    for (const [key, member] of this.scope.bindings) {
                        if (key.startsWith(prefix)) {
                            members.push([key.slice(prefix.length), member]);
                        }
                    }
                    for (const [member, binding] of members) {
                        this.scope.bindings.set(`${name}.${member}`, binding);
                    }
                }
                continue;
            }
            // `const positions: number[] = []` -- a list the builder grows
            // with `push`. The pin holds numbers at double width and rounds
            // only at the `new F32(list)` that ends the builder, so the
            // storage is double and the rounding stays where the pin put
            // it. WHICH list it is comes from the declaration's own type
            // annotation, which is the only place an empty literal says.
            const emptyList = unwrapExpression(source);
            if (
                ts.isArrayLiteralExpression(emptyList) &&
                emptyList.elements.length === 0
            ) {
                const shape = this.declaredListType(declaration);
                this.scope.bindings.set(name, { cpp, type: shape });
                lines.push(
                    `${indent}${listStorage(shape)!} ${cpp};`,
                );
                continue;
            }
            // `let pathArray = options.pathArray` -- a mutable copy of a
            // list the caller owns. A `const` would alias, but the pin
            // reseats this one, so it copies the way JavaScript's own
            // assignment of the reference then reassignment does.
            const listSource = this.scope.bindings.get(
                unwrapExpression(source).getText(this.file),
            );
            if (listSource && isListShape(listSource.type)) {
                this.scope.bindings.set(name, {
                    cpp,
                    type: listSource.type,
                });
                lines.push(
                    `${indent}${listStorage(listSource.type)!} ` +
                        `${cpp} = ${listSource.cpp};`,
                );
                continue;
            }
            // `const face = data.face[f]` -- one ROW of a jagged list, or
            // one POINT of a path. Bound to the element's own storage
            // rather than copied, because the pin reads it and never
            // reseats it.
            const rowSource = unwrapExpression(source);
            if (ts.isElementAccessExpression(rowSource)) {
                const element = this.elementBinding(rowSource);
                if (element) {
                    this.scope.bindings.set(name, element);
                    continue;
                }
            }
            // `const path = (p === n ? rows[0] : rows[p])!` -- the row a
            // ternary picks. Bound by REFERENCE so the choice is made once
            // and the row is still the list's own storage.
            if (ts.isConditionalExpression(rowSource)) {
                const chosen = [
                    rowSource.whenTrue,
                    rowSource.whenFalse,
                ].map((branch) => {
                    const access = unwrapExpression(branch);
                    return ts.isElementAccessExpression(access)
                        ? elementType(this.elementOwner(access)?.type ?? "scalar")
                        : undefined;
                });
                const shape = chosen[0];
                if (
                    shape &&
                    chosen[1] === shape &&
                    isListShape(shape)
                ) {
                    this.scope.bindings.set(name, {
                        cpp,
                        type: shape,
                    });
                    lines.push(
                        `${indent}const ${listStorage(shape)!}& ` +
                            `${cpp} = ` +
                            `${this.expression(source)};`,
                    );
                    continue;
                }
            }
            const allocation = this.allocation(source);
            if (allocation) {
                this.scope.bindings.set(name, {
                    cpp,
                    type: allocation.type,
                    ...(allocation.bytesCpp
                        ? { bytesCpp: allocation.bytesCpp }
                        : {}),
                    ...(allocation.mutable ? { mutable: true as const } : {}),
                });
                lines.push(`${indent}${allocation.declare(cpp)}`);
                continue;
            }
            const initializer = unwrapExpression(source);
            if (this.scope.vec3Literal && ts.isObjectLiteralExpression(initializer)) {
                const value = this.expression(initializer);
                this.scope.bindings.set(name, { cpp, type: "vec3" });
                lines.push(`${indent}${isConst ? "const " : ""}Vec3d ${cpp} = ${value};`);
                continue;
            }
            if (ts.isCallExpression(initializer) &&
                this.scope.nullableMatrixCalls?.has(initializer.expression.getText(this.file))) {
                this.scope.bindings.set(name, {
                    cpp: `(*${cpp})`, type: "f32", absentCpp: `!${cpp}.has_value()`,
                });
                lines.push(`${indent}${isConst ? "const " : ""}auto ${cpp} = ${this.expression(source)};`);
                continue;
            }
            // A call the caller declared matrix-valued binds the fixed
            // matrix, so a later element read indexes it rather than
            // indexing a double.
            if (
                this.scope.matrixCalls &&
                ts.isCallExpression(initializer) &&
                this.scope.matrixCalls.has(initializer.expression.getText(this.file))
            ) {
                this.scope.bindings.set(name, { cpp, type: "f32" });
                lines.push(
                    `${indent}${isConst ? "const " : ""}` +
                        `std::array<float, 16> ${cpp} = ` +
                        `${this.expression(source)};`,
                );
                continue;
            }
            const fixedTupleArity =
                this.scope.fixedTupleCalls &&
                    ts.isCallExpression(initializer) &&
                    ts.isIdentifier(initializer.expression)
                    ? this.scope.fixedTupleCalls.get(
                        initializer.expression.text,
                    )
                    : undefined;
            if (fixedTupleArity !== undefined) {
                this.scope.bindings.set(name, {
                    cpp,
                    type: "f64-buffer",
                });
                lines.push(
                    `${indent}${isConst ? "const " : ""}` +
                        `std::array<double, ${fixedTupleArity}> ${cpp} = ` +
                        `${this.expression(source)};`,
                );
                continue;
            }
            if (
                this.scope.listCalls &&
                ts.isCallExpression(initializer) &&
                ts.isIdentifier(initializer.expression) &&
                this.scope.listCalls.has(initializer.expression.text)
            ) {
                this.scope.bindings.set(name, {
                    cpp,
                    type: "f64-list",
                });
                // Never `const`: a JavaScript `const` binds the list, not
                // its contents, and the pinned ribbon writes through
                // exactly such a binding.
                lines.push(
                    `${indent}std::vector<double> ${cpp} = ` +
                        `${this.expression(source)};`,
                );
                continue;
            }
            const isBoolean =
                initializer.kind === ts.SyntaxKind.TrueKeyword ||
                initializer.kind === ts.SyntaxKind.FalseKeyword;
            const value = this.expression(source);
            this.scope.bindings.set(name, {
                cpp,
                type: isBoolean ? "bool" : "scalar",
            });
            lines.push(
                `${indent}${
                    isConst && this.scope.maybeUnusedConst
                        ? "[[maybe_unused]] const "
                        : isConst
                          ? "const "
                          : ""
                }` +
                    `${isBoolean ? "bool" : "double"} ${cpp} = ${value};`,
            );
        }
        return lines;
    }

    /**
     * `new F32(n)` / `new U32(n)` allocate; `new U8(buffer)` / `new F32(buffer)`
     * alias. The pin distinguishes them by argument, and so does this.
     */
    private allocation(
        initializer: ts.Expression,
    ):
        | {
              type: PinnedBinding["type"];
              bytesCpp?: string;
              mutable?: true;
              declare: (name: string) => string;
          }
        | undefined {
        if (
            !ts.isNewExpression(initializer) ||
            !ts.isIdentifier(initializer.expression) ||
            initializer.arguments?.length !== 1
        ) {
            return undefined;
        }
        const sourceConstructor = initializer.expression.text;
        const constructor = TYPED_ARRAY_CONVERSIONS.get(sourceConstructor)?.type.toUpperCase() ?? sourceConstructor;
        const argument = initializer.arguments[0]!;
        // Pinned uniform writers also construct a small typed tuple directly.
        // Keep its allocation fixed and round at each authored f32 store.
        if (constructor === "F32" &&
            ts.isArrayLiteralExpression(argument)) {
            const values = argument.elements.map((element) =>
                `static_cast<float>(${this.expression(element)})`);
            return {
                type: "f32",
                declare: (name) => `std::array<float, ${values.length}> ${name}{${values.join(", ")}};`,
            };
        }
        // `new U8(buffer)` / `new F32(buffer)` re-view an existing byte
        // buffer; the same constructors over a COUNT allocate.
        const named = unwrapExpression(argument);
        const source = ts.isIdentifier(named)
            ? this.scope.bindings.get(named.text)
            : undefined;
        if (source?.type === "u8-view") {
            if (constructor !== "U8" && constructor !== "F32") {
                return undefined;
            }
            const element = constructor === "U8" ? "std::uint8_t" : "float";
            // A view inherits the source buffer's mutability: the pin builds
            // both of `bakeTransformIntoVertices`'s views over one buffer it
            // then writes through, so a `const` view here would refuse the
            // store the fold exists to perform.
            const qualifier = source.mutable ? "" : "const ";
            return {
                type: constructor === "U8" ? "u8-view" : "f32-view",
                ...(source.bytesCpp ? { bytesCpp: source.bytesCpp } : {}),
                ...(source.mutable ? { mutable: true as const } : {}),
                declare: (name) =>
                    `${qualifier}${element}* ${name} = ` +
                    `reinterpret_cast<${qualifier}${element}*>(${source.cpp});`,
            };
        }
        // `new F32(list)` over a grown `number[]` is the pin's own rounding
        // boundary: the list carried doubles, and this is where each one
        // becomes a float (or an index becomes a u32). Emitted as an
        // element-wise convert rather than a resize-and-copy so the cast is
        // visible at exactly the position the pin performs it.
        if (source && isListShape(source.type)) {
            const conversion = this.listConversion(initializer);
            // Which width the conversion produced comes from the same table
            // that chose it, so the two spellings of one constructor cannot
            // disagree about the store width they mean.
            const width = TYPED_ARRAY_CONVERSIONS.get(constructor)?.type;
            return conversion === undefined || width === undefined
                ? undefined
                : {
                      type: width,
                      declare: (name) =>
                          `auto ${name} = ${conversion};`,
                  };
        }
        // `new F32(otherTypedArray)` COPIES it; only `new F32(count)`
        // allocates. Reading the argument as a length would compile and
        // produce a differently-sized buffer of zeros -- the pin's
        // `biasViewProjection` starts from a copy of the matrix it biases,
        // which that reading would silently turn into zeros. The copy takes
        // the source's own storage, so a fixed-length source stays fixed.
        if (
            source &&
            (source.type === "f32" || source.type === "f32-view") &&
            constructor === "F32"
        ) {
            return {
                type: "f32",
                declare: (name) => `auto ${name} = ${source.cpp};`,
            };
        }
        // A constant length is a constant length: `new F32(16)` is a fixed
        // matrix or vector, not a run-time sized buffer, so it allocates
        // nothing. The two shapes zero-initialize and store identically,
        // which is what keeps this a storage choice rather than a
        // behavioural one.
        const literal = ts.isNumericLiteral(unwrapExpression(argument))
            ? Number((unwrapExpression(argument) as ts.NumericLiteral).text)
            : undefined;
        const fixed = literal !== undefined && Number.isInteger(literal) &&
                literal > 0
            ? literal
            : undefined;
        const count = this.expression(argument);
        if (constructor === "F32") {
            return {
                type: "f32",
                declare: (name) =>
                    fixed !== undefined
                        ? `std::array<float, ${fixed}> ${name}{};`
                        : `std::vector<float> ${name}(` +
                            `static_cast<std::size_t>(${count}), 0.0f);`,
            };
        }
        if (constructor === "U32") {
            return {
                type: "u32",
                declare: (name) =>
                    fixed !== undefined
                        ? `std::array<std::uint32_t, ${fixed}> ${name}{};`
                        : `std::vector<std::uint32_t> ${name}(` +
                            `static_cast<std::size_t>(${count}), 0u);`,
            };
        }
        // `new U8(n)` over a COUNT: the pin's own zeroed byte scratch, which
        // the SH payload packer fills a texel at a time. The aliasing form
        // (`new U8(buffer)`) was taken by the branch above; only a length
        // reaches here, and the zero fill is what a texture wider than the
        // splats it carries relies on.
        if (constructor === "U8") {
            return {
                type: "u8",
                declare: (name) =>
                    fixed !== undefined
                        ? `std::array<std::uint8_t, ${fixed}> ${name}{};`
                        : `std::vector<std::uint8_t> ${name}(` +
                            `static_cast<std::size_t>(${count}), 0u);`,
            };
        }
        // `new F64(n)` and `new Array<number>(n)` are the pin's own
        // full-width scratch: a zeroed buffer it indexes rather than grows,
        // and one whose stores round nowhere. It shares the growable list's
        // element type for exactly that reason.
        if (constructor === "F64" || constructor === "Array") {
            return {
                type: "f64-buffer",
                declare: (name) =>
                    `std::vector<double> ${name}(` +
                    `static_cast<std::size_t>(${count}), 0.0);`,
            };
        }
        return undefined;
    }

    private expressionStatement(expression: ts.Expression): string {
        if (ts.isBinaryExpression(expression)) {
            // `indices = indices.reverse()`: the method the caller declared
            // receiver-returning already IS the store, so the assignment
            // around it is the identity and only the mutation is emitted.
            const inPlace = this.inPlaceSelfStore(expression);
            if (inPlace) return inPlace;
            const operator = PINNED_ASSIGNMENT_OPERATORS.get(
                expression.operatorToken.kind,
            );
            if (operator) {
                const target = unwrapExpression(expression.left);
                const owner = ts.isElementAccessExpression(target) ? this.elementOwner(target) : undefined;
                if (owner?.indexedStore && ts.isElementAccessExpression(target)) {
                    if (operator !== "=") this.fail(expression, "compound assignment through an indexed store adapter");
                    return owner.indexedStore(owner.cpp, this.expression(target.argumentExpression), this.expression(expression.right));
                }
                return (
                    `${this.assignmentTarget(expression.left)} ${operator} ` +
                    `${this.storedValue(expression.left, expression.right)}`
                );
            }
        }
        if (
            ts.isPostfixUnaryExpression(expression) ||
            ts.isPrefixUnaryExpression(expression)
        ) {
            const operator =
                expression.operator === ts.SyntaxKind.PlusPlusToken
                    ? "++"
                    : expression.operator === ts.SyntaxKind.MinusMinusToken
                      ? "--"
                      : undefined;
            if (operator) {
                return `${this.assignmentTarget(expression.operand)}${operator}`;
            }
        }
        if (ts.isCallExpression(expression)) {
            return this.expression(expression);
        }
        return this.fail(expression, "expression statement");
    }

    /**
     * `a = a.m(...)` where `m` mutates `a` and returns it.
     *
     * Only a store back over the method's OWN receiver qualifies: the
     * identity the caller declared is "returns the receiver", so a store
     * anywhere else would drop a value that still has somewhere to go and
     * is left to the ordinary assignment path.
     */
    private inPlaceSelfStore(
        expression: ts.BinaryExpression,
    ): string | undefined {
        if (
            expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
            !this.scope.receiverReturningMethods
        ) {
            return undefined;
        }
        const call = unwrapExpression(expression.right);
        if (
            !ts.isCallExpression(call) ||
            !ts.isPropertyAccessExpression(call.expression) ||
            !this.scope.receiverReturningMethods.has(
                call.expression.name.text,
            )
        ) {
            return undefined;
        }
        const receiver = unwrapExpression(
            call.expression.expression,
        ).getText(this.file);
        if (receiver !== unwrapExpression(expression.left).getText(this.file)) {
            return undefined;
        }
        return this.expression(call);
    }

    /**
     * The declarations a graph-specialized body makes that generation has
     * already decided: the lines to emit, the initializer the ordinary
     * paths should continue with, or undefined for one they own outright.
     *
     *  - A boolean the body computes from a shape test binds the answer
     *    and emits nothing (`const aScalar = typeof a === "number"`).
     *  - A conditional whose condition is decided declares its selected
     *    arm: `null` binds an absent record; a record or buffer aliases;
     *    anything else is the ordinary declaration of that arm, which the
     *    caller performs over the arm returned here.
     *  - A call the caller declared record-valued declares the record it
     *    returns (`const min = minGetter(i)`).
     */
    private specializedDeclaration(
        declaration: ts.VariableDeclaration,
        name: string,
        cpp: string,
        isConst: boolean,
        indent: string,
    ): string[] | ts.Expression | undefined {
        let initializer = unwrapExpression(declaration.initializer!);
        // Only a boolean-shaped initializer is a candidate: a record in
        // value position is truthy too, but `const c = colorGetter(i)`
        // declares the record, not the fact that it is there.
        const booleanShaped =
            (ts.isPrefixUnaryExpression(initializer) &&
                initializer.operator === ts.SyntaxKind.ExclamationToken) ||
            (ts.isBinaryExpression(initializer) &&
                !PINNED_ARITHMETIC_OPERATORS.has(
                    initializer.operatorToken.kind,
                ) &&
                initializer.operatorToken.kind !==
                    ts.SyntaxKind.QuestionQuestionToken);
        const known = booleanShaped
            ? this.staticCondition(initializer)
            : undefined;
        if (known !== undefined) {
            this.scope.bindings.set(name, {
                cpp: known ? "true" : "false",
                type: "bool",
                staticBoolean: known,
            });
            return [];
        }
        while (ts.isConditionalExpression(initializer)) {
            const chosen = this.staticCondition(initializer.condition);
            if (chosen === undefined) return undefined;
            initializer = unwrapExpression(
                chosen ? initializer.whenTrue : initializer.whenFalse,
            );
        }
        if (initializer.kind === ts.SyntaxKind.NullKeyword) {
            this.scope.bindings.set(name, absentBinding());
            return [];
        }
        const source = this.scope.bindings.get(initializer.getText(this.file));
        if (source && (isRecordType(source.type) || source.staticallyAbsent)) {
            this.scope.bindings.set(name, source);
            return [];
        }
        if (ts.isCallExpression(initializer)) {
            const shape = callShapeOf(this.scope.callShapes, initializer, this.file);
            if (shape === "f32" || shape === "f64-buffer") {
                if (!isConst) this.fail(declaration, "mutable buffer call binding");
                this.scope.bindings.set(name, { cpp, type: shape });
                return [`${indent}auto&& ${cpp} = ${this.expression(initializer)};`];
            }
            if (shape && isRecordType(shape)) {
                this.scope.bindings.set(name, { cpp, type: shape });
                return [
                    `${indent}${isConst ? "const " : ""}` +
                        `${RECORD_SHAPES.get(shape)!.storage} ${cpp} = ` +
                        `${this.expression(initializer)};`,
                ];
            }
        }
        return initializer === unwrapExpression(declaration.initializer!)
            ? undefined
            : initializer;
    }

    /**
     * The right-hand side of a store, cast to the array's element width where
     * the pin's own store would round. Every other value stays f64.
     */
    private storedValue(
        target: ts.Expression,
        value: ts.Expression,
    ): string {
        const unwrapped = unwrapExpression(target);
        const literal = unwrapExpression(value);
        const binding = ts.isIdentifier(unwrapped)
            ? this.scope.bindings.get(unwrapped.text)
            : undefined;
        // Rebinding a FIXED tuple to a literal of its own shape --
        // `localNormal = [-localNormal[0], ...]` after the facing test
        // flipped it. The storage is the `std::array<double, N>` the
        // caller's arity declared, so the literal stays a braced
        // initializer instead of becoming the growable list an untyped
        // array literal is everywhere else. Taken before the value is
        // translated, because that translation is what would type it.
        if (
            binding?.type === "f64-buffer" &&
            ts.isArrayLiteralExpression(literal)
        ) {
            return `{${literal.elements
                .map((element) => this.expression(element))
                .join(", ")}}`;
        }
        const text = this.expression(value);
        if (binding?.type === "index") {
            return `static_cast<std::int64_t>(${text})`;
        }
        if (binding?.type === "scalar" && ts.isIdentifier(literal) &&
            this.scope.bindings.get(literal.text)?.type === "index") {
            return `static_cast<double>(${text})`;
        }
        const element = this.elementType(target);
        if (element === "float") return `static_cast<float>(${text})`;
        if (element === "std::uint32_t") {
            return `static_cast<std::uint32_t>(${text})`;
        }
        // A `Uint8Array` store is ECMAScript ToUint8, which truncates toward
        // zero and then wraps modulo 256. A `static_cast` agrees inside the
        // range and is undefined outside it, so the conversion is the spec's
        // rather than the language's.
        if (element === "std::uint8_t") return `bbl::js::to_uint8(${text})`;
        return text;
    }

    /**
     * `new F32(list)` / `new U32(list)` over a grown `number[]`.
     *
     * The pin's own rounding boundary: the list carried doubles, and this
     * is where each one becomes a float (or an index a u32).
     */
    private listConversion(node: ts.NewExpression): string | undefined {
        if (
            !ts.isIdentifier(node.expression) ||
            node.arguments?.length !== 1
        ) {
            return undefined;
        }
        const argument = unwrapExpression(node.arguments[0]!);
        if (!ts.isIdentifier(argument)) return undefined;
        const source = this.scope.bindings.get(argument.text);
        if (source?.type !== "f64-list") return undefined;
        // `bbl::js::f32_array_from` / `u32_array_from` are the pin's own
        // conversions rather than a C++ cast: the u32 one applies
        // ECMAScript ToUint32, which WRAPS a negative where a
        // `static_cast` would be undefined behaviour.
        const spelling = TYPED_ARRAY_CONVERSIONS.get(
            node.expression.text,
        );
        return spelling === undefined
            ? undefined
            : `bbl::js::${spelling.conversion}(${source.cpp})`;
    }

    /** `const f = (a, b) => { ... }` — a void helper the body calls. */
    private localHelper(
        list: ts.VariableDeclarationList,
    ): { name: string; arrow: ts.ArrowFunction } | undefined {
        if (list.declarations.length !== 1) return undefined;
        const declaration = list.declarations[0]!;
        if (
            !ts.isIdentifier(declaration.name) ||
            !declaration.initializer
        ) {
            return undefined;
        }
        const initializer = unwrapExpression(declaration.initializer);
        return ts.isArrowFunction(initializer) &&
            ts.isBlock(initializer.body)
            ? { name: declaration.name.text, arrow: initializer }
            : undefined;
    }

    /**
     * One call to a recorded helper, with its body written out here.
     *
     * The helper mutates what it closed over, so it has no return value to
     * carry and nothing to bind but its parameters. Each parameter binds to
     * the ARGUMENT's lowered expression, which for the pin's own calls is a
     * literal -- so a `isTop ? 1 : -1` inside folds the way it would have
     * folded had the pin written the two bodies out.
     *
     * An early `return` in the helper becomes a `break` out of a one-pass
     * loop, which is the shape that keeps the rest of the body skipped
     * without inventing control flow the pin does not have.
     */
    private inlinedHelperCall(
        expression: ts.Expression,
        indent: string,
    ): string[] | undefined {
        const node = unwrapExpression(expression);
        if (!ts.isCallExpression(node)) return undefined;
        const callee = unwrapExpression(node.expression);
        if (!ts.isIdentifier(callee)) return undefined;
        const arrow = this.helpers.get(callee.text);
        if (!arrow || !ts.isBlock(arrow.body)) return undefined;
        if (arrow.parameters.length !== node.arguments.length) {
            this.fail(node, `helper '${callee.text}' arity`);
        }
        const parameters = arrow.parameters.map((parameter, index): [string, PinnedBinding] => {
            if (!ts.isIdentifier(parameter.name)) {
                this.fail(parameter, "helper parameter");
            }
            const argument = node.arguments[index]!;
            const unwrapped = unwrapExpression(argument);
            const isBoolean =
                unwrapped.kind === ts.SyntaxKind.TrueKeyword ||
                unwrapped.kind === ts.SyntaxKind.FalseKeyword;
            return [parameter.name.text, {
                cpp: this.expression(argument),
                type: isBoolean ? "bool" : "scalar",
            }];
        });
        // A `return` anywhere in the helper -- the pin's own
        // `if (radius === 0) { return; }` guard sits inside an `if` -- ends
        // that call and nothing else, so the whole inlined body goes in a
        // one-pass loop and each return becomes a `break`.
        let guarded = false;
        const findReturn = (inner: ts.Node): void => {
            if (ts.isReturnStatement(inner)) guarded = true;
            if (!guarded) ts.forEachChild(inner, findReturn);
        };
        findReturn(arrow.body);
        const inner = `${indent}    `;
        const body = arrow.body;
        const lines = this.withBindings(() => {
            for (const [name, binding] of parameters) this.scope.bindings.set(name, binding);
            this.inlining += 1;
            try {
                return body.statements.flatMap((nested) => this.statement(nested, inner));
            } finally { this.inlining -= 1; }
        });
        const header =
            `${indent}// ${callee.text}(${node.arguments
                .map((argument) => argument.getText(this.file))
                .join(", ")})`;
        return guarded
            ? [
                  header,
                  `${indent}for (int pass = 0; pass < 1; ++pass) {`,
                  ...lines,
                  `${indent}}`,
              ]
            : [header, `${indent}{`, ...lines, `${indent}}`];
    }

    /**
     * A lowered condition, without the parentheses the expression printer
     * wraps every binary in.
     *
     * `if ((a == b))` is what a fully-parenthesized printer produces and
     * what `-Wparentheses-equality` refuses, so the one enclosing pair is
     * dropped where the statement supplies its own.
     */
    private condition(expression: ts.Expression): string {
        const known = this.staticCondition(expression);
        if (known !== undefined) return known ? "true" : "false";
        const absent = this.absenceTest(expression);
        if (absent !== undefined) return `!(${absent})`;
        return cppCondition(this.expression(expression));
    }

    /**
     * Which list an empty literal declares, from its own type annotation.
     *
     * `const positions: number[] = []` and `const ar1: Vec3[] = []` are the
     * same expression and different storage, and the pin says which in the
     * only place it can. An annotation this port does not know fails by
     * name rather than defaulting to numbers.
     */
    private declaredListType(
        declaration: ts.VariableDeclaration,
    ): PinnedBinding["type"] {
        const annotation = declaration.type;
        if (annotation && ts.isArrayTypeNode(annotation)) {
            const element = annotation.elementType;
            if (recordTypeOfAnnotation(element) === "vec3") return "vec3-list";
            if (element.kind === ts.SyntaxKind.NumberKeyword) {
                return "f64-list";
            }
            if (
                ts.isArrayTypeNode(element) &&
                element.elementType.kind === ts.SyntaxKind.NumberKeyword
            ) {
                return "f64-list-2d";
            }
        }
        return this.fail(declaration, "empty list declaration");
    }

    /**
     * A ROW read in place, as the list it is.
     *
     * `us[p]!.push(...)` and `us[p]![i]` both name a row the caller never
     * bound, and both mean the same list.
     */
    private rowBinding(
        access: ts.ElementAccessExpression,
    ): PinnedBinding | undefined {
        const element = this.elementBinding(access);
        return element && isListShape(element.type) ? element : undefined;
    }

    /**
     * What one element access denotes, when its owner is indexable.
     *
     * A row of a jagged list, a point of a path, a number of a buffer --
     * one rule, because the declaration path, the read path, the `length`
     * path and the `push` receiver all ask it.
     */
    private elementBinding(
        access: ts.ElementAccessExpression,
    ): PinnedBinding | undefined {
        const owner = this.elementOwner(access);
        const type = elementType(owner?.type ?? "scalar");
        return owner && type
            ? { cpp: this.elementAccess(access), type }
            : undefined;
    }

    /**
     * The C++ expression for a `{x, y, z}` record, or undefined.
     *
     * Two spellings reach one: a local the caller or a declaration bound as
     * a record, and an element of a record list read in place.
     */
    private recordValue(
        expression: ts.Expression,
    ): { cpp: string; type: PinnedBinding["type"] } | undefined {
        const node = unwrapExpression(expression);
        if (ts.isIdentifier(node)) {
            const binding = this.scope.bindings.get(node.text);
            return binding && isRecordType(binding.type)
                ? { cpp: binding.cpp, type: binding.type }
                : undefined;
        }
        if (ts.isElementAccessExpression(node)) {
            const owner = this.elementOwner(node);
            return owner?.type === "vec3-list"
                ? { cpp: this.elementAccess(node), type: "vec3" }
                : undefined;
        }
        return undefined;
    }

    /** Capture element references before writes; assignment results retain the original number. */
    private chainedArrayStores(expression: ts.BinaryExpression, indent: string): string[] | undefined {
        const targets: ts.ElementAccessExpression[] = [];
        let value: ts.Expression = expression;
        while (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const target = unwrapExpression(value.left);
            if (!ts.isElementAccessExpression(target) || !this.elementType(target)) return undefined;
            targets.push(target);
            value = unwrapExpression(value.right);
        }
        // Literal fills cannot resize storage or rebind an owner during RHS evaluation.
        if (!ts.isNumericLiteral(value) && !(ts.isPrefixUnaryExpression(value) &&
            [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(value.operator) &&
            ts.isNumericLiteral(value.operand))) return undefined;
        const number = ts.isNumericLiteral(value) ? Number(value.text)
            : (value.operator === ts.SyntaxKind.MinusToken ? -1 : 1) * Number((value.operand as ts.NumericLiteral).text);
        if (targets.some(target => this.elementType(target) === "std::uint32_t") &&
            !(Math.trunc(number) >= 0 && Math.trunc(number) <= 0xffff_ffff)) return undefined;
        const effectFree = (node: ts.Node): boolean => {
            if (ts.isCallExpression(node) || ts.isNewExpression(node) || isUpdateExpression(node) || isAssignmentExpression(node)) return false;
            return !ts.forEachChild(node, child => effectFree(child) ? undefined : true);
        };
        if (targets.some(target => !effectFree(target))) return undefined;
        const references = targets.map((target, index) => ({
            target, name: this.temporaryName(target, index),
        }));
        return [
            ...references.map(({ target, name }) => `${indent}auto& ${name} = ${this.assignmentTarget(target)};`),
            ...references.reverse().map(({ target, name }) => `${indent}${name} = ${this.storedValue(target, value)};`),
        ];
    }

    private elementType(target: ts.Expression): string | undefined {
        if (!ts.isElementAccessExpression(target)) return undefined;
        const binding = this.elementOwner(target);
        if (binding?.type === "f32") return "float";
        if (binding?.type === "u32") return "std::uint32_t";
        if (binding?.type === "u8") return "std::uint8_t";
        // A mutable view rounds at its own element width, exactly as the
        // typed array the pin stores through does. A read-only view never
        // reaches here: `assignmentTarget` refuses the store first.
        if (binding?.mutable) {
            if (binding.type === "f32-view") return "float";
            if (binding.type === "u8-view") return "std::uint8_t";
        }
        return undefined;
    }

    /**
     * The binding an element access indexes.
     *
     * Keyed by the owner's own text, the way `propertyAccess` is, so a
     * member array the pin indexes (`material.uvScale[0]`) resolves through
     * the same registration a bare buffer does. An identifier's text is its
     * name, so this is the identifier lookup widened rather than replaced.
     */
    private elementOwner(
        expression: ts.ElementAccessExpression,
    ): PinnedBinding | undefined {
        const owner = unwrapExpression(expression.expression);
        const named = this.scope.bindings.get(owner.getText(this.file));
        if (named) return named;
        // `us[p]![i]` -- the owner is itself a row, which is a list.
        return ts.isElementAccessExpression(owner)
            ? this.rowBinding(owner)
            : undefined;
    }

    private assignmentTarget(expression: ts.Expression): string {
        const unwrapped = unwrapExpression(expression);
        if (ts.isIdentifier(unwrapped)) {
            const binding = this.scope.bindings.get(unwrapped.text);
            if (!binding) this.fail(unwrapped, "assignment target");
            return binding.cpp;
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            // A member the caller bound, written through. The read path
            // resolves these by their own source text, so the store does
            // too -- a pinned function that mutates the record it was
            // handed writes the same field the reads name, and binding one
            // direction without the other would lower half its body.
            const named = this.scope.bindings.get(
                unwrapped.getText(this.file),
            );
            if (named) return named.cpp;
            // `scratch.x = ...` on one of the pin's positional records: the
            // same member the read path resolves, written.
            const record = this.recordValue(unwrapped.expression);
            if (
                record &&
                RECORD_SHAPES.get(record.type)?.members.includes(
                    unwrapped.name.text,
                )
            ) {
                return `${record.cpp}.${unwrapped.name.text}`;
            }
            return this.fail(unwrapped, "assignment target");
        }
        if (ts.isElementAccessExpression(unwrapped)) {
            // A view the caller did not declare mutable is an alias over
            // someone else's storage, so a store through one is refused
            // here. Leaving it to the emitted `const` would report the same
            // fact as a C++ compile error with no pinned source location.
            const target = this.elementOwner(unwrapped);
            if (target?.indexedStore) this.fail(unwrapped, "reference to an adapted indexed store");
            if (
                target &&
                (target.type === "f32-view" || target.type === "u8-view") &&
                !target.mutable
            ) {
                this.fail(unwrapped, "store through a read-only view");
            }
            // A fixed heterogeneous cell can map to a native record field.
            // Only an explicitly mutable binding names a store destination;
            // ordinary exact read bindings may be constants or expressions.
            const exact = this.scope.bindings.get(unwrapped.getText(this.file));
            if (exact?.mutable) return exact.cpp;
            // Assigning past a list's end EXTENDS it in JavaScript, and the
            // pinned ribbon fills `us[p]` without sizing `us` first. A
            // fixed-size buffer cannot grow and is indexed directly; a list
            // grows to reach the element, which is the array the pin ends
            // up with.
            const owner = this.elementOwner(unwrapped);
            if (owner && isListShape(owner.type)) {
                const index = this.expression(
                    unwrapped.argumentExpression,
                );
                return (
                    `bbl::at_grow(${owner.cpp}, ` +
                    `static_cast<std::size_t>(${index}))`
                );
            }
            return this.elementAccess(unwrapped);
        }
        return this.fail(unwrapped, "assignment target");
    }

    private elementAccess(
        expression: ts.ElementAccessExpression,
    ): string {
        const binding = this.elementOwner(expression);
        if (!binding) this.fail(expression, "element access owner");
        const index = this.expression(expression.argumentExpression);
        return `${binding.cpp}[static_cast<std::size_t>(${index})]`;
    }

    /**
     * A module-scope `const` of the file being lowered, as its own value.
     *
     * `pinned-shader-text.ts` states the rule this follows: a name the
     * module DECLARES is the pin's own text and is read straight off that
     * declaration, and only a name it does not declare — an import, or
     * something the caller owns — has to be supplied through `bindings`. So
     * an unbound identifier resolves here before it fails, which is what
     * lets a pinned body reach its own constants (`extract-highlights.ts`
     * raises its threshold through a module-scope `TO_GAMMA_SPACE`) without
     * every caller pre-binding them.
     *
     * The initializer is LOWERED rather than folded, so the arithmetic
     * stays the pin's; one this translator cannot lower fails by the name
     * that reads it, naming the constant rather than the reader.
     */
    private moduleConstant(name: string): PinnedBinding | undefined {
        const cached = this.moduleConstants.get(name);
        if (cached !== undefined) return cached;
        const initializer = moduleScopeConstant(this.file, name);
        if (!initializer) return undefined;
        // A binding under its own name first, so a constant that names
        // itself recurses no further than one step and fails there.
        this.moduleConstants.set(name, undefined);
        // A literal constant is also a value generation knows, which is
        // what lets a serialized enumerator compare against it at
        // generation (`lockMode === LOCK_PER_PARTICLE`).
        const literal = unwrapExpression(initializer);
        const binding: PinnedBinding = {
            cpp: `(${this.expression(initializer)})`,
            type: "scalar",
            ...(ts.isNumericLiteral(literal)
                ? { staticNumber: Number(literal.text) }
                : {}),
        };
        this.moduleConstants.set(name, binding);
        return binding;
    }

    public expression(expression: ts.Expression): string {
        return this.renderExpression(expression).text;
    }

    public renderExpression(expression: ts.Expression): RenderedCpp {
        if (this.scope.expressionSpelling?.parentheses === "source" && ts.isNonNullExpression(expression)) {
            return this.renderExpression(expression.expression);
        }
        if (this.scope.expressionSpelling?.parentheses === "source" && ts.isParenthesizedExpression(expression)) {
            return cppPrimary(`(${this.expression(expression.expression)})`);
        }
        const node = unwrapExpression(expression);
        const domain = this.scope.expression?.(node, this) ?? this.expressionDomain(node);
        if (domain !== undefined) return typeof domain === "string" ? cppPrimary(domain) : domain;
        return renderPinnedArithmetic(node, child => this.renderExpression(child), this.scope.expressionSpelling)
            ?? this.fail(node, ts.isBinaryExpression(node) ? "binary operator" : "expression");
    }

    protected expressionDomain(node: ts.Expression): string | RenderedCpp | undefined {
        if (ts.isIdentifier(node)) {
            if (node.text === "Infinity") {
                return "std::numeric_limits<double>::infinity()";
            }
            const binding = this.scope.bindings.get(node.text) ??
                this.moduleConstant(node.text);
            if (!binding) this.fail(node, "identifier");
            // A view is a pointer; naming it bare would be an address.
            return binding.cpp;
        }
        if (ts.isPrefixUnaryExpression(node)) {
            // `--buffer.alive` in value position: the pin reads the slot it
            // just released, and both sides mean the decremented value.
            if (
                node.operator === ts.SyntaxKind.PlusPlusToken ||
                node.operator === ts.SyntaxKind.MinusMinusToken
            ) {
                const step =
                    node.operator === ts.SyntaxKind.PlusPlusToken ? "++" : "--";
                return (
                    `static_cast<double>(` +
                    `${step}${this.assignmentTarget(node.operand)})`
                );
            }
            const operator =
                node.operator === ts.SyntaxKind.MinusToken
                    ? "-"
                    : node.operator === ts.SyntaxKind.PlusToken
                      ? "+"
                      : node.operator === ts.SyntaxKind.ExclamationToken
                        ? "!"
                        : undefined;
            if (!operator) this.fail(node, "prefix operator");
            if (operator === "!") {
                const known = this.staticCondition(node);
                if (known !== undefined) return known ? "true" : "false";
                const absent = this.absenceTest(node.operand);
                if (absent) return `(${absent})`;
            }

        }
        // `[ar1, ar2]` -- a list of lists written out. The pin builds one
        // where it splits a single path in two, and each element is
        // already a list this body declared.
        if (
            ts.isArrayLiteralExpression(node) &&
            node.elements.length > 0
        ) {
            const rows = node.elements.map((element) =>
                this.scope.bindings.get(
                    unwrapExpression(element).getText(this.file),
                ),
            );
            const row = rows[0];
            if (
                row &&
                isListShape(row.type) &&
                rows.every((entry) => entry?.type === row.type)
            ) {
                const storage = listStorage(listOfType(row.type) ?? "");
                if (storage) {
                    return `${storage}{${rows
                        .map((entry) => entry!.cpp)
                        .join(", ")}}`;
                }
            }
            // `us[p] = [0]` -- a one-element row of numbers, which is the
            // only other list literal the builders write.
            if (rows.every((entry) => entry === undefined)) {
                return `std::vector<double>{${node.elements
                    .map((element) => this.expression(element))
                    .join(", ")}}`;
            }
        }
        // `new F32(list)` in VALUE position -- the shape a builder's own
        // `return { positions: new F32(positions) }` takes. The same
        // conversion the declaration path performs, written inline because
        // that is where the pin performs it.
        if (ts.isNewExpression(node)) {
            const conversion = this.listConversion(node);
            if (conversion) return conversion;
        }
        if (ts.isElementAccessExpression(node)) {
            const exact = this.scope.bindings.get(node.getText(this.file));
            if (exact) return exact.cpp;
            // A NUMBER read widens to the f64 a JS number is. The f32
            // ROUND-TRIP that `sortSplatsBackToFront` depends on is
            // enforced on the store side, by `storedValue`/`elementType`.
            // A record or a row is read as itself: it is not a number, and
            // widening it would not compile.
            const element = this.elementBinding(node);
            return element === undefined
                ? `static_cast<double>(${this.elementAccess(node)})`
                : element.cpp;
        }
        if (ts.isPostfixUnaryExpression(node)) {
            // `order[counts[key]!++] = j` -- the stable scatter increments a
            // bucket cursor and indexes with its OLD value, which is what
            // post-increment means on both sides.
            const operator =
                node.operator === ts.SyntaxKind.PlusPlusToken
                    ? "++"
                    : node.operator === ts.SyntaxKind.MinusMinusToken
                      ? "--"
                      : undefined;
            if (!operator) this.fail(node, "postfix operator");
            return (
                `static_cast<double>(` +
                `${this.assignmentTarget(node.operand)}${operator})`
            );
        }
        if (ts.isConditionalExpression(node)) {
            // `typeof s === "number" ? s : 1` over a shape the graph fixed:
            // only the selected arm is a value here, and the other may not
            // even translate.
            const known = this.staticCondition(node.condition);
            if (known !== undefined) {
                return this.renderExpression(known ? node.whenTrue : node.whenFalse);
            }
        }
        if (ts.isPropertyAccessExpression(node)) {
            return this.propertyAccess(node);
        }
        if (ts.isCallExpression(node)) {
            return this.call(node);
        }
        if (ts.isBinaryExpression(node)) {
            return this.binary(node);
        }
        if (ts.isObjectLiteralExpression(node)) {
            if (this.scope.recordLiteral) {
                return this.recordLiteral(node, this.scope.recordLiteral);
            }
            if (this.scope.vec3Literal) {
                return this.vec3Literal(node, this.scope.vec3Literal);
            }
        }
        return undefined;
    }

    /**
     * `{ x, y }`, `{ x, y, z }` or `{ r, g, b, a }` -- one of the pin's
     * positional records, as the caller spells it; the member order is
     * the pin's own and a literal of any other shape fails by name.
     */
    private recordLiteral(
        node: ts.ObjectLiteralExpression,
        spell: NonNullable<PinnedNumericScope["recordLiteral"]>,
    ): string {
        const names = node.properties.map((property) =>
            property.name && ts.isIdentifier(property.name)
                ? property.name.text
                : this.fail(property, "record member"),
        );
        const type = recordTypeOfMembers(names);
        if (!type) this.fail(node, "record literal shape");
        const components = node.properties.map((property) => {
            if (ts.isShorthandPropertyAssignment(property)) {
                return this.expression(property.name);
            }
            if (!ts.isPropertyAssignment(property)) {
                this.fail(property, "record member");
            }
            return this.expression(property.initializer);
        });
        return spell(type, components);
    }

    /**
     * What a boolean position already evaluates to at generation, or
     * undefined when only the run time can say.
     *
     * The tests a graph-specialized body makes on values whose shape the
     * graph fixed -- `typeof min === "number"`, `"r" in min`, a lock mode
     * against its enumerator, a record in a truthiness position -- are
     * all answered here, and the callers keep only the arm each answer
     * selects. A partly static `&&`/`||` folds by JavaScript's own
     * short-circuit rule and otherwise stays a run-time condition.
     */
    private readonly staticConditions = new WeakMap<
        ts.Expression,
        boolean | undefined
    >();

    /**
     * Memoized by node: `statements()` folds an `if` in `statement()` and
     * asks `terminates()` about the same condition right after, and the
     * bindings a condition reads are in place before either.
     */
    private staticCondition(expression: ts.Expression): boolean | undefined {
        if (this.scope.foldConditions === false) return undefined;
        if (this.staticConditions.has(expression)) {
            return this.staticConditions.get(expression);
        }
        const known = this.evaluateStaticCondition(expression);
        this.staticConditions.set(expression, known);
        return known;
    }

    private evaluateStaticCondition(
        expression: ts.Expression,
    ): boolean | undefined {
        const node = unwrapExpression(expression);
        if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
        if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
        const bound = this.scope.bindings.get(node.getText(this.file));
        if (bound) {
            if (bound.staticBoolean !== undefined) return bound.staticBoolean;
            if (bound.staticallyAbsent) return false;
            // A record, a buffer or a list is an object, and an object is
            // truthy -- unless the caller declared it nullable, in which case
            // its presence is the run-time test `absentCpp` spells. A
            // number's truthiness is the run time's to answer.
            if (
                bound.absentCpp === undefined &&
                (isRecordType(bound.type) ||
                    isListShape(bound.type) ||
                    bound.type === "function-list" ||
                    bound.type === "opaque")
            ) {
                return true;
            }
            if (bound.staticNumber !== undefined) return bound.staticNumber !== 0;
            return undefined;
        }
        if (
            ts.isPrefixUnaryExpression(node) &&
            node.operator === ts.SyntaxKind.ExclamationToken
        ) {
            const inner = this.staticCondition(node.operand);
            return inner === undefined ? undefined : !inner;
        }
        if (!ts.isBinaryExpression(node)) return undefined;
        const kind = node.operatorToken.kind;
        if (kind === ts.SyntaxKind.AmpersandAmpersandToken) {
            const left = this.staticCondition(node.left);
            if (left === false) return false;
            const right = this.staticCondition(node.right);
            if (left === true) return right;
            return right === false ? false : undefined;
        }
        if (kind === ts.SyntaxKind.BarBarToken) {
            const left = this.staticCondition(node.left);
            if (left === true) return true;
            const right = this.staticCondition(node.right);
            if (left === false) return right;
            return right === true ? true : undefined;
        }
        if (kind === ts.SyntaxKind.InKeyword) {
            const member = unwrapExpression(node.left);
            const owner = this.scope.bindings.get(
                unwrapExpression(node.right).getText(this.file),
            );
            if (!ts.isStringLiteral(member) || !owner) return undefined;
            const shape = RECORD_SHAPES.get(owner.type);
            return shape ? shape.members.includes(member.text) : undefined;
        }
        const equality =
            kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            kind === ts.SyntaxKind.EqualsEqualsToken
                ? true
                : kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
                    kind === ts.SyntaxKind.ExclamationEqualsToken
                  ? false
                  : undefined;
        if (equality === undefined) return undefined;
        const left = unwrapExpression(node.left);
        const right = unwrapExpression(node.right);
        const typeofSide = ts.isTypeOfExpression(left)
            ? { test: left, expected: right }
            : ts.isTypeOfExpression(right)
              ? { test: right, expected: left }
              : undefined;
        if (typeofSide) {
            const name = this.typeofName(typeofSide.test.expression);
            if (name === undefined || !ts.isStringLiteral(typeofSide.expected)) {
                return undefined;
            }
            return (name === typeofSide.expected.text) === equality;
        }
        const leftNumber = this.staticNumberOf(left);
        const rightNumber = this.staticNumberOf(right);
        if (leftNumber === undefined || rightNumber === undefined) {
            return undefined;
        }
        return (leftNumber === rightNumber) === equality;
    }

    /** JavaScript's `typeof` of a bound value, where the binding fixes it. */
    private typeofName(expression: ts.Expression): string | undefined {
        const bound = this.scope.bindings.get(
            unwrapExpression(expression).getText(this.file),
        );
        if (!bound) return undefined;
        if (isRecordType(bound.type) || isListShape(bound.type)) return "object";
        if (bound.type === "bool") return "boolean";
        if (bound.type === "scalar" || bound.type === "index") return "number";
        return undefined;
    }

    /**
     * The number an expression already is: a literal, a binding the caller
     * fixed, or a module constant the file declares as a literal.
     */
    private staticNumberOf(expression: ts.Expression): number | undefined {
        const node = unwrapExpression(expression);
        if (ts.isNumericLiteral(node)) return Number(node.text);
        if (
            ts.isPrefixUnaryExpression(node) &&
            node.operator === ts.SyntaxKind.MinusToken
        ) {
            const inner = this.staticNumberOf(node.operand);
            return inner === undefined ? undefined : -inner;
        }
        if (!ts.isIdentifier(node)) return undefined;
        const bound = this.scope.bindings.get(node.text) ??
            this.moduleConstant(node.text);
        return bound?.staticNumber;
    }

    /**
     * `owner.member?.(...)` as a statement, where the member is a binding
     * the caller declared absent: the pin installs the hook only for a
     * feature the reached graph has none of, so the call is no statement.
     */
    private absentOptionalCall(expression: ts.Expression): boolean {
        const node = unwrapExpression(expression);
        return (
            ts.isCallExpression(node) &&
            node.questionDotToken !== undefined &&
            this.scope.bindings.get(
                unwrapExpression(node.expression).getText(this.file),
            )?.staticallyAbsent === true
        );
    }

    /**
     * A `switch` over a number.
     *
     * Over a discriminant generation knows -- a serialized enumerator --
     * the matching clause is the whole statement, empty clauses falling
     * through to the next as the pin's `case A: case B:` grouping means.
     * Over a run-time number it becomes the if-chain that is JavaScript's
     * own strict equality per clause; a clause that neither returns nor
     * breaks would fall into the next one and is refused rather than
     * given a different meaning.
     */
    private switchStatement(
        statement: ts.SwitchStatement,
        indent: string,
    ): string[] {
        const clauses = statement.caseBlock.clauses;
        // A clause's statements without the `break` that closes it, and
        // whether the clause ends its own control flow.
        const body = (clause: ts.CaseOrDefaultClause): ts.Statement[] => {
            const statements = [...clause.statements];
            const last = statements[statements.length - 1];
            if (last && ts.isBreakStatement(last)) statements.pop();
            return statements;
        };
        const ends = (clause: ts.CaseOrDefaultClause): boolean => {
            const last = clause.statements[clause.statements.length - 1];
            return last !== undefined &&
                (ts.isBreakStatement(last) || this.terminates(last));
        };
        const clauseLines = (
            clause: ts.CaseOrDefaultClause,
            inner: string,
        ): string[] =>
            this.withBindings(() => this.statements(body(clause), inner));
        const known = this.staticNumberOf(statement.expression);
        if (known !== undefined) {
            let selected = clauses.findIndex((clause) => {
                if (!ts.isCaseClause(clause)) return false;
                const value = this.staticNumberOf(clause.expression);
                if (value === undefined) {
                    this.fail(clause.expression, "switch case over a static discriminant");
                }
                return value === known;
            });
            if (selected < 0) {
                selected = clauses.findIndex((clause) => ts.isDefaultClause(clause));
            }
            if (selected < 0) return [];
            // Empty clauses fall through to the first one with statements.
            while (
                selected < clauses.length &&
                clauses[selected]!.statements.length === 0
            ) {
                selected += 1;
            }
            return selected < clauses.length
                ? clauseLines(clauses[selected]!, indent)
                : [];
        }
        const discriminant = this.expression(statement.expression);
        const lines: string[] = [];
        let defaultClause: ts.DefaultClause | undefined;
        clauses.forEach((clause, index) => {
            if (ts.isDefaultClause(clause)) {
                defaultClause = clause;
                return;
            }
            if (!ends(clause) && index !== clauses.length - 1) {
                this.fail(clause, "switch clause falling through");
            }
            lines.push(
                `${indent}${lines.length === 0 ? "" : "} else "}if (` +
                    `${discriminant} == ${this.expression(clause.expression)}) {`,
                ...clauseLines(clause, `${indent}    `),
            );
        });
        if (defaultClause) {
            if (lines.length === 0) return clauseLines(defaultClause, indent);
            lines.push(
                `${indent}} else {`,
                ...clauseLines(defaultClause, `${indent}    `),
            );
        }
        if (lines.length > 0) lines.push(`${indent}}`);
        return lines;
    }

    /** `{ x, y, z }` -- the pin's own positional record, as the caller spells it. */
    private vec3Literal(
        node: ts.ObjectLiteralExpression,
        spell: (x: string, y: string, z: string) => string,
    ): string {
        const lanes = ["x", "y", "z"];
        if (node.properties.length !== lanes.length) {
            this.fail(node, "record literal arity");
        }
        const components = node.properties.map((property, lane) => {
            if (
                !ts.isIdentifier(property.name ?? node) ||
                (property.name as ts.Identifier).text !== lanes[lane]
            ) {
                this.fail(property, `record lane '${lanes[lane]}'`);
            }
            if (ts.isShorthandPropertyAssignment(property)) {
                return this.expression(property.name);
            }
            if (!ts.isPropertyAssignment(property)) {
                this.fail(property, "record member");
            }
            return this.expression(property.initializer);
        });
        return spell(components[0]!, components[1]!, components[2]!);
    }


    /**
     * The C++ test for `expression` being ABSENT, where it names a
     * binding whose caller declared one. Undefined for everything else,
     * which leaves the ordinary spelling in place.
     */
    private absenceTest(expression: ts.Expression): string | undefined {
        const node = unwrapExpression(expression);
        // By full source text, which is how a MEMBER binding is keyed:
        // the pin tests `!mi._cpuNormals` as readily as `!positions`.
        return this.scope.bindings.get(node.getText(this.file))?.absentCpp;
    }

    /**
     * One operand of the pin's `&&`/`||`, where a nullable container in a
     * boolean position means "it is there".
     */
    private booleanOperand(expression: ts.Expression): string {
        const absent = this.absenceTest(expression);
        return absent ? `!(${absent})` : this.expression(expression);
    }

    /** One property read off a binding the pin treats as optional. */
    private optionalMember(
        node: ts.PropertyAccessExpression,
    ): { present: string; member: { cpp: string; absent?: string } } | undefined {
        const owner = unwrapExpression(node.expression);
        if (!ts.isIdentifier(owner)) return undefined;
        const binding = this.scope.bindings.get(owner.text);
        const optional = binding?.optional;
        if (!optional) return undefined;
        const member = optional.members.get(node.name.text);
        if (!member) {
            this.fail(node, `optional member '${node.name.text}'`);
        }
        return { present: optional.present, member };
    }

    /**
     * `const q = f(...)` / `const q = f(...).member` for a call the caller
     * declared record-valued.
     *
     * Returns the lines to emit, or undefined when the initializer is not
     * one of those two shapes — which leaves every other declaration to the
     * paths below it.
     */
    private recordCallBinding(
        name: string,
        initializer: ts.Expression,
        indent: string,
        ordinal: number,
    ): string[] | undefined {
        const unwrapped = unwrapExpression(initializer);
        // `const q = f(...).member` would have to know the member's own
        // shape to bind anything readable off it, and the caller declares
        // only the record's member names. It refuses rather than binding a
        // name whose next read cannot resolve.
        if (ts.isPropertyAccessExpression(unwrapped)) {
            const owner = unwrapExpression(unwrapped.expression);
            if (
                ts.isCallExpression(owner) &&
                ts.isIdentifier(owner.expression) &&
                this.scope.recordCalls?.has(owner.expression.text)
            ) {
                this.fail(unwrapped, "record member binding");
            }
            return undefined;
        }
        if (
            !ts.isCallExpression(unwrapped) ||
            !ts.isIdentifier(unwrapped.expression)
        ) {
            return undefined;
        }
        const members = this.scope.recordCalls?.get(unwrapped.expression.text);
        if (!members) return undefined;
        const temporary = this.temporaryName(initializer, ordinal);
        // Every member the caller listed binds by its own dotted text, which
        // is the same lookup `propertyAccess` opens with — so a later `q.x`
        // resolves there rather than needing an arm of its own.
        for (const field of members) {
            this.scope.bindings.set(`${name}.${field}`, {
                cpp: `${temporary}.${field}`,
                type: "scalar",
            });
        }
        this.scope.bindings.set(name, { cpp: temporary, type: "scalar" });
        return [
            `${indent}const auto ${temporary} = ` +
                `${this.expression(unwrapped)};`,
        ];
    }

    /**
     * The name of a temporary a destructuring binds through.
     *
     * Keyed by the node's own start offset so two destructurings in one
     * body cannot collide, and written once because three declaration
     * shapes need it.
     */
    private temporaryName(node: ts.Node, ordinal: number): string {
        return `pinned_${ordinal}_${node.getStart(this.file)}`;
    }

    private propertyAccess(
        node: ts.PropertyAccessExpression,
        absentOverride?: string,
    ): string {
        const named = this.scope.bindings.get(node.getText(this.file));
        if (named) return named.cpp;
        // `hi?.r ?? 0` where generation resolved `hi` to null: the pin's
        // own `??` default is the value, and a read with no default is a
        // member of nothing.
        const ownerBinding = this.scope.bindings.get(
            unwrapExpression(node.expression).getText(this.file),
        );
        if (ownerBinding?.staticallyAbsent) {
            if (absentOverride === undefined) {
                this.fail(node, "member read off an absent record");
            }
            return absentOverride;
        }
        const optional = this.optionalMember(node);
        if (optional) {
            const absent = absentOverride ?? optional.member.absent;
            if (absent === undefined) {
                this.fail(
                    node,
                    "optional read with no `??` and no coercion default",
                );
            }
            return `(${optional.present} ? ${optional.member.cpp} : ` +
                `${absent})`;
        }
        // `pt.x` on a record the pin passes around whole -- a path point,
        // or a `sub()` result. The member is the C++ member: the record is
        // one of the pin's own positional records and this port stores it
        // as one, so a member the shape does not have fails by name.
        const record = this.recordValue(node.expression);
        if (record) {
            const members = RECORD_SHAPES.get(record.type)?.members ?? [];
            if (members.includes(node.name.text)) {
                return `${record.cpp}.${node.name.text}`;
            }
        }
        // A bound buffer answers `length`/`byteLength` however the pin
        // spells it: a bare local, or a member path the caller bound (a
        // record's own array, say). Resolving the owner by its text rather
        // than by its node kind is what makes those the same rule.
        const owner = unwrapExpression(node.expression);
        const binding = this.scope.bindings.get(
            owner.getText(this.file),
        );
        if (binding && node.name.text === "length") {
            if (
                binding.type === "f32" ||
                binding.type === "u32" ||
                binding.type === "u8" ||
                binding.type === "f64-buffer" ||
                binding.type === "function-list" ||
                isListShape(binding.type)
            ) {
                return `static_cast<double>(${binding.cpp}.size())`;
            }
        }
        // `pathArray[0].length` -- the length of a ROW read in place. The
        // same question as a bound list's, asked of an element.
        if (
            node.name.text === "length" &&
            ts.isElementAccessExpression(owner)
        ) {
            const row = this.rowBinding(owner);
            if (row) {
                return `static_cast<double>(${row.cpp}.size())`;
            }
        }
        if (binding?.bytesCpp && node.name.text === "byteLength") {
            return `static_cast<double>(${binding.bytesCpp})`;
        }
        return this.fail(node, "property access");
    }

    private call(node: ts.CallExpression): string {
        const callee = node.expression;
        // A lowered callee takes its numbers as double; a counted loop's
        // `std::int64_t` index is the one binding that is not one yet.
        const args = node.arguments.map((argument) => {
            const text = this.expression(argument);
            const unwrapped = unwrapExpression(argument);
            const bound = ts.isIdentifier(unwrapped)
                ? this.scope.bindings.get(unwrapped.text)
                : undefined;
            return bound?.type === "index"
                ? `static_cast<double>(${text})`
                : text;
        });
        // A whole call the caller spelled by its text: an instantiation of
        // a pinned helper over this body's own getters and scratch, which
        // keeps the pin's numeric arguments and drops the getters and
        // scratch it was specialized over. Only the caller can give that
        // spelling, so it is keyed by the call rather than the callee.
        const site = this.scope.calls.get(node.getText(this.file));
        if (site) return site(args);
        // `steps[s]!(i)` -- a call through a bound function list.
        const indexed = unwrapExpression(callee);
        if (ts.isElementAccessExpression(indexed)) {
            const list = this.elementOwner(indexed);
            if (list?.type === "function-list") {
                if (!this.scope.indexedCall) {
                    this.fail(node, "indexed call");
                }
                return this.scope.indexedCall(
                    list,
                    this.expression(indexed.argumentExpression),
                    args,
                );
            }
        }
        if (
            ts.isPropertyAccessExpression(callee) &&
            callee.name.text === "set" &&
            this.scope.arrayCopy &&
            node.arguments.length === 2
        ) {
            const receiver = this.scope.bindings.get(
                callee.expression.getText(this.file),
            );
            const source = this.scope.bindings.get(
                unwrapExpression(node.arguments[0]!).getText(this.file),
            );
            if (receiver && source) {
                return this.scope.arrayCopy(
                    receiver.cpp,
                    source.cpp,
                    this.expression(node.arguments[1]!),
                );
            }
        }
        // `positions.push(x, y, z)` onto a grown list. The pin appends in
        // argument order and the comma expression keeps that order while
        // staying one expression, which is what an expression statement and
        // a `for` body both accept.
        if (
            ts.isPropertyAccessExpression(callee) &&
            callee.name.text === "push"
        ) {
            // The receiver is a bound list, or a ROW of one read in
            // place: `us[p]!.push(dist)` appends to the row `p`, which is
            // the same push against a list the caller never named.
            const receiver = unwrapExpression(callee.expression);
            const list = ts.isElementAccessExpression(receiver)
                ? this.rowBinding(receiver)
                : this.scope.bindings.get(
                      callee.expression.getText(this.file),
                  );
            if (list && isListShape(list.type)) {
                if (node.arguments.length === 0) {
                    this.fail(node, "push with no arguments");
                }
                // A record list takes the record whole; a number list takes
                // each argument in the order the pin appends them.
                const values =
                    list.type === "vec3-list"
                        ? node.arguments.map(
                              (argument) =>
                                  this.recordValue(argument)?.cpp ??
                                  this.fail(argument, "push"),
                          )
                        : args;
                const pushes = values.map(
                    (argument) => `${list.cpp}.push_back(${argument})`,
                );
                return pushes.length === 1
                    ? pushes[0]!
                    : `(${pushes.join(", ")})`;
            }
        }
        if (ts.isPropertyAccessExpression(callee)) {
            const method = this.scope.methods?.get(callee.name.text);
            const receiver = this.scope.bindings.get(
                callee.expression.getText(this.file),
            );
            if (method && receiver) {
                return method(receiver.cpp, args, receiver);
            }
            // `edges[ei]!.place(...)` -- the receiver is an ELEMENT of a
            // bound list rather than a name. The element resolves through
            // the same owner lookup a read does, so a method on one
            // reaches the caller's spelling exactly as a method on a named
            // buffer does.
            const element = unwrapExpression(callee.expression);
            if (method && ts.isElementAccessExpression(element)) {
                const owner = this.elementOwner(element);
                if (owner) return method(this.elementAccess(element), args, owner);
            }
        }
        const name = ts.isPropertyAccessExpression(callee)
            ? `${callee.expression.getText(this.file)}.${callee.name.text}`
            : ts.isIdentifier(callee)
              ? callee.text
              : undefined;
        if (!name) this.fail(node, "call target");
        const spelling = this.scope.calls.get(name);
        if (!spelling) this.fail(node, `call '${name}'`);
        return spelling(args);
    }

    private binary(node: ts.BinaryExpression): string | undefined {
        // A caller may bind a whole COMPARISON, where the question the pin
        // asks is one the native record answers directly:
        // `options.diameterTop === 0` is not a test on the resolved
        // diameter, it is "did the scene name a zero top". Naming it here
        // is the same specialization `propertyAccess` already takes for a
        // resolved member.
        const named = this.scope.bindings.get(node.getText(this.file));
        if (named) return named.cpp;
        // A comparison generation already answers is its answer, so the
        // untranslatable half of a shape test (`"r" in min`) never reaches
        // the operator table below.
        const known = this.staticCondition(node);
        if (known !== undefined) return known ? "true" : "false";
        // A boolean join with one static side keeps only the side that
        // still decides, by JavaScript's own short-circuit rule.
        if (
            node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
            node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        ) {
            const or = node.operatorToken.kind === ts.SyntaxKind.BarBarToken;
            const left = this.staticCondition(node.left);
            const right = this.staticCondition(node.right);
            if (left !== undefined && (or ? !left : left)) {
                return this.booleanOperand(node.right);
            }
            if (right !== undefined && (or ? !right : right)) {
                return this.booleanOperand(node.left);
            }
        }
        if (
            node.operatorToken.kind ===
            ts.SyntaxKind.GreaterThanGreaterThanToken
        ) {
            // `emission >> 0` is the pin's truncation to a signed 32-bit
            // integer; the shift count is masked to five bits as ECMAScript
            // masks it.
            return (
                `bbl::js::shift_right(${this.expression(node.left)}, ` +
                `${this.expression(node.right)})`
            );
        }
        if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
            const left = unwrapExpression(node.left), right = unwrapExpression(node.right);
            const absent = ts.isIdentifier(right) && right.text === "undefined"
                ? this.absenceTest(left)
                : ts.isIdentifier(left) && left.text === "undefined"
                    ? this.absenceTest(right) : undefined;
            if (absent !== undefined) {
                return node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
                    ? `(${absent})` : `!(${absent})`;
            }
            const leftAbsent = this.absenceTest(left), rightAbsent = this.absenceTest(right);
            if (leftAbsent !== undefined || rightAbsent !== undefined) {
                const lhs = leftAbsent ?? "false", rhs = rightAbsent ?? "false";
                const equal = `(((${lhs}) && (${rhs})) || (!(${lhs}) && !(${rhs}) && ` +
                    `(${this.expression(left)} == ${this.expression(right)})))`;
                return node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? equal : `!${equal}`;
            }
        }
        switch (node.operatorToken.kind) {
            case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
                return `bbl::js::shift_right_unsigned(${this.expression(node.left)}, ${this.expression(node.right)})`;
            case ts.SyntaxKind.QuestionQuestionToken: {
                // The pin resolves an absent optional read with its own
                // default, so the right side IS the default -- read from the
                // AST rather than restated beside the member.
                // `a ?? b ?? c` parses as `(a ?? b) ?? c`, so the first
                // operand sits at the bottom of the left spine. A caller
                // that resolved the option binds THAT one, and binding it
                // is the same specialization as taking the present arm --
                // which for a chain means the whole chain.
                let spine = unwrapExpression(node.left);
                while (
                    ts.isBinaryExpression(spine) &&
                    spine.operatorToken.kind ===
                        ts.SyntaxKind.QuestionQuestionToken
                ) {
                    const head = this.scope.bindings.get(
                        unwrapExpression(spine.left).getText(this.file),
                    );
                    if (head) return head.cpp;
                    spine = unwrapExpression(spine.left);
                }
                const left = unwrapExpression(node.left);
                // Some pinned option records expose an optional tuple member
                // (`opts.uvScale?.[0] ?? 1`). A caller that already resolved
                // that option into its native record binds the complete
                // optional-element expression here; naming that binding is
                // the same specialization as taking the present arm.
                const resolved = this.scope.bindings.get(
                    left.getText(this.file),
                );
                if (resolved) return resolved.cpp;
                if (!ts.isPropertyAccessExpression(left)) {
                    return this.fail(node, "'??' over a non-optional read");
                }
                return this.propertyAccess(
                    left,
                    this.expression(node.right),
                );
            }


            case ts.SyntaxKind.AmpersandToken:
                // A mask over an integral loop counter (`corner & 1` picks
                // one AABB corner's axis, and the bounding-box cage's
                // octant signs read the same way). Through the same helper
                // the `|` arm below uses, for the reason its comment gives:
                // JavaScript coerces both sides with ToInt32, and a bare
                // `static_cast<std::int32_t>` of an out-of-range double is
                // not that. Not gated -- it is ToInt32 for every caller,
                // and putting it behind an opt-in refused fifteen scenes
                // that had always lowered.
                return (
                    `bbl::js::bitwise_and(${this.expression(node.left)}, ` +
                    `${this.expression(node.right)})`
                );
            case ts.SyntaxKind.BarBarToken:
                if (this.scope.booleanOr) {
                    if (this.absenceTest(node.left) === undefined && this.absenceTest(node.right) === undefined) return undefined;
                    return (
                        `(${this.booleanOperand(node.left)} || ` +
                        `${this.booleanOperand(node.right)})`
                    );
                }
                // JS `a || b` evaluates to `a` when `a` is truthy and to `b`
                // otherwise; C++ `a || b` evaluates to a bool. Emitting the
                // C++ operator turned the pin's `Math.hypot(...) || 1` into
                // the constant 1 and stopped normalising the quaternion,
                // which is exactly the class of silent rewrite this
                // translator exists to prevent. Lowered to the value-selecting
                // form instead: `bbl::js::or_number`, which the other
                // lowerers already emit and which also falls through on NaN
                // -- a local copy of this dropped that arm.
                return (
                    `bbl::js::or_number(${this.expression(node.left)}, ` +
                    `${this.expression(node.right)})`
                );
            case ts.SyntaxKind.AmpersandAmpersandToken:
                if (this.scope.booleanAnd) {
                    if (this.absenceTest(node.left) === undefined && this.absenceTest(node.right) === undefined) return undefined;
                    return (
                        `(${this.booleanOperand(node.left)} && ` +
                        `${this.booleanOperand(node.right)})`
                    );
                }
                // The same hazard in the other direction. No pinned body
                // this translator serves uses it as a value yet, so it
                // refuses rather than guessing which meaning is wanted.
                return this.fail(node, "value-selecting '&&'");
            case ts.SyntaxKind.BarToken: {
                // `x | 0` is the pin's truncation to a 32-bit integer, and
                // says so in one term rather than two.
                const right = unwrapExpression(node.right);
                if (
                    ts.isNumericLiteral(right) &&
                    Number(right.text) === 0 && !this.scope.checkedBitwiseCoercions
                ) {
                    return (
                        `static_cast<double>(static_cast<std::int32_t>(` +
                        `${this.expression(node.left)}))`
                    );
                }
                // A real bitwise OR, which the cluster tile mask needs:
                // `maskData[i] = maskData[i] | bit`, where the bit is
                // `1 << (lightIndex % 32)`. JavaScript coerces both sides
                // through ToInt32 before masking -- so bit 31 is NEGATIVE
                // there -- and the `Uint32Array` store then wraps it back.
                // `bbl::js::bitwise_or` is that operator, ToUint32 and all;
                // a bare `static_cast<std::int32_t>` of a double outside
                // int32 range is not, which is precisely the sign bit the
                // 32nd light in a batch rides on.
                return (
                    `bbl::js::bitwise_or(${this.expression(node.left)}, ` +
                    `${this.expression(node.right)})`
                );
            }
            case ts.SyntaxKind.LessThanLessThanToken:
                return (
                    `static_cast<double>(static_cast<std::int32_t>(` +
                    `${this.expression(node.left)}) << ` +
                    `static_cast<std::int32_t>(${this.expression(node.right)}))`
                );


            default:
                return undefined;
        }
    }
}

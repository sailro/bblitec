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
import { doubleLiteral } from "../cpp-literals.js";
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
    ["f64-list", { storage: "std::vector<double>" }],
    [
        "f64-list-2d",
        { storage: "std::vector<std::vector<double>>", element: "f64-list" },
    ],
    ["vec3-list", { storage: "std::vector<Vec3d>", element: "vec3" }],
    [
        "vec3-list-2d",
        { storage: "std::vector<std::vector<Vec3d>>", element: "vec3-list" },
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

/** Whether a pinned type annotation names the pin's `{x, y, z}` record. */
function isVec3Type(node: ts.TypeNode): boolean {
    return (
        ts.isTypeReferenceNode(node) &&
        ts.isIdentifier(node.typeName) &&
        node.typeName.text === "Vec3"
    );
}

/** How one pinned identifier is spelled and typed in the emitted C++. */
export interface PinnedBinding {
    cpp: string;
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
        | "vec3"
        | "vec3-list"
        | "vec3-list-2d"
        | "scalar"
        | "index"
        | "bool";
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
        (receiver: string, args: readonly string[]) => string
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

// The shared arithmetic set plus the comparisons these bodies guard with.
// `pinned-operators.ts` owns the arithmetic so an operator one lowerer learns
// is an operator all of them know.
const BINARY_OPERATORS = new Map<ts.SyntaxKind, string>([
    ...PINNED_ARITHMETIC_OPERATORS,
    [ts.SyntaxKind.LessThanToken, "<"],
    [ts.SyntaxKind.GreaterThanToken, ">"],
    [ts.SyntaxKind.LessThanEqualsToken, "<="],
    [ts.SyntaxKind.GreaterThanEqualsToken, ">="],
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
        throw new Error(
            `Unsupported pinned ${what}: ${node.getText(this.file)}.`,
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
        let cpp = name;
        for (let suffix = 1; occupied.has(cpp); suffix++) cpp = `${name}_${suffix}`;
        return cpp;
    }

    private withBindings<T>(action: () => T): T {
        const saved = new Map(this.scope.bindings);
        try { return action(); }
        finally {
            this.scope.bindings.clear();
            for (const [name, binding] of saved) this.scope.bindings.set(name, binding);
        }
    }

    public statement(statement: ts.Statement, indent: string): string[] {
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
            const inlined = this.inlinedHelperCall(
                statement.expression,
                indent,
            );
            if (inlined) return inlined;
            return [
                `${indent}${this.expressionStatement(statement.expression)};`,
            ];
        }
        if (ts.isIfStatement(statement)) {
            // A guard on a binding the caller declared statically ABSENT
            // -- a pinned optional parameter the reached slice never
            // supplies -- takes its else arm, and its then arm is not
            // translated at all. That is the point: the arm behind such a
            // parameter reaches machinery this port does not have (the
            // deformed-triangle scratch behind `deformTriangle`), and
            // emitting a dead call to it would be inventing a native name
            // for something no scene reaches. The parameter's own name and
            // annotation are still asserted, so the pin cannot move the
            // seam without failing here.
            if (this.staticallyAbsent(statement.expression)) {
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
            if (
                !initializer ||
                !ts.isVariableDeclarationList(initializer) ||
                !statement.condition ||
                !statement.incrementor
            ) {
                this.fail(statement, "for statement");
            }
            // The loop variable indexes typed arrays, so it is an integer
            // rather than the f64 every other local is.
            const { condition, incrementor } = statement;
            return this.withBindings(() => {
                const declared = this.loopVariable(initializer);
                return [
                    `${indent}for (${declared}; ` +
                        `${this.condition(condition)}; ` +
                        `${this.expressionStatement(incrementor)}) {`,
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
            ? statement.statements.flatMap((s) => this.statement(s, inner))
            : this.statement(statement, inner));
    }

    private loopVariable(list: ts.VariableDeclarationList): string {
        if (list.declarations.length !== 1) {
            this.fail(list, "for initializer");
        }
        const declaration = list.declarations[0]!;
        if (
            !ts.isIdentifier(declaration.name) ||
            !declaration.initializer
        ) {
            this.fail(declaration, "for initializer");
        }
        const name = declaration.name.text;
        const cpp = this.localName(name);
        const initial = this.expression(declaration.initializer);
        this.scope.bindings.set(name, { cpp, type: "index" });
        return (
            `std::int64_t ${cpp} = ` +
            `static_cast<std::int64_t>(${initial})`
        );
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
                    ? this.unwrap(declaration.initializer)
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
                // `let key: number;` assigned on both arms of an if. Zeroed
                // rather than left indeterminate so the emitted C++ stays
                // warning-clean; every reached path writes it first. A
                // `let v1: Vec3;` is the same statement over the pin's own
                // record, and its annotation is the only place that says so.
                const annotation = declaration.type;
                const isRecord =
                    annotation !== undefined && isVec3Type(annotation);
                this.scope.bindings.set(name, {
                    cpp,
                    type: isRecord ? "vec3" : "scalar",
                });
                lines.push(
                    isRecord
                        ? `${indent}Vec3d ${cpp}{};`
                        : `${indent}double ${cpp} = 0.0;`,
                );
                continue;
            }
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
            const aliasSource = this.unwrap(declaration.initializer);
            const aliasKey =
                ts.isBinaryExpression(aliasSource) &&
                aliasSource.operatorToken.kind ===
                    ts.SyntaxKind.QuestionQuestionToken &&
                ts.isArrayLiteralExpression(this.unwrap(aliasSource.right))
                    ? this.unwrap(aliasSource.left).getText(this.file)
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
            if (
                alias &&
                (alias.type === "f32" ||
                    alias.type === "u32" ||
                    alias.type === "u8" ||
                    alias.type === "f32-view" ||
                    alias.type === "u8-view" ||
                    alias.absentCpp !== undefined)
            ) {
                this.scope.bindings.set(name, alias);
                continue;
            }
            // `const positions: number[] = []` -- a list the builder grows
            // with `push`. The pin holds numbers at double width and rounds
            // only at the `new F32(list)` that ends the builder, so the
            // storage is double and the rounding stays where the pin put
            // it. WHICH list it is comes from the declaration's own type
            // annotation, which is the only place an empty literal says.
            const emptyList = this.unwrap(declaration.initializer);
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
                this.unwrap(declaration.initializer).getText(this.file),
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
            const rowSource = this.unwrap(declaration.initializer);
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
                    const access = this.unwrap(branch);
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
                            `${this.expression(declaration.initializer)};`,
                    );
                    continue;
                }
            }
            const allocation = this.allocation(declaration.initializer);
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
            const initializer = this.unwrap(declaration.initializer);
            if (this.scope.vec3Literal && ts.isObjectLiteralExpression(initializer)) {
                const value = this.expression(initializer);
                this.scope.bindings.set(name, { cpp, type: "vec3" });
                lines.push(`${indent}${isConst ? "const " : ""}Vec3d ${cpp} = ${value};`);
                continue;
            }
            // A call the caller declared matrix-valued binds the fixed
            // matrix, so a later element read indexes it rather than
            // indexing a double.
            if (
                this.scope.matrixCalls &&
                ts.isCallExpression(initializer) &&
                ts.isIdentifier(initializer.expression) &&
                this.scope.matrixCalls.has(initializer.expression.text)
            ) {
                this.scope.bindings.set(name, { cpp, type: "f32" });
                lines.push(
                    `${indent}${isConst ? "const " : ""}` +
                        `std::array<float, 16> ${cpp} = ` +
                        `${this.expression(declaration.initializer)};`,
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
                        `${this.expression(declaration.initializer)};`,
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
                        `${this.expression(declaration.initializer)};`,
                );
                continue;
            }
            const isBoolean =
                initializer.kind === ts.SyntaxKind.TrueKeyword ||
                initializer.kind === ts.SyntaxKind.FalseKeyword;
            const value = this.expression(declaration.initializer);
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
        const constructor = initializer.expression.text;
        const argument = initializer.arguments[0]!;
        // `new U8(buffer)` / `new F32(buffer)` re-view an existing byte
        // buffer; the same constructors over a COUNT allocate.
        const named = this.unwrap(argument);
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
        const literal = ts.isNumericLiteral(this.unwrap(argument))
            ? Number((this.unwrap(argument) as ts.NumericLiteral).text)
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
            const operator = PINNED_ASSIGNMENT_OPERATORS.get(
                expression.operatorToken.kind,
            );
            if (operator) {
                return (
                    `${this.assignmentTarget(expression.left)} ${operator} ` +
                    `${this.storedValue(expression.left, expression.right)}`
                );
            }
        }
        if (ts.isPostfixUnaryExpression(expression)) {
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
     * The right-hand side of a store, cast to the array's element width where
     * the pin's own store would round. Every other value stays f64.
     */
    private storedValue(
        target: ts.Expression,
        value: ts.Expression,
    ): string {
        const unwrapped = this.unwrap(target);
        const literal = this.unwrap(value);
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
        const argument = this.unwrap(node.arguments[0]!);
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
        const initializer = this.unwrap(declaration.initializer);
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
        const node = this.unwrap(expression);
        if (!ts.isCallExpression(node)) return undefined;
        const callee = this.unwrap(node.expression);
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
            const unwrapped = this.unwrap(argument);
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
        const absent = this.absenceTest(expression);
        if (absent !== undefined) return `!(${absent})`;
        const text = this.expression(expression);
        if (!text.startsWith("(") || !text.endsWith(")")) return text;
        let depth = 0;
        for (let index = 0; index < text.length; index += 1) {
            if (text[index] === "(") depth += 1;
            else if (text[index] === ")") {
                depth -= 1;
                // The opening parenthesis closed before the end, so the
                // outer pair is not one enclosing pair.
                if (depth === 0 && index !== text.length - 1) return text;
            }
        }
        return text.slice(1, -1);
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
            if (isVec3Type(element)) return "vec3-list";
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
    private recordValue(expression: ts.Expression): string | undefined {
        const node = this.unwrap(expression);
        if (ts.isIdentifier(node)) {
            const binding = this.scope.bindings.get(node.text);
            return binding?.type === "vec3" ? binding.cpp : undefined;
        }
        if (ts.isElementAccessExpression(node)) {
            const owner = this.elementOwner(node);
            return owner?.type === "vec3-list"
                ? this.elementAccess(node)
                : undefined;
        }
        return undefined;
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
        const owner = this.unwrap(expression.expression);
        const named = this.scope.bindings.get(owner.getText(this.file));
        if (named) return named;
        // `us[p]![i]` -- the owner is itself a row, which is a list.
        return ts.isElementAccessExpression(owner)
            ? this.rowBinding(owner)
            : undefined;
    }

    private assignmentTarget(expression: ts.Expression): string {
        const unwrapped = this.unwrap(expression);
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
            return this.fail(unwrapped, "assignment target");
        }
        if (ts.isElementAccessExpression(unwrapped)) {
            // A view the caller did not declare mutable is an alias over
            // someone else's storage, so a store through one is refused
            // here. Leaving it to the emitted `const` would report the same
            // fact as a C++ compile error with no pinned source location.
            const target = this.elementOwner(unwrapped);
            if (
                target &&
                (target.type === "f32-view" || target.type === "u8-view") &&
                !target.mutable
            ) {
                this.fail(unwrapped, "store through a read-only view");
            }
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

    private unwrap(expression: ts.Expression): ts.Expression {
        let current = expression;
        while (
            ts.isParenthesizedExpression(current) ||
            ts.isNonNullExpression(current) ||
            ts.isAsExpression(current) ||
            ts.isTypeAssertionExpression(current)
        ) {
            current = current.expression;
        }
        return current;
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
        let initializer: ts.Expression | undefined;
        for (const statement of this.file.statements) {
            if (
                !ts.isVariableStatement(statement) ||
                (statement.declarationList.flags & ts.NodeFlags.Const) === 0
            ) {
                continue;
            }
            for (const declaration of statement.declarationList.declarations) {
                if (
                    ts.isIdentifier(declaration.name) &&
                    declaration.name.text === name
                ) {
                    initializer = declaration.initializer;
                }
            }
        }
        if (!initializer) return undefined;
        // A binding under its own name first, so a constant that names
        // itself recurses no further than one step and fails there.
        this.moduleConstants.set(name, undefined);
        const binding: PinnedBinding = {
            cpp: `(${this.expression(initializer)})`,
            type: "scalar",
        };
        this.moduleConstants.set(name, binding);
        return binding;
    }

    public expression(expression: ts.Expression): string {
        const node = this.unwrap(expression);
        if (ts.isNumericLiteral(node)) {
            return doubleLiteral(Number(node.text));
        }
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
                const absent = this.absenceTest(node.operand);
                if (absent) return `(${absent})`;
            }
            return `(${operator}${this.expression(node.operand)})`;
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
                    this.unwrap(element).getText(this.file),
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
        if (
            node.kind === ts.SyntaxKind.TrueKeyword ||
            node.kind === ts.SyntaxKind.FalseKeyword
        ) {
            return node.kind === ts.SyntaxKind.TrueKeyword
                ? "true"
                : "false";
        }
        if (ts.isConditionalExpression(node)) {
            return (
                `(${this.expression(node.condition)} ? ` +
                `${this.expression(node.whenTrue)} : ` +
                `${this.expression(node.whenFalse)})`
            );
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
        if (
            ts.isObjectLiteralExpression(node) &&
            this.scope.vec3Literal
        ) {
            return this.vec3Literal(node, this.scope.vec3Literal);
        }
        return this.fail(node, "expression");
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

    /** Whether `expression` names a binding the caller declared absent. */
    private staticallyAbsent(expression: ts.Expression): boolean {
        const node = this.unwrap(expression);
        return (
            this.scope.bindings.get(node.getText(this.file))
                ?.staticallyAbsent === true
        );
    }

    /**
     * The C++ test for `expression` being ABSENT, where it names a
     * binding whose caller declared one. Undefined for everything else,
     * which leaves the ordinary spelling in place.
     */
    private absenceTest(expression: ts.Expression): string | undefined {
        const node = this.unwrap(expression);
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
        const owner = this.unwrap(node.expression);
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
        const unwrapped = this.unwrap(initializer);
        // `const q = f(...).member` would have to know the member's own
        // shape to bind anything readable off it, and the caller declares
        // only the record's member names. It refuses rather than binding a
        // name whose next read cannot resolve.
        if (ts.isPropertyAccessExpression(unwrapped)) {
            const owner = this.unwrap(unwrapped.expression);
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
        // the pin's own `{x, y, z}` and this port stores it as one.
        const record = this.recordValue(node.expression);
        if (
            record &&
            (node.name.text === "x" ||
                node.name.text === "y" ||
                node.name.text === "z")
        ) {
            return `${record}.${node.name.text}`;
        }
        // A bound buffer answers `length`/`byteLength` however the pin
        // spells it: a bare local, or a member path the caller bound (a
        // record's own array, say). Resolving the owner by its text rather
        // than by its node kind is what makes those the same rule.
        const owner = this.unwrap(node.expression);
        const binding = this.scope.bindings.get(
            owner.getText(this.file),
        );
        if (binding && node.name.text === "length") {
            if (
                binding.type === "f32" ||
                binding.type === "u32" ||
                binding.type === "u8" ||
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
        const args = node.arguments.map((argument) =>
            this.expression(argument),
        );
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
                this.unwrap(node.arguments[0]!).getText(this.file),
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
            const receiver = this.unwrap(callee.expression);
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
                        ? node.arguments.map((argument) => {
                              const record = this.recordValue(argument);
                              return record ?? this.fail(argument, "push");
                          })
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
                return method(receiver.cpp, args);
            }
            // `edges[ei]!.place(...)` -- the receiver is an ELEMENT of a
            // bound list rather than a name. The element resolves through
            // the same owner lookup a read does, so a method on one
            // reaches the caller's spelling exactly as a method on a named
            // buffer does.
            const element = this.unwrap(callee.expression);
            if (
                method &&
                ts.isElementAccessExpression(element) &&
                this.elementOwner(element)
            ) {
                return method(this.elementAccess(element), args);
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

    private binary(node: ts.BinaryExpression): string {
        // A caller may bind a whole COMPARISON, where the question the pin
        // asks is one the native record answers directly:
        // `options.diameterTop === 0` is not a test on the resolved
        // diameter, it is "did the scene name a zero top". Naming it here
        // is the same specialization `propertyAccess` already takes for a
        // resolved member.
        const named = this.scope.bindings.get(node.getText(this.file));
        if (named) return named.cpp;
        if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
            const left = this.unwrap(node.left), right = this.unwrap(node.right);
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
        const operator = BINARY_OPERATORS.get(node.operatorToken.kind);
        if (operator) {
            return (
                `(${this.expression(node.left)} ${operator} ` +
                `${this.expression(node.right)})`
            );
        }
        switch (node.operatorToken.kind) {
            case ts.SyntaxKind.QuestionQuestionToken: {
                // The pin resolves an absent optional read with its own
                // default, so the right side IS the default -- read from the
                // AST rather than restated beside the member.
                // `a ?? b ?? c` parses as `(a ?? b) ?? c`, so the first
                // operand sits at the bottom of the left spine. A caller
                // that resolved the option binds THAT one, and binding it
                // is the same specialization as taking the present arm --
                // which for a chain means the whole chain.
                let spine = this.unwrap(node.left);
                while (
                    ts.isBinaryExpression(spine) &&
                    spine.operatorToken.kind ===
                        ts.SyntaxKind.QuestionQuestionToken
                ) {
                    const head = this.scope.bindings.get(
                        this.unwrap(spine.left).getText(this.file),
                    );
                    if (head) return head.cpp;
                    spine = this.unwrap(spine.left);
                }
                const left = this.unwrap(node.left);
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
            case ts.SyntaxKind.EqualsEqualsEqualsToken:
                return (
                    `(${this.expression(node.left)} == ` +
                    `${this.expression(node.right)})`
                );
            case ts.SyntaxKind.ExclamationEqualsEqualsToken:
                return (
                    `(${this.expression(node.left)} != ` +
                    `${this.expression(node.right)})`
                );
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
                const right = this.unwrap(node.right);
                if (
                    ts.isNumericLiteral(right) &&
                    Number(right.text) === 0
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
            case ts.SyntaxKind.PercentToken:
                // JavaScript's `%` is floating-point remainder. The reached
                // mesh builders use it with non-negative integral operands,
                // but spelling fmod retains the JS-number contract instead
                // of silently changing the operator to integer modulo.
                return (
                    `std::fmod(${this.expression(node.left)}, ` +
                    `${this.expression(node.right)})`
                );
            case ts.SyntaxKind.AsteriskAsteriskToken:
                // `**` over JS numbers is Number::exponentiate, the same
                // algorithm ECMA-262 gives `Math.pow`, so it lowers to the
                // `std::pow` the Math table already maps that call to. The
                // AST carries the operator's right associativity, so the
                // spelling needs no parenthesization rule of its own.
                return (
                    `std::pow(${this.expression(node.left)}, ` +
                    `${this.expression(node.right)})`
                );
            default:
                return this.fail(node, "binary operator");
        }
    }
}

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

/** How one pinned identifier is spelled and typed in the emitted C++. */
export interface PinnedBinding {
    cpp: string;
    /** For a view, the C++ expression giving its byte length. */
    bytesCpp?: string;
    /**
     * `f32`/`u32` are owned buffers whose stores round to that width;
     * `f32-view`/`u8-view` are read-only aliases over a byte buffer;
     * `f64-list` is a GROWABLE `number[]` the pin pushes onto, which holds
     * its elements at the pin's own double width until a `new F32(list)`
     * rounds them; `f64-list-2d` is a jagged `number[][]` whose rows are
     * themselves `f64-list`s; `scalar` is an f64 local or parameter.
     */
    type:
        | "f32"
        | "u32"
        | "f32-view"
        | "u8-view"
        | "f64-list"
        | "f64-list-2d"
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
}

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
            const declared = this.loopVariable(initializer);
            const lines = [
                `${indent}for (${declared}; ` +
                    `${this.condition(statement.condition)}; ` +
                    `${this.expressionStatement(statement.incrementor)}) {`,
                ...this.branch(statement.statement, indent),
                `${indent}}`,
            ];
            return lines;
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
            const shadowed = new Map<string, PinnedBinding | undefined>();
            for (const [name, binding] of resolved.bindings) {
                shadowed.set(name, this.scope.bindings.get(name));
                this.scope.bindings.set(name, binding);
            }
            const lines = [
                `${indent}for (const auto& ${element} : ${resolved.range}) {`,
                ...this.branch(statement.statement, indent),
                `${indent}}`,
            ];
            for (const [name, previous] of shadowed) {
                if (previous) this.scope.bindings.set(name, previous);
                else this.scope.bindings.delete(name);
            }
            return lines;
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
            return statement.statements.flatMap((inner) =>
                this.statement(inner, indent),
            );
        }
        return this.fail(statement, "statement");
    }

    private branch(statement: ts.Statement, indent: string): string[] {
        const inner = `${indent}    `;
        return ts.isBlock(statement)
            ? statement.statements.flatMap((s) => this.statement(s, inner))
            : this.statement(statement, inner);
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
        this.scope.bindings.set(name, { cpp: name, type: "index" });
        return (
            `std::int64_t ${name} = ` +
            `static_cast<std::int64_t>(${this.expression(declaration.initializer)})`
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
                const temporary = `pinned_${lines.length}_${
                    declaration.getStart(this.file)
                }`;
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
            if (!declaration.initializer) {
                // `let key: number;` assigned on both arms of an if. Zeroed
                // rather than left indeterminate so the emitted C++ stays
                // warning-clean; every reached path writes it first.
                this.scope.bindings.set(name, { cpp: name, type: "scalar" });
                lines.push(`${indent}double ${name} = 0.0;`);
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
                    : declaration.initializer.getText(this.file);
            const alias = this.scope.bindings.get(aliasKey);
            if (
                alias &&
                (alias.type === "f32" ||
                    alias.type === "u32" ||
                    alias.type === "f32-view" ||
                    alias.type === "u8-view")
            ) {
                this.scope.bindings.set(name, alias);
                continue;
            }
            // `const positions: number[] = []` -- a list the builder grows
            // with `push`. The pin holds these at double width and rounds
            // only at the `new F32(list)` that ends the builder, so the
            // storage is double and the rounding stays where the pin put it.
            const emptyList = this.unwrap(declaration.initializer);
            if (
                ts.isArrayLiteralExpression(emptyList) &&
                emptyList.elements.length === 0
            ) {
                this.scope.bindings.set(name, {
                    cpp: name,
                    type: "f64-list",
                });
                lines.push(`${indent}std::vector<double> ${name};`);
                continue;
            }
            // `const face = data.face[f]` -- one ROW of a jagged list,
            // which is a list. Bound to the row's own storage rather than
            // copied, because the pin reads it and never reseats it.
            const rowSource = this.unwrap(declaration.initializer);
            if (ts.isElementAccessExpression(rowSource)) {
                const owner = this.elementOwner(rowSource);
                if (owner?.type === "f64-list-2d") {
                    this.scope.bindings.set(name, {
                        cpp: this.elementAccess(rowSource),
                        type: "f64-list",
                    });
                    continue;
                }
            }
            const allocation = this.allocation(declaration.initializer);
            if (allocation) {
                this.scope.bindings.set(name, {
                    cpp: name,
                    type: allocation.type,
                    ...(allocation.bytesCpp
                        ? { bytesCpp: allocation.bytesCpp }
                        : {}),
                });
                lines.push(`${indent}${allocation.declare(name)}`);
                continue;
            }
            const initializer = this.unwrap(declaration.initializer);
            // A call the caller declared matrix-valued binds the fixed
            // matrix, so a later element read indexes it rather than
            // indexing a double.
            if (
                this.scope.matrixCalls &&
                ts.isCallExpression(initializer) &&
                ts.isIdentifier(initializer.expression) &&
                this.scope.matrixCalls.has(initializer.expression.text)
            ) {
                this.scope.bindings.set(name, { cpp: name, type: "f32" });
                lines.push(
                    `${indent}${isConst ? "const " : ""}` +
                        `std::array<float, 16> ${name} = ` +
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
                    cpp: name,
                    type: "f64-list",
                });
                lines.push(
                    `${indent}${isConst ? "const " : ""}` +
                        `std::vector<double> ${name} = ` +
                        `${this.expression(declaration.initializer)};`,
                );
                continue;
            }
            const isBoolean =
                initializer.kind === ts.SyntaxKind.TrueKeyword ||
                initializer.kind === ts.SyntaxKind.FalseKeyword;
            const value = this.expression(declaration.initializer);
            this.scope.bindings.set(name, {
                cpp: name,
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
                    `${isBoolean ? "bool" : "double"} ${name} = ${value};`,
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
        const source = ts.isIdentifier(argument)
            ? this.scope.bindings.get(argument.text)
            : undefined;
        if (source?.type === "u8-view") {
            if (constructor !== "U8" && constructor !== "F32") {
                return undefined;
            }
            const element = constructor === "U8" ? "std::uint8_t" : "float";
            return {
                type: constructor === "U8" ? "u8-view" : "f32-view",
                ...(source.bytesCpp ? { bytesCpp: source.bytesCpp } : {}),
                declare: (name) =>
                    `const ${element}* ${name} = ` +
                    `reinterpret_cast<const ${element}*>(${source.cpp});`,
            };
        }
        // `new F32(list)` over a grown `number[]` is the pin's own rounding
        // boundary: the list carried doubles, and this is where each one
        // becomes a float (or an index becomes a u32). Emitted as an
        // element-wise convert rather than a resize-and-copy so the cast is
        // visible at exactly the position the pin performs it.
        if (source?.type === "f64-list") {
            if (constructor === "F32") {
                return {
                    type: "f32",
                    declare: (name) =>
                        `std::vector<float> ${name}(${source.cpp}.begin(), ` +
                        `${source.cpp}.end());`,
                };
            }
            if (constructor === "U32") {
                return {
                    type: "u32",
                    declare: (name) =>
                        `std::vector<std::uint32_t> ${name}(` +
                        `${source.cpp}.begin(), ${source.cpp}.end());`,
                };
            }
            return undefined;
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
        // `new F64(n)` and `new Array<number>(n)` are the pin's own
        // full-width scratch: a zeroed buffer it indexes rather than grows,
        // and one whose stores round nowhere. It shares the growable list's
        // element type for exactly that reason.
        if (constructor === "F64" || constructor === "Array") {
            return {
                type: "f64-list",
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
        const text = this.expression(value);
        const unwrapped = this.unwrap(target);
        if (ts.isIdentifier(unwrapped)) {
            const binding = this.scope.bindings.get(unwrapped.text);
            if (binding?.type === "index") {
                return `static_cast<std::int64_t>(${text})`;
            }
        }
        const element = this.elementType(target);
        if (element === "float") return `static_cast<float>(${text})`;
        if (element === "std::uint32_t") {
            return `static_cast<std::uint32_t>(${text})`;
        }
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
        const element =
            node.expression.text === "F32"
                ? "float"
                : node.expression.text === "U32"
                  ? "std::uint32_t"
                  : undefined;
        return element === undefined
            ? undefined
            : `std::vector<${element}>(${source.cpp}.begin(), ` +
                  `${source.cpp}.end())`;
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
        const saved = new Map(this.scope.bindings);
        arrow.parameters.forEach((parameter, index) => {
            if (!ts.isIdentifier(parameter.name)) {
                this.fail(parameter, "helper parameter");
            }
            const argument = node.arguments[index]!;
            const unwrapped = this.unwrap(argument);
            const isBoolean =
                unwrapped.kind === ts.SyntaxKind.TrueKeyword ||
                unwrapped.kind === ts.SyntaxKind.FalseKeyword;
            this.scope.bindings.set(parameter.name.text, {
                cpp: this.expression(argument),
                type: isBoolean ? "bool" : "scalar",
            });
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
        const inner = guarded ? `${indent}    ` : indent;
        this.inlining += 1;
        const lines = arrow.body.statements.flatMap((nested) =>
            this.statement(nested, inner),
        );
        this.inlining -= 1;
        this.scope.bindings.clear();
        for (const [name, binding] of saved) {
            this.scope.bindings.set(name, binding);
        }
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
            : [header, ...lines];
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

    private elementType(target: ts.Expression): string | undefined {
        if (!ts.isElementAccessExpression(target)) return undefined;
        const binding = this.elementOwner(target);
        if (binding?.type === "f32") return "float";
        if (binding?.type === "u32") return "std::uint32_t";
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
        return this.scope.bindings.get(
            this.unwrap(expression.expression).getText(this.file),
        );
    }

    private assignmentTarget(expression: ts.Expression): string {
        const unwrapped = this.unwrap(expression);
        if (ts.isIdentifier(unwrapped)) {
            const binding = this.scope.bindings.get(unwrapped.text);
            if (!binding) this.fail(unwrapped, "assignment target");
            return binding.cpp;
        }
        if (ts.isElementAccessExpression(unwrapped)) {
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

    public expression(expression: ts.Expression): string {
        const node = this.unwrap(expression);
        if (ts.isNumericLiteral(node)) {
            return doubleLiteral(Number(node.text));
        }
        if (ts.isIdentifier(node)) {
            if (node.text === "Infinity") {
                return "std::numeric_limits<double>::infinity()";
            }
            const binding = this.scope.bindings.get(node.text);
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
            return `(${operator}${this.expression(node.operand)})`;
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
            // Every read widens to the f64 a JS number is. The f32 ROUND-TRIP
            // that `sortSplatsBackToFront` depends on is enforced on the
            // store side, by `storedValue`/`elementType`.
            return `static_cast<double>(${this.elementAccess(node)})`;
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
        return this.fail(node, "expression");
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
                binding.type === "f64-list" ||
                binding.type === "f64-list-2d"
            ) {
                return `static_cast<double>(${binding.cpp}.size())`;
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
            const list = this.scope.bindings.get(
                callee.expression.getText(this.file),
            );
            if (list?.type === "f64-list") {
                if (args.length === 0) {
                    this.fail(node, "push with no arguments");
                }
                const pushes = args.map(
                    (argument) => `${list.cpp}.push_back(${argument})`,
                );
                return args.length === 1
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
            case ts.SyntaxKind.BarBarToken:
                if (this.scope.booleanOr) {
                    return (
                        `(${this.expression(node.left)} || ` +
                        `${this.expression(node.right)})`
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
            case ts.SyntaxKind.AmpersandToken:
                // A mask over an integral loop counter (`corner & 1` picks
                // one AABB corner's axis). JavaScript coerces both sides to
                // int32 before masking, so the emitted form says that
                // rather than relying on either side already being one --
                // every other numeric local here is a double.
                return (
                    `(static_cast<std::int32_t>(` +
                    `${this.expression(node.left)}) & ` +
                    `static_cast<std::int32_t>(` +
                    `${this.expression(node.right)}))`
                );
            case ts.SyntaxKind.AmpersandAmpersandToken:
                if (this.scope.booleanAnd) {
                    return (
                        `(${this.expression(node.left)} && ` +
                        `${this.expression(node.right)})`
                    );
                }
                // The same hazard in the other direction. No pinned body
                // this translator serves uses it as a value yet, so it
                // refuses rather than guessing which meaning is wanted.
                return this.fail(node, "value-selecting '&&'");
            case ts.SyntaxKind.BarToken: {
                // `x | 0` is the pin's truncation to a 32-bit integer. Any
                // other bitwise use would need JS's full ToInt32 wrap and is
                // refused rather than approximated.
                const right = this.unwrap(node.right);
                if (
                    !ts.isNumericLiteral(right) ||
                    Number(right.text) !== 0
                ) {
                    this.fail(node, "bitwise expression");
                }
                return (
                    `static_cast<double>(static_cast<std::int32_t>(` +
                    `${this.expression(node.left)}))`
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

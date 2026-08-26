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
     * `scalar` is an f64 local or parameter.
     */
    type:
        | "f32"
        | "u32"
        | "f32-view"
        | "u8-view"
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
    /** This body uses `||` only to join boolean conditions. */
    booleanOr?: boolean;
    /** This body uses `&&` only to join boolean conditions. */
    booleanAnd?: boolean;
    /** Native option specialization may make a pinned fallback local dead. */
    maybeUnusedConst?: boolean;
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
    ) {}

    private fail(node: ts.Node, what: string): never {
        throw new Error(
            `Unsupported pinned ${what}: ${node.getText(this.file)}.`,
        );
    }

    public statement(statement: ts.Statement, indent: string): string[] {
        if (ts.isVariableStatement(statement)) {
            return this.declarations(
                statement.declarationList,
                indent,
            );
        }
        if (ts.isExpressionStatement(statement)) {
            return [
                `${indent}${this.expressionStatement(statement.expression)};`,
            ];
        }
        if (ts.isIfStatement(statement)) {
            const lines = [
                `${indent}if (${this.expression(statement.expression)}) {`,
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
                    `${this.expression(statement.condition)}; ` +
                    `${this.expressionStatement(statement.incrementor)}) {`,
                ...this.branch(statement.statement, indent),
                `${indent}}`,
            ];
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
            const alias = this.scope.bindings.get(
                declaration.initializer.getText(this.file),
            );
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
        const owner = this.unwrap(node.expression);
        if (!ts.isIdentifier(owner)) {
            this.fail(node, "property access");
        }
        const binding = this.scope.bindings.get(owner.text);
        if (binding && node.name.text === "length") {
            if (binding.type === "f32" || binding.type === "u32") {
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

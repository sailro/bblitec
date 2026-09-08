/**
 * The partial evaluator two lowerings share.
 *
 * The flow-graph lowering (`flow-graph-lowerer.ts`) and the live
 * node-particle lowering (`node-particle-live-lowerer.ts`) both evaluate
 * pinned bodies at generation over a static input -- a parsed graph -- and
 * both need the same interpreter for it: an environment chain, the
 * completion a statement list ends in, the ladder that resolves a free name
 * through a module's constants, functions and imports, JavaScript's
 * truthiness and `typeof`, and the walk over statements, expressions,
 * binaries and calls. That interpreter lives here once, over an abstract
 * VALUE the family defines through a `ValueModel`: what a literal is, how a
 * member is read off a value, what a call target is. Every residual arm --
 * a C++ expression standing in for a run-time value, the flow graph's
 * emitted `if` -- and every opaque tag stays the family's, reached through
 * the model's optional hooks, the way `ReferenceSchema` hands
 * `PinnedReferenceLowerer` its `expression`/`statement` hooks.
 *
 * A construct neither the walk nor the model evaluates refuses through the
 * model's `refuse`, by name, rather than approximating.
 */
import ts from "typescript";
import type { LoweringContext } from "./context.js";

/** A lexical environment: bindings by name, resolved through the parents. */
export class Env<B> {
    private readonly bindings = new Map<string, B>();

    public constructor(public readonly parent?: Env<B>) {}

    public lookup(name: string): B | undefined {
        return this.bindings.get(name) ?? this.parent?.lookup(name);
    }

    public declare(name: string, binding: B): void {
        this.bindings.set(name, binding);
    }
}

/** How a statement list ended. */
export type Completion<V> =
    | { kind: "normal" }
    | { kind: "return"; value: V }
    | { kind: "break" };

export const NORMAL: Completion<never> = { kind: "normal" };

/** JavaScript truthiness: decided at generation, or a C++ `bool`. */
export type Truth =
    | { k: "static"; value: boolean }
    | { k: "residual"; cpp: string };

/**
 * What the evaluator needs to know about a value to apply JavaScript's own
 * rules to it: a `value` is one generation holds outright (a primitive,
 * or plain data the family evaluated), an `object` or `function` is any
 * structured value the family owns, and a `residual` stands for a run-time
 * value whose truthiness and `typeof` the family answers for.
 */
export type Classified =
    | { k: "value"; raw: unknown }
    | { k: "object" }
    | { k: "function" }
    | {
          k: "residual";
          typeofName: string;
          truthiness: (at: ts.Node) => Truth;
      };

/** Where a pinned statement or expression is evaluated. */
export interface Frame<V, B> {
    env: Env<B>;
    file: ts.SourceFile;
    module: string;
    thisValue: V | undefined;
    /**
     * `emit`: a run-time `if` may emit a residual branch through the model;
     * `inline`: the body is being evaluated for its value, so a run-time
     * branch refuses. Every invoked closure or function runs inline.
     */
    mode: "emit" | "inline";
}

export function frame<V, B>(
    env: Env<B>,
    file: ts.SourceFile,
    module: string,
    thisValue: V | undefined = undefined,
    mode: Frame<V, B>["mode"] = "inline",
): Frame<V, B> {
    return { env, file, module, thisValue, mode };
}

/** A pinned module function the free-name ladder resolved. */
export interface PinnedDeclaration {
    declaration: ts.FunctionDeclaration;
    file: ts.SourceFile;
    module: string;
}

/** A call target the evaluator invokes itself. */
export type Callable<V, B> =
    | {
          k: "closure";
          node: ts.ArrowFunction | ts.FunctionExpression;
          env: Env<B>;
          file: ts.SourceFile;
          module: string;
      }
    | FunctionCallable<V>;

export interface FunctionCallable<V> {
    k: "function";
    declaration: ts.FunctionDeclaration | ts.MethodDeclaration;
    file: ts.SourceFile;
    module: string;
    thisValue?: V | undefined;
}

/** One member of an evaluated object literal, in the pin's order. */
export interface RecordEntry<V> {
    name: string;
    value: V;
    property: ts.ObjectLiteralElementLike;
}

/**
 * The family's side of the evaluation. `V` is the value, `B` the binding
 * a name resolves to (a value, or a cell around one).
 */
export interface ValueModel<V, B> {
    /** A value generation holds outright: a literal, or data the family evaluated. */
    raw(value: unknown): V;
    classify(value: V): Classified;
    /** What a `const` or `let` declaration binds. */
    declared(name: string, value: V, mutable: boolean): B;
    /** What a parameter binds. */
    parameter(value: V): B;
    valueOf(binding: B): V;
    /** `name = value` through the binding the name resolved to; refuses an immutable one. */
    assign(binding: B | undefined, value: V, target: ts.Identifier): void;
    /** A free name the language defines (`undefined`, `Math`, `Array`, ...). */
    builtin(name: string): V | undefined;
    /** A pinned module function as a value. */
    functionValue(fn: PinnedDeclaration): V;
    /** An arrow or function expression closing over the frame. */
    closure(
        node: ts.ArrowFunction | ts.FunctionExpression,
        frame: Frame<V, B>,
    ): V;
    /** The call target a value is, where it is one the evaluator invokes itself. */
    callable(value: V): Callable<V, B> | undefined;
    member(owner: V, name: string, at: ts.Node): V;
    element(owner: V, index: V, at: ts.Node): V;
    record(
        entries: readonly RecordEntry<V>[],
        node: ts.ObjectLiteralExpression,
    ): V;
    refuse(node: ts.Node, what: string): never;
    /** A node the family evaluates before the generic walk sees it. */
    expression?(
        node: ts.Expression,
        frame: Frame<V, B>,
        evaluator: PartialEvaluator<V, B>,
    ): V | undefined;
    statement?(
        node: ts.Statement,
        frame: Frame<V, B>,
        evaluator: PartialEvaluator<V, B>,
    ): Completion<V> | undefined;
    /** A method the family answers for, before the member is read and invoked. */
    methodCall?(
        owner: V,
        method: string,
        args: () => V[],
        node: ts.CallExpression,
        frame: Frame<V, B>,
    ): V | undefined;
    /** A call of a value that is neither a closure nor a pinned function. */
    invoke?(target: V, args: V[], site: ts.Node, name: string): V | undefined;
    /** A pinned function the family answers for instead of evaluating its body. */
    intercept?(fn: FunctionCallable<V>, args: V[], site: ts.Node): V | undefined;
    /** An assignment to something other than a name. */
    assignTarget?(
        target: ts.Expression,
        value: V,
        frame: Frame<V, B>,
        evaluator: PartialEvaluator<V, B>,
    ): V | undefined;
    /** `key in owner` over a value generation does not hold as data. */
    hasMember?(owner: V, key: string, at: ts.Node): boolean | undefined;
    /** The elements of a list the family built, for iteration and destructuring. */
    elements?(value: V, at: ts.Node): V[] | undefined;
    /** An array literal with an element generation does not hold as data. */
    array?(elements: V[], node: ts.ArrayLiteralExpression): V;
    /** Unary minus over a value that is not a known number. */
    negate?(operand: V, at: ts.Node): V;
    /** Equality where a side is residual. */
    equality?(left: V, right: V, equal: boolean, node: ts.BinaryExpression): V;
    /** A binary operator over operands that are not both known numbers. */
    binary?(kind: ts.SyntaxKind, left: V, right: V, node: ts.BinaryExpression): V;
    /** The run-time arms: what a residual condition selects or emits. */
    residual?: {
        not(cpp: string, at: ts.Node): V;
        select(cpp: string, whenTrue: V, whenFalse: V, at: ts.Node): V;
        join(
            or: boolean,
            leftCpp: string,
            left: V,
            right: V,
            node: ts.BinaryExpression,
        ): V;
        ifStatement(
            cpp: string,
            statement: ts.IfStatement,
            branch: (statement: ts.Statement) => Completion<V>,
        ): Completion<V>;
    };
}

/** JavaScript's `typeof` of a value generation holds. */
export function jsTypeof(raw: unknown): string {
    return raw === null ? "object" : typeof raw;
}

export class PartialEvaluator<V, B> {
    /** The pinned functions called by name from outside a body, resolved once each. */
    private readonly pinnedFunctions = new Map<string, FunctionCallable<V>>();

    public constructor(
        private readonly context: LoweringContext,
        private readonly model: ValueModel<V, B>,
        /**
         * The module-scope environments, where constants and functions
         * resolve lazily. Shared by a caller that evaluates one program
         * through several evaluators.
         */
        private readonly moduleEnvs: Map<string, Env<B>> = new Map(),
    ) {}

    public moduleEnv(module: string): Env<B> {
        let env = this.moduleEnvs.get(module);
        if (!env) {
            env = new Env<B>();
            this.moduleEnvs.set(module, env);
        }
        return env;
    }

    private fail(node: ts.Node, what: string): never {
        return this.model.refuse(node, what);
    }

    // ── Values ────────────────────────────────────────────────────────────

    public isNullish(value: V): boolean {
        const classified = this.model.classify(value);
        return (
            classified.k === "value" &&
            (classified.raw === undefined || classified.raw === null)
        );
    }

    /** JavaScript truthiness, static where the value is, else a C++ bool. */
    public truthiness(value: V, at: ts.Node): Truth {
        const classified = this.model.classify(value);
        switch (classified.k) {
            case "value":
                return { k: "static", value: Boolean(classified.raw) };
            case "residual":
                return classified.truthiness(at);
            default:
                return { k: "static", value: true };
        }
    }

    public typeofName(value: V): string {
        const classified = this.model.classify(value);
        switch (classified.k) {
            case "value":
                return jsTypeof(classified.raw);
            case "residual":
                return classified.typeofName;
            default:
                return classified.k;
        }
    }

    /** `===` over two values, where generation can decide it. */
    private strictEquals(left: V, right: V, at: ts.Node): boolean {
        const l = this.model.classify(left);
        const r = this.model.classify(right);
        if (l.k === "residual" || r.k === "residual") {
            return this.fail(at, "comparison over a run-time value");
        }
        if (l.k === "value" && r.k === "value") return l.raw === r.raw;
        // An object never equals a primitive, and two objects are the
        // same only as the same value.
        return l.k !== "value" && r.k !== "value" && left === right;
    }

    /** The elements of a list: static data, or a list the family built. */
    public elements(value: V, at: ts.Node): V[] {
        const built = this.model.elements?.(value, at);
        if (built) return built;
        const classified = this.model.classify(value);
        if (classified.k === "value" && Array.isArray(classified.raw)) {
            return classified.raw.map((element) => this.model.raw(element));
        }
        return this.fail(at, "iteration over a run-time list");
    }

    // ── Statements ────────────────────────────────────────────────────────

    public statements(
        list: readonly ts.Statement[],
        frame: Frame<V, B>,
    ): Completion<V> {
        for (const statement of list) {
            const completion = this.statement(statement, frame);
            if (completion.kind !== "normal") return completion;
        }
        return NORMAL;
    }

    public statement(
        statement: ts.Statement,
        frame: Frame<V, B>,
    ): Completion<V> {
        const adapted = this.model.statement?.(statement, frame, this);
        if (adapted !== undefined) return adapted;
        if (ts.isVariableStatement(statement)) {
            const mutable =
                (statement.declarationList.flags & ts.NodeFlags.Const) === 0;
            for (const declaration of statement.declarationList.declarations) {
                const value = declaration.initializer
                    ? this.expression(declaration.initializer, frame)
                    : this.model.raw(undefined);
                this.bindPattern(
                    declaration.name,
                    value,
                    frame,
                    (name, bound) => this.model.declared(name, bound, mutable),
                );
            }
            return NORMAL;
        }
        if (ts.isExpressionStatement(statement)) {
            this.expression(statement.expression, frame);
            return NORMAL;
        }
        if (ts.isIfStatement(statement)) {
            const known = this.truthiness(
                this.expression(statement.expression, frame),
                statement.expression,
            );
            const branch = (target: ts.Statement): Completion<V> =>
                this.statement(target, { ...frame, env: new Env(frame.env) });
            if (known.k === "static") {
                if (known.value) return branch(statement.thenStatement);
                return statement.elseStatement
                    ? branch(statement.elseStatement)
                    : NORMAL;
            }
            if (frame.mode === "inline" || !this.model.residual) {
                this.fail(
                    statement,
                    "run-time branch inside an inlined pinned body",
                );
            }
            return this.model.residual.ifStatement(known.cpp, statement, branch);
        }
        if (ts.isBlock(statement)) {
            return this.statements(statement.statements, {
                ...frame,
                env: new Env(frame.env),
            });
        }
        if (ts.isReturnStatement(statement)) {
            return {
                kind: "return",
                value: statement.expression
                    ? this.expression(statement.expression, frame)
                    : this.model.raw(undefined),
            };
        }
        if (ts.isBreakStatement(statement)) return { kind: "break" };
        if (ts.isForOfStatement(statement)) {
            const iterated = this.expression(statement.expression, frame);
            const elements = this.elements(iterated, statement.expression);
            const initializer = statement.initializer;
            if (
                !ts.isVariableDeclarationList(initializer) ||
                initializer.declarations.length !== 1
            ) {
                this.fail(statement, "for-of initializer");
            }
            for (const element of elements) {
                const scope: Frame<V, B> = { ...frame, env: new Env(frame.env) };
                this.bindPattern(
                    initializer.declarations[0]!.name,
                    element,
                    scope,
                    (name, bound) => this.model.declared(name, bound, false),
                );
                const completion = this.statement(statement.statement, scope);
                if (completion.kind === "break") break;
                if (completion.kind === "return") return completion;
            }
            return NORMAL;
        }
        if (ts.isSwitchStatement(statement)) {
            const discriminant = this.expression(statement.expression, frame);
            const clauses = statement.caseBlock.clauses;
            let selected = clauses.findIndex(
                (clause) =>
                    ts.isCaseClause(clause) &&
                    this.strictEquals(
                        discriminant,
                        this.expression(clause.expression, frame),
                        clause,
                    ),
            );
            if (selected < 0) selected = clauses.findIndex(ts.isDefaultClause);
            if (selected < 0) return NORMAL;
            const scope: Frame<V, B> = { ...frame, env: new Env(frame.env) };
            for (let index = selected; index < clauses.length; index += 1) {
                const completion = this.statements(
                    clauses[index]!.statements,
                    scope,
                );
                if (completion.kind === "break") return NORMAL;
                if (completion.kind === "return") return completion;
            }
            return NORMAL;
        }
        if (ts.isThrowStatement(statement)) {
            return this.context.contractError(
                statement,
                "The pinned body reaches a throw at generation.",
            );
        }
        return this.fail(statement, "statement");
    }

    /** Bind a declaration or parameter name, destructuring where the pin does. */
    private bindPattern(
        name: ts.BindingName,
        value: V,
        frame: Frame<V, B>,
        bind: (name: string, value: V) => B,
    ): void {
        if (ts.isIdentifier(name)) {
            frame.env.declare(name.text, bind(name.text, value));
            return;
        }
        if (ts.isArrayBindingPattern(name)) {
            const elements = this.elements(value, name);
            name.elements.forEach((element, index) => {
                if (ts.isOmittedExpression(element)) return;
                if (!ts.isIdentifier(element.name) || element.dotDotDotToken) {
                    this.fail(element, "binding element");
                }
                frame.env.declare(
                    element.name.text,
                    bind(
                        element.name.text,
                        elements[index] ?? this.model.raw(undefined),
                    ),
                );
            });
            return;
        }
        for (const element of name.elements) {
            if (!ts.isIdentifier(element.name) || element.dotDotDotToken) {
                this.fail(element, "binding element");
            }
            const property = element.propertyName
                ? element.propertyName.getText(frame.file)
                : element.name.text;
            frame.env.declare(
                element.name.text,
                bind(element.name.text, this.model.member(value, property, element)),
            );
        }
    }

    // ── Expressions ───────────────────────────────────────────────────────

    public expression(expression: ts.Expression, frame: Frame<V, B>): V {
        const node = this.context.unwrapExpression(expression);
        const adapted = this.model.expression?.(node, frame, this);
        if (adapted !== undefined) return adapted;
        if (ts.isNumericLiteral(node)) return this.model.raw(Number(node.text));
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            return this.model.raw(node.text);
        }
        if (ts.isTemplateExpression(node)) {
            let text = node.head.text;
            for (const span of node.templateSpans) {
                const value = this.model.classify(this.expression(span.expression, frame));
                if (value.k !== "value") this.fail(span, "template over a run-time value");
                text += `${String(value.raw)}${span.literal.text}`;
            }
            return this.model.raw(text);
        }
        if (node.kind === ts.SyntaxKind.TrueKeyword) return this.model.raw(true);
        if (node.kind === ts.SyntaxKind.FalseKeyword) return this.model.raw(false);
        if (node.kind === ts.SyntaxKind.NullKeyword) return this.model.raw(null);
        if (node.kind === ts.SyntaxKind.ThisKeyword) {
            return frame.thisValue ?? this.fail(node, "this outside a method");
        }
        if (ts.isIdentifier(node)) {
            const bound = frame.env.lookup(node.text);
            if (bound) return this.model.valueOf(bound);
            return this.resolveFree(node.text, frame.file, frame.module, node);
        }
        if (ts.isPropertyAccessExpression(node)) {
            const owner = this.expression(node.expression, frame);
            if (node.questionDotToken && this.isNullish(owner)) {
                return this.model.raw(undefined);
            }
            return this.model.member(owner, node.name.text, node);
        }
        if (ts.isElementAccessExpression(node)) {
            const owner = this.expression(node.expression, frame);
            if (node.questionDotToken && this.isNullish(owner)) {
                return this.model.raw(undefined);
            }
            const index = this.expression(node.argumentExpression, frame);
            return this.model.element(owner, index, node);
        }
        if (ts.isTypeOfExpression(node)) {
            return this.model.raw(this.typeofName(this.expression(node.expression, frame)));
        }
        if (ts.isPrefixUnaryExpression(node)) {
            const operand = this.expression(node.operand, frame);
            if (node.operator === ts.SyntaxKind.ExclamationToken) {
                const known = this.truthiness(operand, node.operand);
                if (known.k === "static") return this.model.raw(!known.value);
                return this.model.residual
                    ? this.model.residual.not(known.cpp, node)
                    : this.fail(node, "negation of a run-time value");
            }
            if (node.operator === ts.SyntaxKind.MinusToken) {
                const classified = this.model.classify(operand);
                if (classified.k === "value" && typeof classified.raw === "number") {
                    return this.model.raw(-classified.raw);
                }
                return this.model.negate?.(operand, node) ?? this.fail(node, "prefix operator");
            }
            return this.fail(node, "prefix operator");
        }
        if (ts.isConditionalExpression(node)) {
            const condition = this.truthiness(
                this.expression(node.condition, frame),
                node.condition,
            );
            if (condition.k === "static") {
                return this.expression(condition.value ? node.whenTrue : node.whenFalse, frame);
            }
            if (!this.model.residual) this.fail(node, "conditional over a run-time value");
            return this.model.residual.select(
                condition.cpp,
                this.expression(node.whenTrue, frame),
                this.expression(node.whenFalse, frame),
                node,
            );
        }
        if (ts.isBinaryExpression(node)) return this.binary(node, frame);
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
            return this.model.closure(node, frame);
        }
        if (ts.isObjectLiteralExpression(node)) {
            const entries: RecordEntry<V>[] = [];
            for (const property of node.properties) {
                if (ts.isShorthandPropertyAssignment(property)) {
                    entries.push({
                        name: property.name.text,
                        value: this.expression(property.name, frame),
                        property,
                    });
                    continue;
                }
                if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
                    this.fail(property, "object literal member");
                }
                entries.push({
                    name: property.name.text,
                    value: this.expression(property.initializer, frame),
                    property,
                });
            }
            return this.model.record(entries, node);
        }
        if (ts.isArrayLiteralExpression(node)) {
            const elements = node.elements.map((element) => this.expression(element, frame));
            const known = elements.map((element) => this.model.classify(element));
            if (known.every((element) => element.k === "value")) {
                return this.model.raw(
                    known.map((element) => (element as { raw: unknown }).raw),
                );
            }
            return this.model.array?.(elements, node) ?? this.fail(node, "array literal over a run-time value");
        }
        if (ts.isCallExpression(node)) return this.call(node, frame);
        if (ts.isNewExpression(node)) return this.fail(node, "constructor call");
        return this.fail(node, "expression");
    }

    private binary(node: ts.BinaryExpression, frame: Frame<V, B>): V {
        const kind = node.operatorToken.kind;
        if (kind === ts.SyntaxKind.EqualsToken) return this.assign(node, frame);
        if (
            kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            kind === ts.SyntaxKind.BarBarToken
        ) {
            const left = this.expression(node.left, frame);
            const or = kind === ts.SyntaxKind.BarBarToken;
            const known = this.truthiness(left, node.left);
            if (known.k === "static") {
                if (or ? known.value : !known.value) return left;
                return this.expression(node.right, frame);
            }
            const right = this.expression(node.right, frame);
            if (!this.model.residual) this.fail(node, "boolean join over a run-time value");
            return this.model.residual.join(or, known.cpp, left, right, node);
        }
        if (kind === ts.SyntaxKind.QuestionQuestionToken) {
            const left = this.expression(node.left, frame);
            return this.isNullish(left) ? this.expression(node.right, frame) : left;
        }
        if (kind === ts.SyntaxKind.InKeyword) {
            const key = this.model.classify(this.expression(node.left, frame));
            const owner = this.expression(node.right, frame);
            if (key.k !== "value" || typeof key.raw !== "string") {
                this.fail(node, "in over a run-time key");
            }
            const held = this.model.classify(owner);
            if (held.k === "value") {
                return this.model.raw(
                    typeof held.raw === "object" && held.raw !== null && key.raw in held.raw,
                );
            }
            const answer = this.model.hasMember?.(owner, key.raw, node);
            if (answer === undefined) this.fail(node, "in");
            return this.model.raw(answer);
        }
        const left = this.expression(node.left, frame);
        const right = this.expression(node.right, frame);
        const equality =
            kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            kind === ts.SyntaxKind.EqualsEqualsToken
                ? true
                : kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
                    kind === ts.SyntaxKind.ExclamationEqualsToken
                  ? false
                  : undefined;
        if (equality !== undefined) {
            const l = this.model.classify(left);
            const r = this.model.classify(right);
            if (l.k !== "residual" && r.k !== "residual") {
                const loose =
                    kind === ts.SyntaxKind.EqualsEqualsToken ||
                    kind === ts.SyntaxKind.ExclamationEqualsToken;
                // The one loose comparison a pinned body makes is `!= null`,
                // under which both nullish values agree.
                const equal =
                    loose && (this.isNullish(left) || this.isNullish(right))
                        ? this.isNullish(left) && this.isNullish(right)
                        : this.strictEquals(left, right, node);
                return this.model.raw(equal === equality);
            }
            return (
                this.model.equality?.(left, right, equality, node) ??
                this.fail(node, "equality over a run-time value")
            );
        }
        const l = this.model.classify(left);
        const r = this.model.classify(right);
        if (l.k === "value" && r.k === "value") {
            const a = l.raw;
            const b = r.raw;
            if (
                kind === ts.SyntaxKind.PlusToken &&
                (typeof a === "string" || typeof b === "string")
            ) {
                return this.model.raw(String(a) + String(b));
            }
            if (typeof a !== "number" || typeof b !== "number") {
                this.fail(node, "operator over non-numbers");
            }
            switch (kind) {
                case ts.SyntaxKind.PlusToken: return this.model.raw(a + b);
                case ts.SyntaxKind.MinusToken: return this.model.raw(a - b);
                case ts.SyntaxKind.AsteriskToken: return this.model.raw(a * b);
                case ts.SyntaxKind.SlashToken: return this.model.raw(a / b);
                case ts.SyntaxKind.PercentToken: return this.model.raw(a % b);
                case ts.SyntaxKind.LessThanToken: return this.model.raw(a < b);
                case ts.SyntaxKind.LessThanEqualsToken: return this.model.raw(a <= b);
                case ts.SyntaxKind.GreaterThanToken: return this.model.raw(a > b);
                case ts.SyntaxKind.GreaterThanEqualsToken: return this.model.raw(a >= b);
                case ts.SyntaxKind.BarToken: return this.model.raw(a | b);
                default: return this.fail(node, "operator");
            }
        }
        return (
            this.model.binary?.(kind, left, right, node) ??
            this.fail(node, "binary operator")
        );
    }

    private assign(node: ts.BinaryExpression, frame: Frame<V, B>): V {
        const value = this.expression(node.right, frame);
        const target = this.context.unwrapExpression(node.left);
        if (ts.isIdentifier(target)) {
            this.model.assign(frame.env.lookup(target.text), value, target);
            return value;
        }
        return (
            this.model.assignTarget?.(target, value, frame, this) ??
            this.fail(target, "assignment target")
        );
    }

    // ── Calls ─────────────────────────────────────────────────────────────

    private call(node: ts.CallExpression, frame: Frame<V, B>): V {
        const callee = this.context.unwrapExpression(node.expression);
        const args = (): V[] =>
            node.arguments.map((argument) => this.expression(argument, frame));
        if (ts.isIdentifier(callee)) {
            const bound = frame.env.lookup(callee.text);
            const target = bound
                ? this.model.valueOf(bound)
                : this.resolveFree(callee.text, frame.file, frame.module, callee);
            return this.invoke(target, args(), node, frame, callee.text);
        }
        if (ts.isPropertyAccessExpression(callee)) {
            const owner = this.expression(callee.expression, frame);
            if (
                (node.questionDotToken || callee.questionDotToken) &&
                this.isNullish(owner)
            ) {
                return this.model.raw(undefined);
            }
            const method = callee.name.text;
            const answered = this.model.methodCall?.(owner, method, args, node, frame);
            if (answered !== undefined) return answered;
            return this.invoke(
                this.model.member(owner, method, callee),
                args(),
                node,
                frame,
                method,
            );
        }
        return this.invoke(
            this.expression(callee, frame),
            args(),
            node,
            frame,
            callee.getText(frame.file),
        );
    }

    /** Call a value: a closure or pinned function runs here, anything else is the model's. */
    public invoke(
        target: V,
        args: V[],
        site: ts.Node,
        frame: Frame<V, B>,
        name: string,
    ): V {
        const callable = this.model.callable(target);
        if (callable?.k === "closure") {
            const scope = new Env(callable.env);
            const inner: Frame<V, B> = {
                env: scope,
                file: callable.file,
                module: callable.module,
                thisValue: frame.thisValue,
                mode: "inline",
            };
            callable.node.parameters.forEach((parameter, index) => {
                this.bindPattern(
                    parameter.name,
                    args[index] ?? this.model.raw(undefined),
                    inner,
                    (_name, value) => this.model.parameter(value),
                );
            });
            const body = callable.node.body;
            if (!ts.isBlock(body)) return this.expression(body, inner);
            const completion = this.statements(body.statements, inner);
            return completion.kind === "return"
                ? completion.value
                : this.model.raw(undefined);
        }
        if (callable?.k === "function") return this.callFunction(callable, args, site);
        return (
            this.model.invoke?.(target, args, site, name) ??
            this.fail(site, `call of ${name}`)
        );
    }

    /** A pinned function over evaluated arguments, unless the model intercepts it. */
    public callFunction(fn: FunctionCallable<V>, args: V[], site: ts.Node): V {
        const intercepted = this.model.intercept?.(fn, args, site);
        if (intercepted !== undefined) return intercepted;
        const scope = new Env(this.moduleEnv(fn.module));
        const inner: Frame<V, B> = {
            env: scope,
            file: fn.file,
            module: fn.module,
            thisValue: fn.thisValue,
            mode: "inline",
        };
        fn.declaration.parameters.forEach((parameter, index) => {
            this.bindPattern(
                parameter.name,
                args[index] ?? this.model.raw(undefined),
                inner,
                (_name, value) => this.model.parameter(value),
            );
        });
        const completion = this.statements(fn.declaration.body!.statements, inner);
        if (completion.kind === "break") {
            this.context.contractError(site, "A function broke out of nothing.");
        }
        return completion.kind === "return"
            ? completion.value
            : this.model.raw(undefined);
    }

    /** A pinned function called by name, from outside a body. */
    public callPinned(module: string, name: string, args: V[]): V {
        const key = `${module}#${name}`;
        let fn = this.pinnedFunctions.get(key);
        if (!fn) {
            const { file, declaration } = this.context.functionDeclaration(module, name);
            fn = { k: "function", declaration, file, module };
            this.pinnedFunctions.set(key, fn);
        }
        return this.callFunction(fn, args, fn.declaration);
    }

    // ── Free names ────────────────────────────────────────────────────────

    /**
     * A name no local declared: a builtin, a module constant, a same-module
     * function or a named import -- or undefined when the module declares
     * none of these.
     */
    public findFree(
        name: string,
        file: ts.SourceFile,
        module: string,
    ): V | undefined {
        const env = this.moduleEnv(module);
        const cached = env.lookup(name);
        if (cached) return this.model.valueOf(cached);
        const builtin = this.model.builtin(name);
        if (builtin !== undefined) return builtin;
        const constant = this.context.moduleScopeConstant(file, name);
        if (constant) {
            const value = this.expression(constant, frame(env, file, module));
            env.declare(name, this.model.declared(name, value, false));
            return value;
        }
        const declaration = file.statements.find(
            (statement): statement is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(statement) &&
                statement.name?.text === name &&
                statement.body !== undefined,
        );
        if (declaration) {
            const value = this.model.functionValue({ declaration, file, module });
            env.declare(name, this.model.declared(name, value, false));
            return value;
        }
        const imported = this.context.moduleOfImport(module, name);
        if (imported) {
            const value = this.findFree(name, this.context.sourceFile(imported), imported);
            if (value !== undefined) env.declare(name, this.model.declared(name, value, false));
            return value;
        }
        return undefined;
    }

    public resolveFree(
        name: string,
        file: ts.SourceFile,
        module: string,
        site: ts.Node,
    ): V {
        return (
            this.findFree(name, file, module) ??
            this.context.contractError(site, `The pinned body reads '${name}', which resolves to nothing.`)
        );
    }
}

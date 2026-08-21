import ts from "typescript";
import type { LoweringContext } from "./context.js";

/**
 * A bounded evaluator for the pin's shader-text builders.
 *
 * Upstream writes each shader as a TypeScript function that returns WGSL,
 * branching on a handful of permutation flags. Reconstructing the text by
 * folding those branches keeps the shader OWNED by the pin: a bump that
 * rewrites the arithmetic changes what we emit, and a bump that changes the
 * SHAPE (a new statement kind, a branch on an unbound name) refuses
 * generation rather than silently keeping our copy. Transcribing the WGSL
 * would forfeit both properties.
 *
 * What it evaluates is deliberately small — string and template literals,
 * `const` bindings, `if`/`switch`/conditional branches over bound values,
 * the arithmetic a binding index takes, a counted `for` whose bound settles
 * to zero trips, and calls to builders whose parameters bind positionally,
 * in this module or one it imports. Anything else is a contract error, which
 * is the point: the evaluator is a proof that the pinned text still has the
 * shape we think it has.
 *
 * Callers bind the permutation: a flag the scene settles at compile time
 * (`hasDepth`, `orientation`) enters as a value here, and a name the
 * evaluator cannot resolve — an imported constant, say — is supplied
 * through `constants` so the module it lives in stays the module that owns
 * it.
 */
/**
 * One record in a list the pin loops over — an extra texture's `name`, or a
 * `defines` entry whose `value` decides both the WGSL type word and the
 * literal, which is why a field is not only a string.
 */
export type ShaderTextRecord = Readonly<
    Record<string, string | boolean | number>
>;

export type ShaderTextBinding =
    | string
    | boolean
    | number
    | ShaderTextRecord
    | readonly ShaderTextRecord[];

/** The arithmetic a binding computation uses: a binding index, a stride. */
const ARITHMETIC = new Map<
    ts.SyntaxKind,
    (left: number, right: number) => number
>([
    [ts.SyntaxKind.PlusToken, (left, right) => left + right],
    [ts.SyntaxKind.AsteriskToken, (left, right) => left * right],
]);

/**
 * The most trips a folded loop may take. A shader builder emits a line or
 * two per bound element; a count past this is a bound that stopped settling,
 * which refuses rather than hanging generation.
 */
const MAX_LOOP_TRIPS = 1024;

/** The comparison a counted loop bounds itself with. */
const RELATIONS = new Map<
    ts.SyntaxKind,
    (left: number, right: number) => boolean
>([[ts.SyntaxKind.LessThanToken, (left, right) => left < right]]);

/**
 * The host functions a pinned text builder calls on a bound value rather
 * than declaring itself. `formatDefineValue` reaches both: it separates an
 * integer define from a fractional one and prints whichever it got. They
 * are listed rather than dispatched by name so a builder reaching a third
 * one refuses instead of evaluating something this table never checked.
 */
const HOST_CALLS = new Map<
    string,
    (argument: ShaderTextBinding) => ShaderTextBinding
>([
    [
        "Number.isInteger",
        (argument) =>
            typeof argument === "number" && Number.isInteger(argument),
    ],
    ["String", (argument) => String(argument)],
]);

function isRecord(
    value: ShaderTextBinding,
): value is ShaderTextRecord {
    return typeof value === "object" && !Array.isArray(value);
}

export class PinnedShaderText {
    public constructor(
        private readonly context: LoweringContext,
        /** Module-scope names the pin's builders read but do not declare. */
        private readonly constants: ReadonlyMap<string, string> = new Map(),
    ) {}

    /**
     * The text a pinned builder returns for one permutation. Parameters bind
     * by name, so the caller states the permutation in the pin's own
     * vocabulary rather than by argument position.
     */
    public evaluate(
        modulePath: string,
        symbolName: string,
        parameters: ReadonlyMap<string, ShaderTextBinding>,
    ): string {
        const { declaration } = this.context.functionDeclaration(
            modulePath,
            symbolName,
        );
        const scope = new Map(parameters);
        this.bindDefaults(declaration, scope, modulePath);
        const returned = this.evaluateStatements(
            declaration.body!.statements,
            scope,
            modulePath,
            symbolName,
        );
        if (returned === undefined) {
            return this.context.contractError(
                declaration,
                `Pinned ${symbolName} has no return statement.`,
            );
        }
        return returned;
    }

    /**
     * A parameter the caller left unbound takes the pin's own default, so a
     * permutation only has to name what it actually varies.
     */
    private bindDefaults(
        declaration: ts.FunctionDeclaration,
        scope: Map<string, ShaderTextBinding>,
        modulePath: string,
    ): void {
        for (const parameter of declaration.parameters) {
            if (
                !ts.isIdentifier(parameter.name) ||
                scope.has(parameter.name.text)
            ) {
                continue;
            }
            if (!parameter.initializer) {
                this.context.contractError(
                    parameter,
                    `Pinned shader builder parameter '${parameter.name.getText()}' is unbound and has no default.`,
                );
            }
            scope.set(
                parameter.name.text,
                this.evaluateValue(
                    parameter.initializer,
                    scope,
                    modulePath,
                ),
            );
        }
    }

    /**
     * Runs a statement list, returning the returned text or undefined when
     * control falls off the end (a `switch` case that breaks, say).
     */
    private evaluateStatements(
        statements: readonly ts.Statement[],
        scope: Map<string, ShaderTextBinding>,
        modulePath: string,
        symbolName: string,
    ): string | undefined {
        for (const statement of statements) {
            if (ts.isVariableStatement(statement)) {
                for (const binding of statement.declarationList
                    .declarations) {
                    if (
                        !ts.isIdentifier(binding.name) ||
                        !binding.initializer
                    ) {
                        this.context.contractError(
                            binding,
                            `Unsupported binding in pinned ${symbolName}.`,
                        );
                    }
                    scope.set(
                        binding.name.text,
                        this.evaluateValue(
                            binding.initializer,
                            scope,
                            modulePath,
                        ),
                    );
                }
                continue;
            }
            if (ts.isReturnStatement(statement)) {
                if (!statement.expression) {
                    this.context.contractError(
                        statement,
                        `Pinned ${symbolName} returns nothing.`,
                    );
                }
                return this.evaluateString(
                    statement.expression,
                    scope,
                    modulePath,
                );
            }
            if (ts.isIfStatement(statement)) {
                const taken = this.condition(
                    statement.expression,
                    scope,
                    modulePath,
                )
                    ? statement.thenStatement
                    : statement.elseStatement;
                if (!taken) {
                    continue;
                }
                const returned = this.evaluateStatements(
                    ts.isBlock(taken) ? taken.statements : [taken],
                    scope,
                    modulePath,
                    symbolName,
                );
                if (returned !== undefined) {
                    return returned;
                }
                continue;
            }
            if (ts.isSwitchStatement(statement)) {
                const subject = this.evaluateValue(
                    statement.expression,
                    scope,
                    modulePath,
                );
                for (const clause of statement.caseBlock.clauses) {
                    const matches = ts.isDefaultClause(clause)
                        ? true
                        : this.evaluateValue(
                              clause.expression,
                              scope,
                              modulePath,
                          ) === subject;
                    if (!matches) {
                        continue;
                    }
                    const returned = this.evaluateStatements(
                        clause.statements,
                        scope,
                        modulePath,
                        symbolName,
                    );
                    if (returned !== undefined) {
                        return returned;
                    }
                    break;
                }
                continue;
            }
            if (ts.isForStatement(statement)) {
                const returned = this.evaluateFor(
                    statement,
                    scope,
                    modulePath,
                    symbolName,
                );
                if (returned !== undefined) {
                    return returned;
                }
                continue;
            }
            // `out += ...`, which is how a builder accumulates one line per
            // element of a bound list.
            if (
                ts.isExpressionStatement(statement) &&
                ts.isBinaryExpression(statement.expression) &&
                statement.expression.operatorToken.kind ===
                    ts.SyntaxKind.PlusEqualsToken &&
                ts.isIdentifier(statement.expression.left)
            ) {
                const name = statement.expression.left.text;
                const current = scope.get(name);
                if (typeof current !== "string") {
                    this.context.contractError(
                        statement,
                        `Pinned ${symbolName} appends to '${name}', which is not accumulated text.`,
                    );
                }
                scope.set(
                    name,
                    current +
                        this.evaluateString(
                            statement.expression.right,
                            scope,
                            modulePath,
                        ),
                );
                continue;
            }
            if (statement.kind === ts.SyntaxKind.BreakStatement) {
                return undefined;
            }
            this.context.contractError(
                statement,
                `Unsupported statement in pinned ${symbolName}.`,
            );
        }
        return undefined;
    }

    /**
     * A counted `for` over a bound list, which is how the pin emits one
     * binding pair per extra texture. The bound is a value this evaluator
     * already resolved, so the loop runs a settled number of times or the
     * shape refuses -- there is no unbounded iteration to guard against.
     */
    private evaluateFor(
        statement: ts.ForStatement,
        scope: Map<string, ShaderTextBinding>,
        modulePath: string,
        symbolName: string,
    ): string | undefined {
        const list = statement.initializer;
        if (
            !list ||
            !ts.isVariableDeclarationList(list) ||
            list.declarations.length !== 1 ||
            !statement.condition ||
            !statement.incrementor
        ) {
            this.context.contractError(
                statement,
                `Pinned ${symbolName} loops in a shape this evaluator cannot fold.`,
            );
        }
        const counter = list.declarations[0]!;
        if (
            !ts.isIdentifier(counter.name) ||
            !counter.initializer
        ) {
            this.context.contractError(
                counter,
                `Pinned ${symbolName} loops on a binding this evaluator cannot fold.`,
            );
        }
        scope.set(
            counter.name.text,
            this.evaluateValue(
                counter.initializer,
                scope,
                modulePath,
            ),
        );
        const body = ts.isBlock(statement.statement)
            ? statement.statement.statements
            : [statement.statement];
        // A `break` leaves `evaluateStatements` looking exactly like a body
        // that ran to its end, which here would mean "keep looping". No
        // pinned builder uses one, so a loop carrying one refuses rather
        // than folding text from a trip the pin would not have taken.
        if (
            this.context.hasNode(
                statement.statement,
                (node) =>
                    node.kind === ts.SyntaxKind.BreakStatement ||
                    node.kind === ts.SyntaxKind.ContinueStatement,
            )
        ) {
            this.context.contractError(
                statement,
                `Pinned ${symbolName} breaks out of a loop, which this evaluator does not fold.`,
            );
        }
        // The counter steps by one and the bound is a resolved value, so the
        // trip count is settled -- but it is capped anyway, because the
        // alternative to refusing is a generation that never returns.
        const step = this.context.unwrapExpression(
            statement.incrementor,
        );
        if (
            !ts.isPostfixUnaryExpression(step) ||
            !ts.isIdentifier(step.operand) ||
            step.operator !== ts.SyntaxKind.PlusPlusToken
        ) {
            this.context.contractError(
                step,
                `Pinned ${symbolName} steps a loop in a way this evaluator cannot fold.`,
            );
        }
        for (
            let trip = 0;
            this.condition(
                statement.condition,
                scope,
                modulePath,
            );
            trip += 1
        ) {
            if (trip > MAX_LOOP_TRIPS) {
                this.context.contractError(
                    statement,
                    `Pinned ${symbolName} loops past ${MAX_LOOP_TRIPS} trips, which no shader builder does.`,
                );
            }
            const returned = this.evaluateStatements(
                body,
                scope,
                modulePath,
                symbolName,
            );
            if (returned !== undefined) {
                return returned;
            }
            scope.set(
                step.operand.text,
                this.number(step.operand, scope, modulePath) + 1,
            );
        }
        return undefined;
    }

    /** A branch condition, which must fold to a bound boolean or comparison. */
    private condition(
        expression: ts.Expression,
        scope: ReadonlyMap<string, ShaderTextBinding>,
        modulePath: string,
    ): boolean {
        const node = this.context.unwrapExpression(expression);
        if (ts.isPrefixUnaryExpression(node)) {
            if (node.operator !== ts.SyntaxKind.ExclamationToken) {
                this.context.contractError(
                    node,
                    "Pinned shader text branches on an operator this evaluator cannot fold.",
                );
            }
            return !this.condition(node.operand, scope, modulePath);
        }
        if (ts.isBinaryExpression(node)) {
            const kind = node.operatorToken.kind;
            if (
                kind === ts.SyntaxKind.AmpersandAmpersandToken ||
                kind === ts.SyntaxKind.BarBarToken
            ) {
                const left = this.condition(
                    node.left,
                    scope,
                    modulePath,
                );
                const right = this.condition(
                    node.right,
                    scope,
                    modulePath,
                );
                return kind === ts.SyntaxKind.AmpersandAmpersandToken
                    ? left && right
                    : left || right;
            }
            const relation = RELATIONS.get(kind);
            if (relation) {
                return relation(
                    this.number(node.left, scope, modulePath),
                    this.number(node.right, scope, modulePath),
                );
            }
            const equal =
                this.evaluateValue(node.left, scope, modulePath) ===
                this.evaluateValue(node.right, scope, modulePath);
            if (
                kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
                kind === ts.SyntaxKind.EqualsEqualsToken
            ) {
                return equal;
            }
            if (
                kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
                kind === ts.SyntaxKind.ExclamationEqualsToken
            ) {
                return !equal;
            }
            this.context.contractError(
                node,
                "Pinned shader text branches on an operator this evaluator cannot fold.",
            );
        }
        const value = this.evaluateValue(node, scope, modulePath);
        if (typeof value !== "boolean") {
            this.context.contractError(
                node,
                "Pinned shader text branches on a value that is not a permutation flag.",
            );
        }
        return value;
    }

    /** A number the pinned text computes, which an index or a binding is. */
    private number(
        expression: ts.Expression,
        scope: ReadonlyMap<string, ShaderTextBinding>,
        modulePath: string,
    ): number {
        const value = this.evaluateValue(
            expression,
            scope,
            modulePath,
        );
        if (typeof value !== "number") {
            this.context.contractError(
                expression,
                "Pinned shader text computes with a value that is not a number.",
            );
        }
        return value;
    }

    /**
     * The text one pinned expression produces for a bound permutation.
     *
     * `evaluate` runs a whole builder; this runs a fragment of one, which is
     * what a caller needs when only part of a pinned prelude belongs to it —
     * the `defines` loop's own line, say, from a builder whose remaining
     * output this port re-addresses.
     */
    public text(
        modulePath: string,
        expression: ts.Expression,
        parameters: ReadonlyMap<string, ShaderTextBinding>,
    ): string {
        return this.evaluateString(expression, parameters, modulePath);
    }

    /** A string, boolean, number, or bound list the pinned text reads. */
    private evaluateValue(
        expression: ts.Expression,
        scope: ReadonlyMap<string, ShaderTextBinding>,
        modulePath: string,
    ): ShaderTextBinding {
        const node = this.context.unwrapExpression(expression);
        if (ts.isNumericLiteral(node)) {
            return Number(node.text);
        }
        if (ts.isTypeOfExpression(node)) {
            return typeof this.evaluateValue(
                node.expression,
                scope,
                modulePath,
            );
        }
        if (ts.isCallExpression(node)) {
            const host = this.hostCall(node, scope, modulePath);
            if (host !== undefined) {
                return host;
            }
        }
        if (
            ts.isBinaryExpression(node) &&
            ARITHMETIC.has(node.operatorToken.kind)
        ) {
            return ARITHMETIC.get(node.operatorToken.kind)!(
                this.number(node.left, scope, modulePath),
                this.number(node.right, scope, modulePath),
            );
        }
        // `extras.length` and `extras[i].name`: the shapes a builder reads a
        // bound list through, for the binding index and the identifier it
        // splices in.
        if (ts.isPropertyAccessExpression(node)) {
            const target = this.evaluateValue(
                node.expression,
                scope,
                modulePath,
            );
            if (
                Array.isArray(target) &&
                node.name.text === "length"
            ) {
                return target.length;
            }
            const field = isRecord(target)
                ? target[node.name.text]
                : undefined;
            if (field !== undefined) {
                return field;
            }
            return this.context.contractError(
                node,
                `Pinned shader text reads '${node.name.text}', which the permutation's value does not carry.`,
            );
        }
        if (ts.isElementAccessExpression(node)) {
            const target = this.evaluateValue(
                node.expression,
                scope,
                modulePath,
            );
            const index = this.number(
                node.argumentExpression,
                scope,
                modulePath,
            );
            if (!Array.isArray(target) || !target[index]) {
                this.context.contractError(
                    node,
                    "Pinned shader text indexes a value the permutation does not bind as a list.",
                );
            }
            return target[index] as ShaderTextRecord;
        }
        if (node.kind === ts.SyntaxKind.TrueKeyword) {
            return true;
        }
        if (node.kind === ts.SyntaxKind.FalseKeyword) {
            return false;
        }
        if (ts.isIdentifier(node)) {
            const bound = scope.get(node.text);
            if (bound !== undefined) {
                return bound;
            }
            const constant = this.constants.get(node.text);
            if (constant !== undefined) {
                return constant;
            }
            return this.context.contractError(
                node,
                `Pinned shader text reads '${node.text}', which the permutation does not bind.`,
            );
        }
        return this.evaluateString(node, scope, modulePath);
    }

    /**
     * A call to one of the host functions above, or undefined when the
     * callee is a builder this evaluator should walk instead. A host name
     * carrying anything other than one argument refuses, because the table
     * above only checked the one-argument form.
     */
    private hostCall(
        node: ts.CallExpression,
        scope: ReadonlyMap<string, ShaderTextBinding>,
        modulePath: string,
    ): ShaderTextBinding | undefined {
        const path = this.context.propertyPath(node.expression);
        const host = path && HOST_CALLS.get(path.join("."));
        if (!host) {
            return undefined;
        }
        if (node.arguments.length !== 1) {
            this.context.contractError(
                node,
                `Pinned shader text calls '${path!.join(".")}' with ${node.arguments.length} arguments; this evaluator folds the one-argument form.`,
            );
        }
        return host(
            this.evaluateValue(node.arguments[0]!, scope, modulePath),
        );
    }

    private evaluateString(
        expression: ts.Expression,
        scope: ReadonlyMap<string, ShaderTextBinding>,
        modulePath: string,
    ): string {
        const node = this.context.unwrapExpression(expression);
        if (
            ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node)
        ) {
            return node.text;
        }
        if (ts.isTemplateExpression(node)) {
            let text = node.head.text;
            for (const span of node.templateSpans) {
                const value = this.evaluateValue(
                    span.expression,
                    scope,
                    modulePath,
                );
                if (Array.isArray(value)) {
                    this.context.contractError(
                        span.expression,
                        "Pinned shader text interpolates a list, which has no text form.",
                    );
                }
                text += typeof value === "string" ? value : String(value);
                text += span.literal.text;
            }
            return text;
        }
        if (ts.isIdentifier(node)) {
            const value = this.evaluateValue(node, scope, modulePath);
            if (typeof value !== "string") {
                this.context.contractError(
                    node,
                    `Pinned shader text reads '${node.text}', which is not a resolved string.`,
                );
            }
            return value;
        }
        if (ts.isConditionalExpression(node)) {
            return this.evaluateString(
                this.condition(node.condition, scope, modulePath)
                    ? node.whenTrue
                    : node.whenFalse,
                scope,
                modulePath,
            );
        }
        if (ts.isCallExpression(node)) {
            const host = this.hostCall(node, scope, modulePath);
            if (host !== undefined) {
                if (typeof host !== "string") {
                    this.context.contractError(
                        node,
                        "Pinned shader text splices a host call that is not text.",
                    );
                }
                return host;
            }
        }
        // A builder called by name, whose parameters bind positionally from
        // the arguments evaluated here. It is looked for in this module and
        // then in the one this module imports it from, so a composer the pin
        // splits across modules -- its prologue in the pipeline module, its
        // binding lines in the shared custom-shader core -- is read where the
        // pin declares it, without a table naming either.
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression)
        ) {
            const callee = node.expression.text;
            const home =
                this.context.moduleOfImport(modulePath, callee) ??
                modulePath;
            const { declaration } =
                this.context.functionDeclaration(home, callee);
            const bound = new Map<string, ShaderTextBinding>();
            declaration.parameters.forEach((parameter, index) => {
                const argument = node.arguments[index];
                if (!ts.isIdentifier(parameter.name) || !argument) {
                    return;
                }
                bound.set(
                    parameter.name.text,
                    this.evaluateValue(argument, scope, modulePath),
                );
            });
            return this.evaluate(home, callee, bound);
        }
        return this.context.contractError(
            node,
            `Unsupported expression in pinned shader text: ${ts.SyntaxKind[node.kind]}.`,
        );
    }

    /**
     * The body of a braced block, from an opening marker to the brace that
     * closes it. Counting braces rather than cutting at the first `}` is
     * what keeps a stage whose body opens a block of its own — a cutout
     * fragment's `discard` guard, say — from being silently truncated.
     */
    public braced(
        source: string,
        open: string,
        label: string,
    ): string {
        const start = source.indexOf(open);
        if (start < 0) {
            throw new Error(
                `Pinned ${label} is no longer introduced by '${open}'.`,
            );
        }
        let depth = 1;
        for (
            let index = start + open.length;
            index < source.length;
            index += 1
        ) {
            const character = source[index];
            if (character === "{") depth += 1;
            if (character === "}") depth -= 1;
            if (depth === 0) {
                return source
                    .slice(start + open.length, index)
                    .trim();
            }
        }
        throw new Error(`Pinned ${label} has no closing brace.`);
    }

}

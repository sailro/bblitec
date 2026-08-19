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
 * and calls to sibling builders whose parameters bind positionally. Anything
 * else is a contract error, which is the point: the evaluator is a proof
 * that the pinned text still has the shape we think it has.
 *
 * Callers bind the permutation: a flag the scene settles at compile time
 * (`hasDepth`, `orientation`) enters as a value here, and a name the
 * evaluator cannot resolve — an imported constant, say — is supplied
 * through `constants` so the module it lives in stays the module that owns
 * it.
 */
export type ShaderTextBinding = string | boolean;

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

    /** A string or boolean the pinned text reads. */
    private evaluateValue(
        expression: ts.Expression,
        scope: ReadonlyMap<string, ShaderTextBinding>,
        modulePath: string,
    ): ShaderTextBinding {
        const node = this.context.unwrapExpression(expression);
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
        // A sibling builder in the same module, whose parameters bind
        // positionally from the arguments evaluated here. Resolving it by
        // name rather than by a table keeps a builder the pin splits out
        // working without a compiler change.
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression)
        ) {
            const callee = node.expression.text;
            const { declaration } =
                this.context.functionDeclaration(modulePath, callee);
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
            return this.evaluate(modulePath, callee, bound);
        }
        return this.context.contractError(
            node,
            `Unsupported expression in pinned shader text: ${ts.SyntaxKind[node.kind]}.`,
        );
    }

    /**
     * The text between two markers in a reconstructed shader — how a caller
     * takes one struct or one stage body out of a whole module's text.
     */
    public between(
        source: string,
        open: string,
        close: string,
        label: string,
    ): string {
        const start = source.indexOf(open);
        const end = source.indexOf(close, start + open.length);
        if (start < 0 || end < 0) {
            throw new Error(
                `Pinned ${label} is no longer shaped as '${open} ... ${close}'.`,
            );
        }
        return source.slice(start + open.length, end).trim();
    }
}

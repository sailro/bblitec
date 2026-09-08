/**
 * Pure syntax questions every lowering asks of a TypeScript node.
 *
 * Nothing here consults the checker or the compiler's own state: each
 * helper reads the node it is handed and answers from its shape alone, so a
 * mutation walk, an intrinsic and the static evaluator all strip the same
 * wrappers and find the same chain root. A helper that needs symbols or
 * values belongs beside its consumer, not here.
 */
import ts from "typescript";

export interface UnwrapOptions {
    /**
     * Strip `await` as well. Only a reader that already knows the awaited
     * value lands where the expression sits asks for this — the static
     * evaluator, which records each stripped `await` through `onAwait` so
     * the frame boundary it names is not lost.
     */
    readonly await?: boolean;
    readonly onAwait?: (expression: ts.AwaitExpression) => void;
}

/**
 * Whether a node is one of the wrappers that cannot change the value or
 * operation under it: grouping parentheses, `as`, angle-bracket assertions,
 * `!` and `satisfies` — plus `await` when the caller asks.
 */
export function isExpressionWrapper(
    node: ts.Node,
    options: UnwrapOptions = {},
): node is
    | ts.ParenthesizedExpression
    | ts.AsExpression
    | ts.TypeAssertion
    | ts.NonNullExpression
    | ts.SatisfiesExpression
    | ts.AwaitExpression {
    return (
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node) ||
        ts.isNonNullExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        (options.await === true && ts.isAwaitExpression(node))
    );
}

/** Strip the type-only and grouping wrappers around an expression. */
export function unwrapExpression(
    expression: ts.Expression,
    options: UnwrapOptions = {},
): ts.Expression {
    let current = expression;
    while (isExpressionWrapper(current, options)) {
        if (ts.isAwaitExpression(current)) options.onAwait?.(current);
        current = current.expression;
    }
    return current;
}

/**
 * Whether the wrapper chain around an expression carries a `!`. A reader
 * that erases the wrappers still has to know the scene asserted presence,
 * because the optional value under them is then read without a guard.
 */
export function hasNonNullAssertion(expression: ts.Expression): boolean {
    let current = expression;
    while (isExpressionWrapper(current, { await: true })) {
        if (ts.isNonNullExpression(current)) return true;
        current = current.expression;
    }
    return false;
}

/**
 * The expression a property/element-access chain is rooted at.
 *
 * The unwrap has to run BETWEEN chain steps, not only once: `(a as X).b[i]`
 * roots at `a`. Every mutation walk in this compiler depends on that, so
 * the loop lives here once; a caller whose unwrap records what it strips
 * (the static evaluator's, which notes each `await`) passes its own.
 */
export function rootExpression(
    expression: ts.Expression,
    unwrap: (expression: ts.Expression) => ts.Expression = unwrapExpression,
): ts.Expression {
    let current = unwrap(expression);
    while (
        ts.isPropertyAccessExpression(current) ||
        ts.isElementAccessExpression(current)
    ) {
        current = unwrap(current.expression);
    }
    return current;
}

/** The identifier a property/element-access chain is rooted at, if any. */
export function rootIdentifier(
    expression: ts.Expression,
    unwrap: (expression: ts.Expression) => ts.Expression = unwrapExpression,
): ts.Identifier | undefined {
    const root = rootExpression(expression, unwrap);
    return ts.isIdentifier(root) ? root : undefined;
}

/**
 * The argument at an index a caller has already counted, through
 * `expectArgumentCount` or a length test of its own. A missing one is
 * therefore an internal error rather than a scene refusal: the count was
 * checked before the read, so the read cannot be the place to refuse.
 */
export function argumentAt(
    call: ts.CallExpression | ts.NewExpression,
    index: number,
): ts.Expression {
    const argument = call.arguments?.[index];
    if (argument === undefined) {
        throw new Error(
            `Internal error: argument ${index} was read from a call with ` +
                `${call.arguments?.length ?? 0} argument(s) without being counted.`,
        );
    }
    return argument;
}

/** The name an identifier spells, or undefined for any other expression. */
export function identifierText(expression: ts.Expression): string | undefined {
    return ts.isIdentifier(expression) ? expression.text : undefined;
}

/** The text a string literal spells, or undefined for any other expression. */
export function stringLiteralText(
    expression: ts.Expression,
): string | undefined {
    return ts.isStringLiteralLike(expression) ? expression.text : undefined;
}

/** Whether a binary operator token is `=` or one of its compound forms. */
export function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
    return (
        kind >= ts.SyntaxKind.FirstAssignment &&
        kind <= ts.SyntaxKind.LastAssignment
    );
}

/**
 * A binary expression whose operator assigns. The predicate names the
 * operator precisely so that a binary expression already in hand is not
 * narrowed away when the test fails.
 */
export function isAssignmentExpression(
    node: ts.Node,
): node is ts.AssignmentExpression<ts.AssignmentOperatorToken> {
    return (
        ts.isBinaryExpression(node) &&
        isAssignmentOperator(node.operatorToken.kind)
    );
}

/** A prefix or postfix `++`/`--`. */
export type UpdateExpression = (
    | ts.PrefixUnaryExpression
    | ts.PostfixUnaryExpression
) & {
    readonly operator:
        | ts.SyntaxKind.PlusPlusToken
        | ts.SyntaxKind.MinusMinusToken;
};

export function isUpdateExpression(node: ts.Node): node is UpdateExpression {
    return (
        (ts.isPrefixUnaryExpression(node) ||
            ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
            node.operator === ts.SyntaxKind.MinusMinusToken)
    );
}

/**
 * The text a literal property name spells, or undefined for a computed
 * one — a computed key has no generation-time name to look up.
 */
export function propertyNameText(name: ts.PropertyName): string | undefined {
    return ts.isIdentifier(name) ||
        ts.isStringLiteral(name) ||
        ts.isNumericLiteral(name)
        ? name.text
        : undefined;
}

/**
 * The initializer an object literal gives a named property, or the
 * shorthand identifier that stands for one. A spread, a method or an
 * accessor carries no initializer to read and is skipped.
 *
 * `propertyName` says what a key spells: the literal text by default, and
 * the compiler's own resolver where a computed key folded at generation
 * (`{ [key]: value }` with a static `key`) must be found too.
 */
export function objectProperty(
    object: ts.ObjectLiteralExpression,
    name: string,
    propertyName: (name: ts.PropertyName) => string | undefined = propertyNameText,
): ts.Expression | undefined {
    for (const property of object.properties) {
        if (
            ts.isPropertyAssignment(property) &&
            propertyName(property.name) === name
        ) {
            return property.initializer;
        }
        if (
            ts.isShorthandPropertyAssignment(property) &&
            property.name.text === name
        ) {
            return property.name;
        }
    }
    return undefined;
}

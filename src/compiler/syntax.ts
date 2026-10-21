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

/** Literal delimiters are syntax; the native regex consumes only its pattern and flags. */
export function regularExpressionParts(
    expression: ts.RegularExpressionLiteral,
): { pattern: string; flags: string } | undefined {
    const delimiter = expression.text.lastIndexOf("/");
    if (delimiter <= 0) return undefined;
    return {
        pattern: expression.text.slice(1, delimiter).replaceAll("\\/", "/"),
        flags: expression.text.slice(delimiter + 1),
    };
}
import { someAnalysisNode } from "./analysis-walk.js";
import type { LibraryGlobal } from "./symbols.js";

/** Calls, accessors and writes can change an earlier selected receiver/value. */
export function expressionMayRunCode(expression: ts.Expression): boolean {
    return someAnalysisNode(
        expression,
        (node) =>
            ts.isCallExpression(node) ||
            ts.isNewExpression(node) ||
            ts.isAwaitExpression(node) ||
            ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node) ||
            isUpdateExpression(node) ||
            isAssignmentExpression(node),
        { functions: "skip", types: "skip" },
    );
}

/**
 * Whether evaluating `expression` twice could repeat an effect: it calls,
 * constructs, awaits, updates or assigns. Property reads count as none.
 */
export function expressionHasEffects(expression: ts.Expression): boolean {
    return someAnalysisNode(
        expression,
        (node) =>
            ts.isCallExpression(node) ||
            ts.isNewExpression(node) ||
            ts.isAwaitExpression(node) ||
            isUpdateExpression(node) ||
            isAssignmentExpression(node),
    );
}

interface UnwrapOptions {
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

/**
 * Whether a wrapper keeps both the value and the static type under it:
 * parentheses and `satisfies`. An assertion or `!` changes the type.
 */
export function isTypePreservingWrapper(
    node: ts.Node,
): node is ts.ParenthesizedExpression | ts.SatisfiesExpression {
    return ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node);
}

/** Strip the wrappers that keep the value and its static type. */
export function unwrapTypePreserving(expression: ts.Expression): ts.Expression {
    let current = expression;
    while (isTypePreservingWrapper(current)) current = current.expression;
    return current;
}

/** Whether a wrapper exists only in TypeScript: `as`, `<T>`, `!`, `satisfies`. */
export function isTypeOnlyWrapper(
    node: ts.Node,
): node is
    | ts.AsExpression
    | ts.TypeAssertion
    | ts.NonNullExpression
    | ts.SatisfiesExpression {
    return isExpressionWrapper(node) && !ts.isParenthesizedExpression(node);
}

/**
 * Whether a wrapper asserts a type (`x as T`, `<T>x`): the checker types it
 * as the asserted type. `satisfies` only checks; its value keeps its own type.
 */
export function isTypeAssertion(
    node: ts.Node,
): node is ts.AsExpression | ts.TypeAssertion {
    return ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
}

/** The wrappers under an expression, outermost first, down to the value they wrap. */
export function wrappersUnder(
    expression: ts.Expression,
    options: UnwrapOptions = {},
): readonly ts.Expression[] {
    const wrappers: ts.Expression[] = [];
    for (
        let current = expression;
        isExpressionWrapper(current, options);
        current = current.expression
    )
        wrappers.push(current);
    return wrappers;
}

/** The wrappers around a node, innermost first, up to its consumer. */
export function wrappersAround(
    node: ts.Node,
    options: UnwrapOptions = {},
): readonly ts.Expression[] {
    const wrappers: ts.Expression[] = [];
    for (
        let parent = node.parent;
        parent !== undefined && isExpressionWrapper(parent, options);
        parent = parent.parent
    )
        wrappers.push(parent);
    return wrappers;
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

interface ClimbOptions {
    /**
     * Also climb out of an operand whose value its parent yields
     * ({@link operandYield}); `"objects"` only where an object passes, not
     * out of `&&`'s left operand.
     */
    readonly branches?: boolean | "objects";
    /** Also climb out of an `await`, for a reader of the settled value. */
    readonly await?: boolean;
}

/**
 * The classes of value an operand can pass on to its parent: truthy, falsy
 * but present (`0`, `""`, `false`, `NaN`, `0n`), or nullish. An object is
 * always truthy.
 */
export type ValueClass = "truthy" | "falsy" | "nullish";

/** The class of a string value: the empty string is falsy. */
export function valueClassOfString(text: string): ValueClass {
    return text === "" ? "falsy" : "truthy";
}

const anyValue: ReadonlySet<ValueClass> = new Set([
    "truthy",
    "falsy",
    "nullish",
]);
const presentValue: ReadonlySet<ValueClass> = new Set(["truthy", "falsy"]);
const truthyValue: ReadonlySet<ValueClass> = new Set(["truthy"]);
const falsyValue: ReadonlySet<ValueClass> = new Set(["falsy", "nullish"]);

/**
 * The values of `operand` that `parent` yields as its own: all of them for
 * a conditional's branches and the right operand of `??`, `||`, `&&` and
 * `,`; the present ones for `??`'s left, the truthy ones for `||`'s and the
 * falsy ones for `&&`'s. Undefined when `parent` does not yield `operand`.
 */
export function operandYield(
    parent: ts.Node,
    operand: ts.Node,
): ReadonlySet<ValueClass> | undefined {
    if (ts.isConditionalExpression(parent))
        return parent.condition === operand ? undefined : anyValue;
    if (!ts.isBinaryExpression(parent)) return undefined;
    const left = parent.left === operand;
    switch (parent.operatorToken.kind) {
        case ts.SyntaxKind.QuestionQuestionToken:
            return left ? presentValue : anyValue;
        case ts.SyntaxKind.BarBarToken:
            return left ? truthyValue : anyValue;
        case ts.SyntaxKind.AmpersandAmpersandToken:
            return left ? falsyValue : anyValue;
        case ts.SyntaxKind.CommaToken:
            return left ? undefined : anyValue;
        default:
            return undefined;
    }
}

/** Whether a node yields one of its operands ({@link operandYield}) rather than a value of its own. */
export function isOperandSelection(node: ts.Node): boolean {
    return (
        ts.isConditionalExpression(node) ||
        (ts.isBinaryExpression(node) &&
            operandYield(node, node.right) !== undefined)
    );
}

/** Whether `parent` chooses at run time which operand it yields (all but `,`). */
export function choosesOperand(parent: ts.Node): boolean {
    return (
        isOperandSelection(parent) &&
        !(
            ts.isBinaryExpression(parent) &&
            parent.operatorToken.kind === ts.SyntaxKind.CommaToken
        )
    );
}

/**
 * Whether a node evaluates some of its operands only on some runs: a choice
 * ({@link choosesOperand}), a logical assignment, or an optional chain.
 */
export function guardsOperands(node: ts.Node): boolean {
    return (
        choosesOperand(node) ||
        (ts.isBinaryExpression(node) &&
            isLogicalAssignmentOperator(node.operatorToken.kind)) ||
        ts.isOptionalChain(node)
    );
}

export interface YieldedOperand {
    readonly operand: ts.Expression;
    /** The classes of the operand's values the expression yields; never empty. */
    readonly classes: ReadonlySet<ValueClass>;
}

/**
 * The operands, past wrappers and nested selections, one of whose values
 * an expression evaluates to, each with the classes of value it yields.
 */
export function yieldedOperands(
    expression: ts.Expression,
    unwrap: (node: ts.Expression) => ts.Expression = unwrapExpression,
): readonly YieldedOperand[] {
    const node = unwrap(expression);
    const operands = ts.isConditionalExpression(node)
        ? [node.whenTrue, node.whenFalse]
        : ts.isBinaryExpression(node) && isOperandSelection(node)
          ? [node.left, node.right]
          : undefined;
    if (!operands) return [{ operand: node, classes: anyValue }];
    return operands.flatMap((operand) => {
        const passed = operandYield(node, operand);
        if (!passed) return [];
        return yieldedOperands(operand, unwrap).flatMap((inner) => {
            const classes = new Set(
                [...inner.classes].filter((kind) => passed.has(kind)),
            );
            return classes.size > 0
                ? [{ operand: inner.operand, classes }]
                : [];
        });
    });
}

/** The operands whose objects (truthy values) an expression can yield. */
export function valueOperands(
    expression: ts.Expression,
    unwrap: (node: ts.Expression) => ts.Expression = unwrapExpression,
): readonly ts.Expression[] {
    return yieldedOperands(expression, unwrap).flatMap((entry) =>
        entry.classes.has("truthy") ? [entry.operand] : [],
    );
}

/**
 * The outermost node around `node` that yields its value: past the wrappers
 * around it and, with `branches`, the parents {@link operandYield} names.
 */
export function outermostWrapper(
    node: ts.Expression,
    options?: ClimbOptions,
): ts.Expression;
export function outermostWrapper(
    node: ts.Node,
    options?: ClimbOptions,
): ts.Node;
export function outermostWrapper(
    node: ts.Node,
    options: ClimbOptions = {},
): ts.Node {
    let current = node;
    for (
        let parent = current.parent;
        // A source file has no parent.
        parent !== undefined &&
        (isExpressionWrapper(parent, options) ||
            climbsOperand(parent, current, options.branches));
        parent = current.parent
    )
        current = parent;
    return current;
}

function climbsOperand(
    parent: ts.Node,
    operand: ts.Node,
    branches: ClimbOptions["branches"],
): boolean {
    const yielded = branches ? operandYield(parent, operand) : undefined;
    return (
        yielded !== undefined &&
        (branches !== "objects" || yielded.has("truthy"))
    );
}

/** The node that consumes an expression, past the wrappers around it. */
export function wrappedParent(expression: ts.Expression): ts.Node {
    return outermostWrapper(expression).parent;
}

/**
 * Whether the wrapper chain around an expression carries a `!`. A reader
 * that erases the wrappers still has to know the scene asserted presence,
 * because the optional value under them is then read without a guard.
 */
export function hasNonNullAssertion(expression: ts.Expression): boolean {
    return wrappersUnder(expression, { await: true }).some(
        ts.isNonNullExpression,
    );
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

/** The identifier an expression is once its wrappers are stripped, or undefined. */
export function unwrappedIdentifier(
    expression: ts.Expression,
    unwrap: (expression: ts.Expression) => ts.Expression = unwrapExpression,
): ts.Identifier | undefined {
    const unwrapped = unwrap(expression);
    return ts.isIdentifier(unwrapped) ? unwrapped : undefined;
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
 * `??=`, `||=` and `&&=`: the assignments that store only when the
 * target's own value selects the right side. They sit inside the
 * assignment token range, so `isAssignmentOperator` already answers true
 * for them; this names the three that a plain store cannot lower.
 */
export function isLogicalAssignmentOperator(kind: ts.SyntaxKind): boolean {
    return (
        kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
        kind === ts.SyntaxKind.BarBarEqualsToken ||
        kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
    );
}

/**
 * The expression a call writes through: the receiver of a method
 * `mutatesVia` admits, or the first argument of `Object.assign`, which
 * writes into it. Every mutation walk recognizes a writing call here, so
 * a family added once reaches them all.
 */
export function mutatingCallTarget(
    node: ts.Node,
    mutatesVia: (method: string) => boolean,
): ts.Expression | undefined {
    if (
        !ts.isCallExpression(node) ||
        !ts.isPropertyAccessExpression(node.expression)
    ) {
        return undefined;
    }
    const callee = node.expression;
    if (
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "Object" &&
        callee.name.text === "assign"
    ) {
        return node.arguments[0];
    }
    return mutatesVia(callee.name.text) ? callee.expression : undefined;
}

/**
 * `receiver.entries()`, `.keys()` or `.values()` on a stored container:
 * the zero-argument call, its method and its receiver. A library static
 * (`Object.entries(x)`) and a receiver containing a call are not one:
 * both are values the plain loop resolves, and probing them would inline
 * work the probe then discards.
 */
export function iteratorMethodCall(
    expression: ts.Expression,
    libraryGlobal: LibraryGlobal,
    unwrap: (expression: ts.Expression) => ts.Expression = unwrapExpression,
):
    | {
          call: ts.CallExpression;
          method: "entries" | "keys" | "values";
          receiver: ts.Expression;
      }
    | undefined {
    const call = unwrap(expression);
    if (
        !ts.isCallExpression(call) ||
        call.arguments.length !== 0 ||
        !ts.isPropertyAccessExpression(call.expression)
    ) {
        return undefined;
    }
    const method = call.expression.name.text;
    if (method !== "entries" && method !== "keys" && method !== "values") {
        return undefined;
    }
    const receiver = call.expression.expression;
    if (
        (ts.isIdentifier(receiver) && libraryGlobal(receiver) !== undefined) ||
        someAnalysisNode(
            receiver,
            (node) => ts.isCallExpression(node) || ts.isNewExpression(node),
        )
    ) {
        return undefined;
    }
    return { call, method, receiver };
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

/** How many arguments a call must pass: parameters without a default, `?` or rest. */
export function requiredParameterCount(
    parameters: readonly ts.ParameterDeclaration[],
): number {
    return parameters.filter(
        (parameter) =>
            !parameter.initializer &&
            !parameter.questionToken &&
            !parameter.dotDotDotToken,
    ).length;
}

/** The index of a declaration's rest parameter, when it declares one. */
export function restParameterIndex(
    declaration: Pick<ts.SignatureDeclarationBase, "parameters">,
): number | undefined {
    const index = declaration.parameters.findIndex(
        (parameter) => parameter.dotDotDotToken !== undefined,
    );
    return index >= 0 ? index : undefined;
}

/** Writable leaves of a destructuring pattern; keys and defaults are reads. */
export function assignmentTargets(
    expression: ts.Expression,
): readonly ts.Expression[] {
    const target = unwrapExpression(expression);
    if (ts.isOmittedExpression(target)) return [];
    if (ts.isSpreadElement(target)) return assignmentTargets(target.expression);
    if (ts.isArrayLiteralExpression(target))
        return target.elements.flatMap(assignmentTargets);
    if (ts.isObjectLiteralExpression(target))
        return target.properties.flatMap((property) =>
            ts.isPropertyAssignment(property)
                ? assignmentTargets(property.initializer)
                : ts.isShorthandPropertyAssignment(property)
                  ? [property.name]
                  : ts.isSpreadAssignment(property)
                    ? assignmentTargets(property.expression)
                    : [],
        );
    if (
        ts.isBinaryExpression(target) &&
        target.operatorToken.kind === ts.SyntaxKind.EqualsToken
    )
        return assignmentTargets(target.left);
    return [target];
}

/**
 * How a write site writes its target: `=` (each leaf of a destructuring
 * pattern included), a compound assignment that reads first (`+=`), a
 * logical one that stores only on some runs (`??=`, `||=`, `&&=`), `++`/`--`,
 * `delete`, or the target a for-of or for-in loop assigns each pass.
 */
export type WriteKind =
    "assign" | "compound" | "logical" | "update" | "delete" | "loop";

export interface WriteSite {
    /** The written place past its wrappers: an identifier or an access. */
    readonly target: ts.Expression;
    readonly kind: WriteKind;
    /** The expression or loop that writes. */
    readonly node: ts.Node;
    /**
     * The whole value the target receives, for `=` and logical assignments
     * to a single target. A pattern leaf receives a part of the value, and
     * the other kinds compute what they store.
     */
    readonly stored?: ts.Expression;
    /**
     * Where the stored value comes from, whole or in part: the right side of
     * `=` (a pattern leaf takes part of it) or of a logical assignment, or
     * the collection a loop target takes each element of.
     */
    readonly from?: ts.Expression;
}

/**
 * Whether a node sits inside a destructuring pattern: an array or object
 * literal that is, through the patterns around it, the left side of `=` or
 * the target of a for-of or for-in loop.
 */
function inDestructuringPattern(node: ts.Node): boolean {
    let current = node;
    for (;;) {
        const parent = current.parent;
        const container =
            isExpressionWrapper(parent) ||
            ts.isArrayLiteralExpression(parent) ||
            ts.isObjectLiteralExpression(parent) ||
            ts.isSpreadElement(parent) ||
            ts.isSpreadAssignment(parent) ||
            ts.isPropertyAssignment(parent) ||
            ts.isShorthandPropertyAssignment(parent) ||
            // A default inside an enclosing pattern: `[[x] = []] = values`.
            (ts.isBinaryExpression(parent) &&
                parent.left === current &&
                parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                (ts.isArrayLiteralExpression(parent.parent) ||
                    ts.isPropertyAssignment(parent.parent)));
        if (!container) break;
        current = parent;
    }
    const consumer = current.parent;
    return (
        current !== node &&
        (ts.isArrayLiteralExpression(current) ||
            ts.isObjectLiteralExpression(current)) &&
        ((ts.isBinaryExpression(consumer) &&
            consumer.left === current &&
            consumer.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
            ((ts.isForOfStatement(consumer) || ts.isForInStatement(consumer)) &&
                consumer.initializer === current))
    );
}

/** The places `node` itself writes; writes nested in its operands are their own sites. */
export function writeSites(node: ts.Node): readonly WriteSite[] {
    // `[a = 1] = values`: a pattern's default is read, not assigned.
    if (isAssignmentExpression(node) && inDestructuringPattern(node)) return [];
    if (isAssignmentExpression(node)) {
        const operator = node.operatorToken.kind;
        const left = unwrapExpression(node.left);
        const from = node.right;
        if (operator === ts.SyntaxKind.EqualsToken)
            return ts.isObjectLiteralExpression(left) ||
                ts.isArrayLiteralExpression(left)
                ? assignmentTargets(left).map((target) => ({
                      target,
                      kind: "assign",
                      node,
                      from,
                  }))
                : [{ target: left, kind: "assign", node, stored: from, from }];
        return isLogicalAssignmentOperator(operator)
            ? [{ target: left, kind: "logical", node, stored: from, from }]
            : [{ target: left, kind: "compound", node }];
    }
    if (isUpdateExpression(node))
        return [
            { target: unwrapExpression(node.operand), kind: "update", node },
        ];
    if (ts.isDeleteExpression(node))
        return [
            { target: unwrapExpression(node.expression), kind: "delete", node },
        ];
    if (
        (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
        !ts.isVariableDeclarationList(node.initializer)
    )
        return assignmentTargets(node.initializer).map((target) => ({
            target,
            kind: "loop",
            node,
            from: node.expression,
        }));
    return [];
}

/**
 * The write site that writes `expression` itself, past the wrappers and
 * destructuring patterns around it, or undefined when it is only read.
 */
export function writeSiteOf(expression: ts.Expression): WriteSite | undefined {
    const target = unwrapExpression(expression);
    let current: ts.Node = expression;
    for (;;) {
        const parent: ts.Node = current.parent;
        const pattern =
            isExpressionWrapper(parent) ||
            ts.isArrayLiteralExpression(parent) ||
            ts.isObjectLiteralExpression(parent) ||
            ts.isSpreadElement(parent) ||
            ts.isSpreadAssignment(parent) ||
            ts.isShorthandPropertyAssignment(parent) ||
            (ts.isPropertyAssignment(parent) &&
                parent.initializer === current) ||
            // `[a = 1] = values`: the default's left is the pattern leaf.
            (ts.isBinaryExpression(parent) &&
                parent.left === current &&
                parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                (ts.isArrayLiteralExpression(parent.parent) ||
                    ts.isPropertyAssignment(parent.parent)));
        if (!pattern)
            return writeSites(parent).find((site) => site.target === target);
        current = parent;
    }
}

/**
 * The identifiers whose values a stored expression holds as they are: the
 * expression itself, a member, element or spread of a literal it builds,
 * or an operand it yields ({@link yieldedOperands}). A value computed from
 * an identifier (a call's result) holds none of them.
 */
export function heldIdentifiers(
    expression: ts.Expression,
    unwrap: (node: ts.Expression) => ts.Expression = unwrapExpression,
): readonly ts.Identifier[] {
    return yieldedOperands(expression, unwrap).flatMap(({ operand }) =>
        literalHeldIdentifiers(operand, unwrap),
    );
}

function literalHeldIdentifiers(
    node: ts.Expression,
    unwrap: (node: ts.Expression) => ts.Expression,
): readonly ts.Identifier[] {
    if (ts.isIdentifier(node)) return [node];
    if (ts.isSpreadElement(node))
        return heldIdentifiers(node.expression, unwrap);
    if (ts.isArrayLiteralExpression(node))
        return node.elements.flatMap((element) =>
            heldIdentifiers(element, unwrap),
        );
    if (ts.isObjectLiteralExpression(node))
        return node.properties.flatMap((property) =>
            ts.isPropertyAssignment(property)
                ? heldIdentifiers(property.initializer, unwrap)
                : ts.isShorthandPropertyAssignment(property)
                  ? [property.name]
                  : ts.isSpreadAssignment(property)
                    ? heldIdentifiers(property.expression, unwrap)
                    : [],
        );
    return [];
}

/** A prefix or postfix `++`/`--`. */
type UpdateExpression = (
    ts.PrefixUnaryExpression | ts.PostfixUnaryExpression
) & {
    readonly operator:
        ts.SyntaxKind.PlusPlusToken | ts.SyntaxKind.MinusMinusToken;
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
 * The initializer an object literal (or its properties, spreads already
 * expanded) gives a named property, or the shorthand identifier that stands
 * for one; a later write wins. A spread, a method or an accessor carries no
 * initializer to read and is skipped.
 *
 * `propertyName` says what a key spells: the literal text by default, and
 * the compiler's own resolver where a computed key folded at generation
 * (`{ [key]: value }` with a static `key`) must be found too.
 */
export function objectProperty(
    object: ts.ObjectLiteralExpression | readonly ts.ObjectLiteralElementLike[],
    name: string,
    propertyName: (
        name: ts.PropertyName,
    ) => string | undefined = propertyNameText,
): ts.Expression | undefined {
    let found: ts.Expression | undefined;
    for (const property of "properties" in object
        ? object.properties
        : object) {
        if (
            ts.isPropertyAssignment(property) &&
            propertyName(property.name) === name
        ) {
            found = property.initializer;
        } else if (
            ts.isShorthandPropertyAssignment(property) &&
            property.name.text === name
        ) {
            found = property.name;
        }
    }
    return found;
}

/**
 * The expression a literal's member takes its value from: the last plain
 * or shorthand property of an object literal writing `key`, with no spread
 * or computed key after it that may write it too, or an array literal's
 * element at index `key` when no spread shifts the indices. Undefined where
 * the syntax does not name one.
 */
export function literalMember(
    expression: ts.Expression,
    key: string | number,
): ts.Expression | undefined {
    const literal = unwrapExpression(expression);
    if (typeof key === "number") {
        if (
            !ts.isArrayLiteralExpression(literal) ||
            literal.elements.some(ts.isSpreadElement)
        )
            return undefined;
        const element = literal.elements[key];
        return element && !ts.isOmittedExpression(element)
            ? element
            : undefined;
    }
    if (!ts.isObjectLiteralExpression(literal)) return undefined;
    let found: ts.Expression | undefined;
    for (const property of literal.properties) {
        const name =
            property.name === undefined
                ? undefined
                : propertyNameText(property.name);
        if (ts.isSpreadAssignment(property) || name === undefined)
            found = undefined;
        else if (name === key)
            found = ts.isPropertyAssignment(property)
                ? property.initializer
                : ts.isShorthandPropertyAssignment(property)
                  ? property.name
                  : undefined;
    }
    return found;
}

/**
 * The names a statement declares in its scope: a variable statement's
 * bindings, through object and array patterns, or a named function, class
 * or enum declaration's own name.
 */
export function statementDeclaredNames(
    statement: ts.Statement,
): ts.Identifier[] {
    const names: ts.Identifier[] = [];
    if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
            names.push(...bindingNameIdentifiers(declaration.name));
        }
    } else if (
        (ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement) ||
            ts.isEnumDeclaration(statement)) &&
        statement.name
    ) {
        names.push(statement.name);
    }
    return names;
}

/** The identifiers a binding name binds, through object and array patterns. */
export function bindingNameIdentifiers(name: ts.BindingName): ts.Identifier[] {
    if (ts.isIdentifier(name)) return [name];
    return name.elements.flatMap((element) =>
        ts.isBindingElement(element)
            ? bindingNameIdentifiers(element.name)
            : [],
    );
}

/** Whether a node is written inside another. */
export function isDeclaredInside(
    node: ts.Node,
    target: ts.Node | undefined,
): boolean {
    return (
        target !== undefined &&
        ts.findAncestor(node, (owner) => owner === target) !== undefined
    );
}

/**
 * The name a source function is known by in refusals, the survey census and
 * `--source-profile`: its own name, qualified by its class for a class member
 * (`WorldLight.compute`, `Keys.of`), `constructor` for a constructor, or the
 * variable or property an unnamed function is bound to. Undefined for a
 * function with none.
 */
export function sourceFunctionName(
    declaration: ts.SignatureDeclaration,
): string | undefined {
    const parent = declaration.parent;
    const name = ts.isConstructorDeclaration(declaration)
        ? "constructor"
        : declarationNameText(
              ts.getNameOfDeclaration(declaration) ??
                  (ts.isPropertyDeclaration(parent) ? parent.name : undefined),
          );
    if (name === undefined) return undefined;
    const member = ts.isPropertyDeclaration(parent) ? parent : declaration;
    const owner = ts.isClassLike(member.parent)
        ? member.parent.name?.text
        : undefined;
    return owner === undefined ? name : `${owner}.${name}`;
}

/** The text a declaration's name is written as; a computed name keeps its brackets. */
function declarationNameText(
    name: ts.DeclarationName | undefined,
): string | undefined {
    if (!name) return undefined;
    return ts.isIdentifier(name) ||
        ts.isPrivateIdentifier(name) ||
        ts.isStringLiteralLike(name) ||
        ts.isNumericLiteral(name)
        ? name.text
        : name.getText();
}

/** The expression of a concise body or a block consisting only of a return. */
export function soleReturnedExpression(
    body: ts.ConciseBody,
): ts.Expression | undefined {
    if (!ts.isBlock(body)) return body;
    const [statement] = body.statements;
    return body.statements.length === 1 &&
        statement &&
        ts.isReturnStatement(statement)
        ? statement.expression
        : undefined;
}

/**
 * The synchronous, non-generator source function a declaration names: a
 * function declaration, or a `const` bound to a function literal.
 */
export function localSyncFunction(
    declaration: ts.Declaration | undefined,
):
    | ts.FunctionDeclaration
    | ts.ArrowFunction
    | ts.FunctionExpression
    | undefined {
    if (!declaration || declaration.getSourceFile().isDeclarationFile)
        return undefined;
    const fn =
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0
            ? unwrapExpression(declaration.initializer)
            : declaration;
    return (ts.isFunctionDeclaration(fn) ||
        ts.isArrowFunction(fn) ||
        ts.isFunctionExpression(fn)) &&
        fn.body !== undefined &&
        !fn.asteriskToken &&
        !fn.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
        )
        ? fn
        : undefined;
}

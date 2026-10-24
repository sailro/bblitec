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
import type { LibraryGlobal, MemberReader } from "./symbols.js";

/** What may run code or change state when an expression is evaluated now. */
interface EffectOptions {
    /** A call that runs nothing of the program's (a library formatter). */
    readonly pureCall?: (call: ts.CallExpression) => boolean;
}

/**
 * Whether evaluating `expression` now has an effect a second evaluation
 * would repeat: it calls (a tag included), constructs, suspends or writes
 * (`delete` included). A nested function is a value, not run.
 */
export function expressionHasEffects(
    expression: ts.Expression,
    options: EffectOptions = {},
): boolean {
    return someAnalysisNode(
        expression,
        (node) =>
            (ts.isCallExpression(node) && !options.pureCall?.(node)) ||
            ts.isNewExpression(node) ||
            ts.isTaggedTemplateExpression(node) ||
            isSuspensionPoint(node) ||
            writeSites(node).length > 0,
        { functions: "skip", types: "skip" },
    );
}

/**
 * Whether evaluating `expression` now may run code that changes an earlier
 * selected receiver or value: an effect, or a property read (an accessor).
 */
export function expressionMayRunCode(
    expression: ts.Expression,
    options: EffectOptions = {},
): boolean {
    return (
        expressionHasEffects(expression, options) ||
        someAnalysisNode(
            expression,
            (node) =>
                ts.isPropertyAccessExpression(node) ||
                ts.isElementAccessExpression(node),
            { functions: "skip", types: "skip" },
        )
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

/**
 * An equality operator's shape: `===` and `!==` compare strictly, `==` and
 * `!=` loosely; the `!` forms negate. Undefined for any other operator.
 */
export function equalityOperator(
    kind: ts.SyntaxKind,
): { readonly loose: boolean; readonly negated: boolean } | undefined {
    switch (kind) {
        case ts.SyntaxKind.EqualsEqualsEqualsToken:
            return { loose: false, negated: false };
        case ts.SyntaxKind.ExclamationEqualsEqualsToken:
            return { loose: false, negated: true };
        case ts.SyntaxKind.EqualsEqualsToken:
            return { loose: true, negated: false };
        case ts.SyntaxKind.ExclamationEqualsToken:
            return { loose: true, negated: true };
        default:
            return undefined;
    }
}

/**
 * Whether the node around `use` (its outermost wrapper) reads only its
 * truthiness, so no reference it holds goes further: `!use`, the test of an
 * `if`, `while`, `do`, `for` or `?:`, or the left of `&&` (which yields
 * `use` only when falsy, a primitive).
 */
export function testsTruthinessOnly(use: ts.Expression): boolean {
    const parent = use.parent;
    return (
        (ts.isPrefixUnaryExpression(parent) &&
            parent.operator === ts.SyntaxKind.ExclamationToken) ||
        ((ts.isIfStatement(parent) ||
            ts.isWhileStatement(parent) ||
            ts.isDoStatement(parent)) &&
            parent.expression === use) ||
        (ts.isForStatement(parent) && parent.condition === use) ||
        (ts.isConditionalExpression(parent) && parent.condition === use) ||
        (ts.isBinaryExpression(parent) &&
            parent.operatorToken.kind ===
                ts.SyntaxKind.AmpersandAmpersandToken &&
            parent.left === use)
    );
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
 * `mutatesVia` admits, or the argument a writing library call fills
 * (`writtenArgument`: parameter-effects.ts libraryWrittenArgument, the one
 * table of them; without a checker only a bare `Object.assign` reads as
 * one). Every mutation walk recognizes a writing call here, so a family
 * added once reaches them all.
 */
export function mutatingCallTarget(
    node: ts.Node,
    member: MemberReader,
    mutatesVia: (method: string) => boolean,
    writtenArgument?: (call: ts.CallExpression) => ts.Expression | undefined,
): ts.Expression | undefined {
    if (!ts.isCallExpression(node)) return undefined;
    const callee = member(node.expression);
    if (!callee) return undefined;
    const written = writtenArgument
        ? writtenArgument(node)
        : callee.name === "assign" &&
            ts.isIdentifier(callee.expression) &&
            callee.expression.text === "Object"
          ? node.arguments[0]
          : undefined;
    if (written) return written;
    return mutatesVia(callee.name) ? callee.expression : undefined;
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
    member: MemberReader,
    unwrap: (expression: ts.Expression) => ts.Expression = unwrapExpression,
):
    | {
          call: ts.CallExpression;
          method: "entries" | "keys" | "values";
          receiver: ts.Expression;
      }
    | undefined {
    const call = unwrap(expression);
    if (!ts.isCallExpression(call) || call.arguments.length !== 0)
        return undefined;
    const callee = member(call.expression);
    if (!callee) return undefined;
    const method = callee.name;
    if (method !== "entries" && method !== "keys" && method !== "values") {
        return undefined;
    }
    const receiver = callee.expression;
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
    // Positional: `(a = 1, b)` needs two arguments for `b` to receive one.
    let count = 0;
    parameters.forEach((parameter, index) => {
        if (
            !parameter.initializer &&
            !parameter.questionToken &&
            !parameter.dotDotDotToken
        )
            count = index + 1;
    });
    return count;
}

/** What one parameter of a called declaration receives from a call. */
export type ParameterInput =
    /** The argument at its position. */
    | { readonly kind: "argument"; readonly argument: ts.Expression }
    /** A rest parameter: the arguments from its position on. */
    | { readonly kind: "rest"; readonly arguments: readonly ts.Expression[] }
    /** No argument: its default, or undefined. */
    | { readonly kind: "default"; readonly initializer?: ts.Expression }
    /** A spread at or before its position leaves it to the run time. */
    | { readonly kind: "unknown" };

/**
 * What `declaration`'s parameter `parameterIndex` receives from `call`,
 * with spreads, rest parameters and defaults as JavaScript binds them.
 */
export function argumentForParameter(
    call: ts.CallExpression | ts.NewExpression,
    declaration: Pick<ts.SignatureDeclarationBase, "parameters">,
    parameterIndex: number,
): ParameterInput {
    const parameter = declaration.parameters[parameterIndex];
    const args = call.arguments ?? [];
    if (args.slice(0, parameterIndex).some(ts.isSpreadElement))
        return { kind: "unknown" };
    if (parameter?.dotDotDotToken)
        return { kind: "rest", arguments: args.slice(parameterIndex) };
    const argument = args[parameterIndex];
    if (argument === undefined)
        return parameter?.initializer
            ? { kind: "default", initializer: parameter.initializer }
            : { kind: "default" };
    return ts.isSpreadElement(argument)
        ? { kind: "unknown" }
        : { kind: "argument", argument };
}

/**
 * The one parameter `call`'s argument `argumentIndex` binds: undefined when
 * a spread hides it, a rest parameter collects it, or no parameter takes it.
 */
export function positionalParameter(
    call: ts.CallExpression | ts.NewExpression,
    declaration: Pick<ts.SignatureDeclarationBase, "parameters">,
    argumentIndex: number,
): ts.ParameterDeclaration | undefined {
    const bound = parameterForArgument(call, declaration, argumentIndex);
    return bound !== undefined && bound !== "unknown" && !bound.rest
        ? bound.parameter
        : undefined;
}

/**
 * The parameter of `declaration` that `call`'s argument `argumentIndex`
 * binds: its positional one, the rest parameter it is collected into, or
 * `"unknown"` when a spread at or before it shifts the positions.
 * Undefined for an argument no parameter takes.
 */
export function parameterForArgument(
    call: ts.CallExpression | ts.NewExpression,
    declaration: Pick<ts.SignatureDeclarationBase, "parameters">,
    argumentIndex: number,
):
    | { readonly parameter: ts.ParameterDeclaration; readonly rest: boolean }
    | "unknown"
    | undefined {
    const args = call.arguments ?? [];
    if (args.slice(0, argumentIndex + 1).some(ts.isSpreadElement))
        return "unknown";
    const rest = restParameterIndex(declaration);
    if (rest !== undefined && argumentIndex >= rest)
        return { parameter: declaration.parameters[rest]!, rest: true };
    const parameter = declaration.parameters[argumentIndex];
    return parameter && { parameter, rest: false };
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

/** A declaration that binds its name in scope. */
type BindingDeclaration =
    | ts.VariableDeclaration
    | ts.ParameterDeclaration
    | ts.BindingElement
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ClassDeclaration
    | ts.ClassExpression
    | ts.InterfaceDeclaration
    | ts.TypeAliasDeclaration
    | ts.TypeParameterDeclaration
    | ts.EnumDeclaration
    | ts.EnumMember
    | ts.ModuleDeclaration
    | ts.ImportSpecifier
    | ts.ImportClause
    | ts.NamespaceImport
    | ts.ImportEqualsDeclaration;

function isBindingDeclaration(node: ts.Node): node is BindingDeclaration {
    return (
        ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isTypeParameterDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isEnumMember(node) ||
        ts.isModuleDeclaration(node) ||
        ts.isImportSpecifier(node) ||
        ts.isImportClause(node) ||
        ts.isNamespaceImport(node) ||
        ts.isImportEqualsDeclaration(node)
    );
}

/** A declaration that names a member of an object, class, type or module. */
type MemberDeclaration =
    | ts.PropertyAssignment
    | ts.PropertyDeclaration
    | ts.PropertySignature
    | ts.MethodDeclaration
    | ts.MethodSignature
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration
    | ts.NamespaceExport;

function isMemberDeclaration(node: ts.Node): node is MemberDeclaration {
    return (
        ts.isPropertyAssignment(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isMethodSignature(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isNamespaceExport(node)
    );
}

/**
 * The declaration `node` is the own name of: `x` in `const x`, `(x)`,
 * `function x`, `{ x: 1 }` or `x(): T`. A shorthand `{ x }` reads `x`; it
 * declares nothing.
 */
export function declarationNamed(
    node: ts.Node,
): BindingDeclaration | MemberDeclaration | undefined {
    const parent = node.parent;
    return parent &&
        (isBindingDeclaration(parent) || isMemberDeclaration(parent)) &&
        parent.name === node
        ? parent
        : undefined;
}

/**
 * Whether an identifier names a member of what it is read from, not a
 * binding in scope: `o.x`, `Q.X`, a property, method or accessor's own
 * name, a pattern's `{ x: local }` key, an import's or export's
 * module-side name, a JSX attribute.
 */
export function namesMember(identifier: ts.Identifier): boolean {
    const parent = identifier.parent as ts.Node | undefined;
    if (!parent) return false;
    if (
        (isMemberDeclaration(parent) ||
            ts.isPropertyAccessExpression(parent) ||
            ts.isJsxAttribute(parent)) &&
        parent.name === identifier
    )
        return true;
    if (ts.isQualifiedName(parent)) return parent.right === identifier;
    if (ts.isBindingElement(parent) || ts.isImportSpecifier(parent))
        return parent.propertyName === identifier;
    // `export { local as name }` reads `local`; a re-export reads nothing here.
    if (ts.isExportSpecifier(parent))
        return (
            (parent.propertyName ?? parent.name) !== identifier ||
            parent.parent.parent.moduleSpecifier !== undefined
        );
    return false;
}

/**
 * Whether an identifier reads or writes a binding when the code runs: not
 * a declaration's own name ({@link declarationNamed}), a member name
 * ({@link namesMember}), a label, `new.target`/`import.meta`'s second
 * name, or a name in a type. A shorthand `{ x }` reads `x`, `export { x }`
 * reads the local `x`, and a class's `extends` expression runs.
 */
export function isValueReference(identifier: ts.Identifier): boolean {
    // A synthesized identifier standing alone reads its binding.
    const parent = identifier.parent as ts.Node | undefined;
    if (!parent) return true;
    if (declarationNamed(identifier) || namesMember(identifier)) return false;
    if (ts.isExportSpecifier(parent))
        return !parent.isTypeOnly && !parent.parent.parent.isTypeOnly;
    if (
        ts.isMetaProperty(parent) ||
        ((ts.isLabeledStatement(parent) ||
            ts.isBreakStatement(parent) ||
            ts.isContinueStatement(parent)) &&
            parent.label === identifier)
    )
        return false;
    return !inTypePosition(identifier);
}

/**
 * The expression a use of a name reads or writes: the identifier itself
 * ({@link isValueReference}), or the `o.name`/`o.#name` access it names.
 * Undefined where it names no run-time value.
 */
export function referenceSite(
    name: ts.Identifier | ts.PrivateIdentifier,
): ts.Identifier | ts.PropertyAccessExpression | undefined {
    const parent = name.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === name)
        return inTypePosition(parent) ? undefined : parent;
    return ts.isIdentifier(name) && isValueReference(name) ? name : undefined;
}

/** Whether a node sits in a type, which the code does not evaluate. */
function inTypePosition(node: ts.Node): boolean {
    for (let current = node; current.parent; current = current.parent) {
        const parent = current.parent;
        // `class C extends Base<T>`: the base expression runs, its arguments are types.
        if (ts.isExpressionWithTypeArguments(parent)) {
            const heritage = parent.parent;
            return !(
                parent.expression === current &&
                ts.isHeritageClause(heritage) &&
                heritage.token === ts.SyntaxKind.ExtendsKeyword &&
                ts.isClassLike(heritage.parent)
            );
        }
        if (ts.isTypeNode(parent)) return true;
        if (ts.isStatement(parent) || ts.isSourceFile(parent)) return false;
    }
    return false;
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
 * The property key a literal converts to (ToPropertyKey): a string or a
 * template without substitutions as written, a number or bigint as its
 * decimal text (`0x10` -> "16", `1n` -> "1", `-1` -> "-1"), `true`,
 * `false` or `null` as its word. Undefined for any other expression: only
 * the run time knows its key.
 */
export function literalKey(expression: ts.Expression): string | undefined {
    const literal = unwrapExpression(expression);
    // The scanner already spells a numeric literal canonically.
    if (ts.isStringLiteralLike(literal) || ts.isNumericLiteral(literal))
        return literal.text;
    if (ts.isBigIntLiteral(literal))
        return BigInt(literal.text.slice(0, -1)).toString();
    if (
        ts.isPrefixUnaryExpression(literal) &&
        literal.operator === ts.SyntaxKind.MinusToken
    ) {
        const operand = unwrapExpression(literal.operand);
        if (ts.isNumericLiteral(operand)) return String(-Number(operand.text));
        if (ts.isBigIntLiteral(operand))
            return (-BigInt(operand.text.slice(0, -1))).toString();
        return undefined;
    }
    switch (literal.kind) {
        case ts.SyntaxKind.TrueKeyword:
            return "true";
        case ts.SyntaxKind.FalseKeyword:
            return "false";
        case ts.SyntaxKind.NullKeyword:
            return "null";
        default:
            return undefined;
    }
}

/**
 * The key a property name declares when the syntax alone decides it: an
 * identifier's or private name's text (`#x` keeps its `#`), a literal's
 * key ({@link literalKey}), or a computed key that is such a literal.
 * Undefined for any other computed key.
 */
export function propertyKey(name: ts.PropertyName): string | undefined {
    if (ts.isComputedPropertyName(name)) return literalKey(name.expression);
    if (ts.isBigIntLiteral(name)) return literalKey(name);
    return name.text;
}

/**
 * The key an alias analysis records where only the run time knows it: it
 * may be every key, so it matches each one. A literal `"*"` key matching
 * everything too only over-approximates.
 */
export const ANY_KEY = "*";

/** A key for an alias analysis: `key`, or {@link ANY_KEY} where it is unknown. */
export function aliasKey(key: string | undefined): string {
    return key ?? ANY_KEY;
}

/**
 * The array index a key names: its canonical non-negative integer
 * (`"2"` -> 2; `"02"`, `"-1"`, `"1.5"` name no index).
 */
export function keyIndex(key: string | undefined): number | undefined {
    const value = Number(key);
    return key !== undefined &&
        key !== "" &&
        String(value) === key &&
        Number.isSafeInteger(value) &&
        value >= 0
        ? value
        : undefined;
}

/** Whether two alias keys may name the same property. */
export function keysMayMatch(left: string, right: string): boolean {
    return left === right || left === ANY_KEY || right === ANY_KEY;
}

/**
 * The key an access reads when the syntax alone decides it: `o.x` -> "x",
 * `o.#x` -> "#x", `o[k]` -> k's {@link literalKey}. Undefined for a key
 * only the run time knows.
 */
export function accessKey(
    access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined {
    return ts.isPropertyAccessExpression(access)
        ? access.name.text
        : literalKey(access.argumentExpression);
}

/**
 * The base a class's `extends` clause names, or undefined: an `implements`
 * clause names no base, so a class that only implements is no subclass.
 */
export function classBaseExpression(
    declaration: ts.ClassLikeDeclaration,
): ts.ExpressionWithTypeArguments | undefined {
    return declaration.heritageClauses?.find(
        (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
    )?.types[0];
}

/** A member access, dotted or keyed: `o.m`, `o["m"]`, `o[k]`. */
export type MemberAccess =
    ts.PropertyAccessExpression | ts.ElementAccessExpression;

/** Whether a node is a member access, whatever its key. */
export function isMemberAccess(node: ts.Node): node is MemberAccess {
    return (
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)
    );
}

/**
 * One member of an object literal, as the literal evaluates it: `key` is
 * the key it writes, undefined for a run-time key. A `proto` member is a
 * non-computed `__proto__: v`, which sets the prototype and is no own key;
 * a `spread` copies keys the syntax does not name.
 */
export type ObjectMember =
    | {
          readonly kind: "property";
          readonly node: ts.PropertyAssignment;
          readonly key: string | undefined;
          readonly value: ts.Expression;
      }
    | {
          readonly kind: "shorthand";
          readonly node: ts.ShorthandPropertyAssignment;
          readonly key: string;
          readonly value: ts.Identifier;
      }
    | {
          readonly kind: "method" | "accessor";
          readonly node:
              | ts.MethodDeclaration
              | ts.GetAccessorDeclaration
              | ts.SetAccessorDeclaration;
          readonly key: string | undefined;
          readonly value?: undefined;
      }
    | {
          readonly kind: "proto";
          readonly node: ts.PropertyAssignment;
          readonly key?: undefined;
          readonly value: ts.Expression;
      }
    | {
          readonly kind: "spread";
          readonly node: ts.SpreadAssignment;
          readonly key?: undefined;
          readonly value?: undefined;
      };

/**
 * Whether a literal member is a `__proto__: v` or `"__proto__": v`: it sets
 * the new object's prototype and creates no own key. A computed
 * `["__proto__"]`, a shorthand or a method named so are own keys.
 */
export function isProtoSetter(member: ts.ObjectLiteralElementLike): boolean {
    return (
        ts.isPropertyAssignment(member) &&
        !ts.isComputedPropertyName(member.name) &&
        propertyKey(member.name) === "__proto__"
    );
}

/** A literal setting its prototype refuses: the supported subset sets none. */
export function refuseProtoSetter(
    member: ts.ObjectLiteralElementLike,
    fail: (node: ts.Node, message: string) => never,
): void {
    if (isProtoSetter(member))
        fail(
            member,
            "Setting a literal's prototype (`__proto__: v`) is outside the supported subset.",
        );
}

/**
 * The members of an object literal (or of its properties, spreads already
 * expanded), in evaluation order. `keyOf` reads a key: the syntax's by
 * default, a lowering's resolver where the checker or generation fixes a
 * computed key.
 */
export function objectLiteralMembers(
    object: ts.ObjectLiteralExpression | readonly ts.ObjectLiteralElementLike[],
    keyOf: (name: ts.PropertyName) => string | undefined = propertyKey,
): ObjectMember[] {
    return ("properties" in object ? object.properties : object).map(
        (node): ObjectMember => {
            if (ts.isSpreadAssignment(node)) return { kind: "spread", node };
            if (ts.isShorthandPropertyAssignment(node))
                return {
                    kind: "shorthand",
                    node,
                    key: node.name.text,
                    value: node.name,
                };
            if (ts.isPropertyAssignment(node))
                return isProtoSetter(node)
                    ? { kind: "proto", node, value: node.initializer }
                    : {
                          kind: "property",
                          node,
                          key: keyOf(node.name),
                          value: node.initializer,
                      };
            return {
                kind: ts.isMethodDeclaration(node) ? "method" : "accessor",
                node,
                key: keyOf(node.name),
            };
        },
    );
}

/** A member storing named data: a property or shorthand with a known key. */
export type DataMember = Extract<
    ObjectMember,
    { kind: "property" | "shorthand" }
> & {
    readonly key: string;
};

/**
 * The members of an object literal that only stores named data, in order;
 * undefined when one is a spread, a method, an accessor, a `__proto__`
 * setter or a run-time key.
 */
export function plainDataMembers(
    literal: ts.ObjectLiteralExpression,
): readonly DataMember[] | undefined {
    const members: DataMember[] = [];
    for (const member of objectLiteralMembers(literal)) {
        if (
            (member.kind !== "property" && member.kind !== "shorthand") ||
            member.key === undefined
        )
            return undefined;
        members.push({ ...member, key: member.key });
    }
    return members;
}

/**
 * The member that decides `key`: the last one writing it, `"unknown"` when
 * a later spread or run-time key may write it too, undefined when nothing
 * does. `spreadMayWrite` narrows which spreads can (the checker knows a
 * spread whose type has no such key); by default every one may.
 */
export function lastWriter(
    members: readonly ObjectMember[],
    key: string,
    spreadMayWrite: (
        spread: ts.SpreadAssignment,
        key: string,
    ) => boolean = () => true,
): ObjectMember | "unknown" | undefined {
    let writer: ObjectMember | "unknown" | undefined;
    for (const member of members) {
        if (member.kind === "proto") continue;
        if (member.kind === "spread") {
            if (spreadMayWrite(member.node, key)) writer = "unknown";
        } else if (member.key === key) writer = member;
        else if (member.key === undefined) writer = "unknown";
    }
    return writer;
}

/**
 * The value an object literal (or its properties, spreads already expanded)
 * gives `name`: its last writer's initializer, or the shorthand identifier
 * standing for one ({@link lastWriter}). Undefined where no member writes
 * it, a method or accessor does, or a later spread or run-time key may.
 */
export function objectProperty(
    object: ts.ObjectLiteralExpression | readonly ts.ObjectLiteralElementLike[],
    name: string,
): ts.Expression | undefined {
    const writer = lastWriter(objectLiteralMembers(object), name);
    return writer === "unknown" ? undefined : writer?.value;
}

/** An array literal element and the index it lands at. */
export interface ArraySlot {
    readonly element: ts.Expression;
    /**
     * The element's index; undefined for a spread and every element after
     * one, whose index the spread's length decides. A hole keeps its index.
     */
    readonly index: number | undefined;
}

/** Each element of an array literal with the index it lands at ({@link ArraySlot}). */
export function arrayLiteralSlots(
    literal: ts.ArrayLiteralExpression,
): ArraySlot[] {
    let shifted = false;
    return literal.elements.map((element, position) => {
        if (ts.isSpreadElement(element)) shifted = true;
        return { element, index: shifted ? undefined : position };
    });
}

/**
 * The name a specifier reads on its source side: the export it imports or
 * re-exports (`a` in `import { a as b }`), or the local binding a local
 * export exposes.
 */
export function specifierSourceName(
    specifier: ts.ImportSpecifier | ts.ExportSpecifier,
): string {
    return (specifier.propertyName ?? specifier.name).text;
}

/**
 * The key an object binding element reads: its `propertyName`'s, else its
 * own identifier's (`{ a }`). Undefined for a run-time computed key.
 */
export function bindingElementKey(
    element: ts.BindingElement,
): string | undefined {
    return element.propertyName
        ? propertyKey(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : undefined;
}

/** What one destructuring element takes from the value its pattern reads. */
export type PatternRead =
    /**
     * One member: an object element's key (undefined for a run-time computed
     * key) or an array element's index (`key` is its text).
     */
    | {
          readonly kind: "member";
          readonly key: string | undefined;
      }
    /** An object rest: a new object of the own keys the pattern did not name. */
    | {
          readonly kind: "rest";
          /** The keys named before it; undefined when one is a run-time key. */
          readonly excluded: readonly string[] | undefined;
      }
    /** An array rest: a new array of the elements from `index` on. */
    | { readonly kind: "rest-from"; readonly index: number };

/** One element of a binding or assignment pattern. */
export interface PatternSlot<
    Target extends ts.BindingName | ts.Expression =
        ts.BindingName | ts.Expression,
> {
    readonly element: ts.Node;
    /** What receives the value: a name, a nested pattern or a write target. */
    readonly target: Target;
    readonly read: PatternRead;
    /** The default that stands in for an undefined value (`{ a = 1 }`). */
    readonly fallback?: ts.Expression;
}

/**
 * Each element of a destructuring pattern, declared (`const { a } = v`) or
 * assigned (`({ a } = v)`), with what it reads ({@link PatternRead}). Holes
 * read nothing but keep later indices.
 */
export function patternSlots(
    pattern: ts.BindingPattern,
): PatternSlot<ts.BindingName>[];
export function patternSlots(
    pattern: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
): PatternSlot<ts.Expression>[];
export function patternSlots(
    pattern:
        | ts.BindingPattern
        | ts.ObjectLiteralExpression
        | ts.ArrayLiteralExpression,
): PatternSlot[] {
    const slots: PatternSlot[] = [];
    // `x = fallback` in an assignment pattern.
    const assigned = (
        element: ts.Node,
        value: ts.Expression,
        read: PatternRead,
    ): PatternSlot =>
        isAssignmentExpression(value) &&
        value.operatorToken.kind === ts.SyntaxKind.EqualsToken
            ? { element, target: value.left, read, fallback: value.right }
            : { element, target: value, read };
    if (
        ts.isArrayBindingPattern(pattern) ||
        ts.isArrayLiteralExpression(pattern)
    ) {
        pattern.elements.forEach((element, index) => {
            if (ts.isOmittedExpression(element)) return;
            const rest =
                ts.isSpreadElement(element) ||
                (ts.isBindingElement(element) && element.dotDotDotToken);
            const read: PatternRead = rest
                ? { kind: "rest-from", index }
                : { kind: "member", key: String(index) };
            if (ts.isBindingElement(element))
                slots.push({
                    element,
                    target: element.name,
                    read,
                    ...(element.initializer
                        ? { fallback: element.initializer }
                        : {}),
                });
            else
                slots.push(
                    assigned(
                        element,
                        ts.isSpreadElement(element)
                            ? element.expression
                            : element,
                        read,
                    ),
                );
        });
        return slots;
    }
    let excluded: string[] | undefined = [];
    const named = (key: string | undefined): PatternRead => {
        if (key === undefined) excluded = undefined;
        else excluded?.push(key);
        return { kind: "member", key };
    };
    const rest = (): PatternRead => ({
        kind: "rest",
        excluded: excluded && [...excluded],
    });
    const elements: readonly ts.Node[] = ts.isObjectBindingPattern(pattern)
        ? pattern.elements
        : pattern.properties;
    for (const element of elements) {
        if (ts.isBindingElement(element)) {
            const read = element.dotDotDotToken
                ? rest()
                : named(bindingElementKey(element));
            slots.push({
                element,
                target: element.name,
                read,
                ...(element.initializer
                    ? { fallback: element.initializer }
                    : {}),
            });
        } else if (ts.isShorthandPropertyAssignment(element)) {
            slots.push({
                element,
                target: element.name,
                read: named(element.name.text),
                ...(element.objectAssignmentInitializer
                    ? { fallback: element.objectAssignmentInitializer }
                    : {}),
            });
        } else if (ts.isPropertyAssignment(element)) {
            slots.push(
                assigned(
                    element,
                    element.initializer,
                    named(propertyKey(element.name)),
                ),
            );
        } else if (ts.isSpreadAssignment(element)) {
            slots.push({ element, target: element.expression, read: rest() });
        }
    }
    return slots;
}

/**
 * The expression a literal's member takes its value from: the last plain
 * or shorthand property of an object literal writing `key`, with no spread
 * or computed key after it that may write it too, or an array literal's
 * element at index `key` when no spread before it shifts it. Undefined
 * where the syntax does not name one (a hole reads undefined).
 */
export function literalMember(
    expression: ts.Expression,
    key: string | number,
): ts.Expression | undefined {
    const literal = unwrapExpression(expression);
    if (typeof key === "number") {
        if (!ts.isArrayLiteralExpression(literal)) return undefined;
        const element = arrayLiteralSlots(literal).find(
            (slot) => slot.index === key,
        )?.element;
        return element && !ts.isOmittedExpression(element)
            ? element
            : undefined;
    }
    return ts.isObjectLiteralExpression(literal)
        ? objectProperty(literal, key)
        : undefined;
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

export type SupportedFunction =
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction
    | ts.MethodDeclaration;

/** The four declaration shapes this compiler inlines, as one narrowing. */
export function isSupportedFunction(
    node: ts.Node | undefined,
): node is SupportedFunction {
    return (
        node !== undefined &&
        (ts.isFunctionDeclaration(node) ||
            ts.isFunctionExpression(node) ||
            ts.isArrowFunction(node) ||
            ts.isMethodDeclaration(node))
    );
}

/** A supported function with the body a call runs. */
export type FunctionWithBody = SupportedFunction & {
    readonly body: ts.ConciseBody;
};

/** Whether a node is a supported function with a body: an overload or abstract member has none. */
export function isFunctionWithBody(
    node: ts.Node | undefined,
): node is FunctionWithBody {
    return isSupportedFunction(node) && node.body !== undefined;
}

/**
 * How a variable is declared: `var`, `let`, or `const` -- `using` and
 * `await using` bind like `const`, never reassigned.
 */
export type VariableKind = "var" | "let" | "const";

/**
 * The keyword a variable is declared with, read from its declaration list:
 * the list itself, a declaration in it, or a binding element (or pattern)
 * of one. Undefined for any other binding: a parameter, a catch variable.
 */
export function variableKind(node: ts.Node): VariableKind | undefined {
    let list = node;
    while (
        ts.isBindingElement(list) ||
        ts.isArrayBindingPattern(list) ||
        ts.isObjectBindingPattern(list)
    )
        list = list.parent;
    if (ts.isVariableDeclaration(list)) list = list.parent;
    if (!ts.isVariableDeclarationList(list)) return undefined;
    if (list.flags & (ts.NodeFlags.Const | ts.NodeFlags.Using)) return "const";
    return list.flags & ts.NodeFlags.Let ? "let" : "var";
}

/** Whether a variable is `let` or `const`: scoped to its block, a fresh binding per loop iteration. */
export function isBlockScopedVariable(node: ts.Node): boolean {
    const kind = variableKind(node);
    return kind === "let" || kind === "const";
}

/**
 * The function a declaration binds: a function declaration with a body, a
 * named function expression (its own name), or a variable initialized with a
 * function literal, through parentheses and type assertions.
 */
export function functionOfDeclaration(
    declaration: ts.Declaration,
): Exclude<FunctionWithBody, ts.MethodDeclaration> | undefined {
    if (
        ts.isFunctionDeclaration(declaration) &&
        isFunctionWithBody(declaration)
    )
        return declaration;
    // A named function expression is its own name's declaration.
    if (ts.isFunctionExpression(declaration) && declaration.name)
        return declaration;
    const initializer =
        ts.isVariableDeclaration(declaration) && declaration.initializer
            ? unwrapExpression(declaration.initializer)
            : undefined;
    return initializer &&
        (ts.isArrowFunction(initializer) ||
            ts.isFunctionExpression(initializer))
        ? initializer
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
    const fn = ts.isVariableDeclaration(declaration)
        ? variableKind(declaration) === "const"
            ? functionOfDeclaration(declaration)
            : undefined
        : declaration;
    return fn &&
        (ts.isFunctionDeclaration(fn) ||
            ts.isArrowFunction(fn) ||
            ts.isFunctionExpression(fn)) &&
        fn.body !== undefined &&
        functionKind(fn) === "plain"
        ? fn
        : undefined;
}

/**
 * The construct a jump binds by the language's rule: a bare return its
 * function, a labeled jump its labeled statement, a continue the nearest
 * loop and a break the nearest loop or switch.
 */
export function jumpBinding(
    statement: ts.BreakStatement | ts.ContinueStatement | ts.ReturnStatement,
): ts.Node | undefined {
    if (ts.isReturnStatement(statement))
        return ts.findAncestor(statement.parent, ts.isFunctionLike);
    for (
        let parent: ts.Node | undefined = statement.parent;
        parent && !ts.isFunctionLike(parent);
        parent = parent.parent
    ) {
        if (statement.label) {
            if (
                ts.isLabeledStatement(parent) &&
                parent.label.text === statement.label.text
            )
                return parent;
        } else if (
            ts.isIterationStatement(parent, false) ||
            (ts.isBreakStatement(statement) && ts.isSwitchStatement(parent))
        )
            return parent;
    }
    return undefined;
}

/** The statement a label names, through further labels (`a: b: for`). */
export function labeledBody(statement: ts.LabeledStatement): ts.Statement {
    let body = statement.statement;
    while (ts.isLabeledStatement(body)) body = body.statement;
    return body;
}

/**
 * Whether a break or continue jumps to `target`, a loop or switch: it binds
 * it, or a label it binds names it.
 */
export function jumpsTo(
    jump: ts.BreakStatement | ts.ContinueStatement,
    target: ts.Statement,
): boolean {
    const binding = jumpBinding(jump);
    return (
        binding === target ||
        (binding !== undefined &&
            ts.isLabeledStatement(binding) &&
            labeledBody(binding) === target)
    );
}

/**
 * What calling a function-like starts: its body at once (`plain`), or a
 * promise, an iterator or an async iterator that runs it.
 */
export type FunctionKind = "plain" | "async" | "generator" | "async generator";

/** The kind a function-like is declared as: `async`, `*`, both or neither. */
export function functionKind(fn: ts.SignatureDeclaration): FunctionKind {
    const generator = "asteriskToken" in fn && fn.asteriskToken !== undefined;
    const async =
        ts.canHaveModifiers(fn) &&
        (ts
            .getModifiers(fn)
            ?.some(
                (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
            ) ??
            false);
    if (async) return generator ? "async generator" : "async";
    return generator ? "generator" : "plain";
}

/** Whether a node is a function declared `async` (an async generator too): its body may await. */
export function isAsyncFunction(node: ts.Node): boolean {
    if (!ts.isFunctionLike(node)) return false;
    const kind = functionKind(node);
    return kind === "async" || kind === "async generator";
}

/** Whether a node is a generator function (an async generator too): calling it returns an iterator. */
export function isGeneratorFunction(node: ts.Node): boolean {
    if (!ts.isFunctionLike(node)) return false;
    const kind = functionKind(node);
    return kind === "generator" || kind === "async generator";
}

/**
 * Whether `node` itself suspends its activation: an `await`, a `for await`
 * loop (every step awaits) and, when asked, a generator's `yield`.
 */
export function isSuspensionPoint(
    node: ts.Node,
    options: { readonly yield?: boolean } = {},
): boolean {
    return (
        ts.isAwaitExpression(node) ||
        (ts.isForOfStatement(node) && node.awaitModifier !== undefined) ||
        (options.yield === true && ts.isYieldExpression(node))
    );
}

/**
 * Whether the activation running `node` suspends anywhere in it. A function
 * is another activation, `node` itself included: pass a function's body.
 */
export function containsSuspension(
    node: ts.Node,
    options: { readonly yield?: boolean } = {},
): boolean {
    if (ts.isFunctionLike(node)) return false;
    return (
        isSuspensionPoint(node, options) ||
        ts.forEachChild(node, (child) =>
            containsSuspension(child, options) ? true : undefined,
        ) === true
    );
}

/** @unjournaled Parsed syntax is immutable: a queried node's fingerprint, kept. */
const sourceFingerprints = new WeakMap<ts.Node, string>();

/**
 * A node's syntax as text: its kind with its children's, names and literals
 * by value, seen through expression wrappers. Layout, comments, commas and
 * semicolons do not count.
 */
function sourceFingerprint(node: ts.Node): string {
    const parsed =
        node.pos >= 0 && (node.flags & ts.NodeFlags.Synthesized) === 0;
    const known = parsed ? sourceFingerprints.get(node) : undefined;
    if (known !== undefined) return known;
    const fingerprint = fingerprintIn(node, node.getSourceFile());
    if (parsed) sourceFingerprints.set(node, fingerprint);
    return fingerprint;
}

/** {@link sourceFingerprint}, walking the children `file` holds. */
function fingerprintIn(node: ts.Node, file: ts.SourceFile): string {
    if (isExpressionWrapper(node)) return fingerprintIn(node.expression, file);
    const leaf = fingerprintLeaf(node);
    if (leaf !== undefined) return leaf;
    const children = node
        .getChildren(file)
        .filter(
            (child) =>
                !ts.isJSDoc(child) &&
                child.kind !== ts.SyntaxKind.CommaToken &&
                child.kind !== ts.SyntaxKind.SemicolonToken,
        );
    if (children.length === 0) return ts.SyntaxKind[node.kind];
    return `${ts.SyntaxKind[node.kind]}(${children
        .map((child) => fingerprintIn(child, file))
        .join(",")})`;
}

/** A name's or literal's fingerprint. */
function fingerprintLeaf(node: ts.Node): string | undefined {
    if (ts.isIdentifier(node)) return `identifier:${node.text}`;
    if (ts.isPrivateIdentifier(node)) return `private:${node.text}`;
    if (ts.isNumericLiteral(node)) return `number:${Number(node.text)}`;
    if (ts.isStringLiteralLike(node)) return `string:${node.text}`;
    return undefined;
}

/**
 * The leading segment of `sourceFingerprint(node)` without the walk, or
 * undefined for the wrappers the fingerprint sees through.
 */
function fingerprintHead(node: ts.Node): string | undefined {
    if (isExpressionWrapper(node)) return undefined;
    return fingerprintLeaf(node) ?? ts.SyntaxKind[node.kind];
}

/** Each source shape's fingerprint by parse context, parsed once per process. */
const shapeFingerprints = new Map<string, string>();

/** What a source shape is parsed as. */
export type ShapeKind = "expression" | "type" | "binding";

/** The kind of syntax `node` is, for the shape it is compared with. */
function shapeKindOf(node: ts.Node): ShapeKind {
    return ts.isTypeNode(node)
        ? "type"
        : ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)
          ? "binding"
          : "expression";
}

/**
 * The fingerprint of `shape` parsed as `context`. A table key that is no
 * expression (`strict` false) matches nothing.
 */
function shapeFingerprint(
    shape: string,
    context: ShapeKind,
    strict = true,
): string {
    const key = `${context}\u0000${shape}`;
    const cached = shapeFingerprints.get(key);
    if (cached !== undefined) return cached;
    const statement = ts.createSourceFile(
        "expected-shape.ts",
        context === "type"
            ? `let expected: ${shape};`
            : context === "binding"
              ? `const ${shape} = expected;`
              : `const expected = ${shape};`,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    ).statements[0];
    const declaration =
        statement && ts.isVariableStatement(statement)
            ? statement.declarationList.declarations[0]
            : undefined;
    const parsed =
        context === "type"
            ? declaration?.type
            : context === "binding"
              ? declaration?.name
              : declaration?.initializer;
    // A shape that is no type or binding pattern matches no node there; an
    // expression shape that does not parse is a lowering's own mistake.
    if (!parsed && context === "expression" && strict)
        throw new Error(`Invalid expected expression '${shape}'.`);
    const fingerprint = parsed ? sourceFingerprint(parsed) : "";
    shapeFingerprints.set(key, fingerprint);
    return fingerprint;
}

/**
 * The first of `shapes` that `node` is, parsed as `context` (`strict`: an
 * expression shape that does not parse is the caller's mistake). Most
 * candidates are not even the shape's node kind: the head is compared
 * first, so `node` is fingerprinted only against a shape it may be.
 */
function matchingShape(
    node: ts.Node,
    shapes: Iterable<string>,
    context: ShapeKind,
    strict: boolean,
): string | undefined {
    const head = fingerprintHead(node);
    let fingerprint: string | undefined;
    for (const shape of shapes) {
        const expected = shapeFingerprint(shape, context, strict);
        if (
            head !== undefined &&
            expected !== head &&
            !expected.startsWith(`${head}(`)
        )
            continue;
        fingerprint ??= sourceFingerprint(node);
        if (expected === fingerprint) return shape;
    }
    return undefined;
}

/**
 * Whether `node` is the source `shape`: the same syntax, read through
 * parentheses and other expression wrappers and ignoring layout and
 * comments. How a lowering recognizes a fixed piece of source (a pinned
 * call, a member name, a declared type) without comparing its text. The
 * shape is parsed as the kind of syntax `node` is unless `kind` says (a
 * walk comparing every node with an expression shape).
 */
export function sameSource(
    node: ts.Node | undefined,
    shape: string | undefined,
    kind?: ShapeKind,
): boolean {
    if (node === undefined || shape === undefined) return false;
    return (
        matchingShape(node, [shape], kind ?? shapeKindOf(node), true) !==
        undefined
    );
}

/**
 * The value `table` keeps under the source shape `node` is, or undefined:
 * how a lowering reads a table keyed by pinned source shapes.
 */
export function sourceEntry<T>(
    table: ReadonlyMap<string, T> | undefined,
    node: ts.Node | undefined,
): T | undefined {
    if (table === undefined || node === undefined) return undefined;
    const shape = matchingShape(node, table.keys(), shapeKindOf(node), false);
    return shape === undefined ? undefined : table.get(shape);
}

/** Whether `node` is one of the source shapes `shapes`. */
export function isOneOfSources(
    node: ts.Node | undefined,
    shapes: Iterable<string>,
): boolean {
    return (
        node !== undefined &&
        matchingShape(node, shapes, shapeKindOf(node), false) !== undefined
    );
}

/** Whether two nodes, perhaps of different files, are the same syntax. */
export function sameSyntax(left: ts.Node, right: ts.Node): boolean {
    // A wrapper has no head: the fingerprint sees through it.
    const leftHead = fingerprintHead(left);
    const rightHead = fingerprintHead(right);
    return (
        (leftHead === undefined ||
            rightHead === undefined ||
            leftHead === rightHead) &&
        sourceFingerprint(left) === sourceFingerprint(right)
    );
}

/**
 * `a.b.c` (or `this.b.c`) as its names, read through wrappers: the path a
 * lowering names a member chain by. Undefined for anything else.
 */
export function propertyPath(expression: ts.Expression): string[] | undefined {
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped)) return [unwrapped.text];
    if (unwrapped.kind === ts.SyntaxKind.ThisKeyword) return ["this"];
    if (!ts.isPropertyAccessExpression(unwrapped)) return undefined;
    const owner = propertyPath(unwrapped.expression);
    return owner ? [...owner, unwrapped.name.text] : undefined;
}

/**
 * The one name a binding declares: an identifier's text. A destructuring
 * pattern declares several, so a reader that needs one refuses it.
 */
export function soleBindingName(name: ts.BindingName): string;
export function soleBindingName(
    name: ts.BindingName | undefined,
): string | undefined;
export function soleBindingName(
    name: ts.BindingName | undefined,
): string | undefined {
    if (name === undefined) return undefined;
    if (ts.isIdentifier(name)) return name.text;
    throw new Error(
        "Expected a binding with one name, found a destructuring pattern.",
    );
}

/**
 * The key a member declares, for a reader that needs one: refused for a
 * computed key the syntax alone does not decide ({@link propertyKey}).
 */
export function declaredKey(name: ts.PropertyName): string {
    const key = propertyKey(name);
    if (key === undefined)
        throw new Error("Expected a member with a literal name.");
    return key;
}

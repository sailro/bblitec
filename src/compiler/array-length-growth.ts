import ts from "typescript";
import {
    countedLoopShape,
    counterWrite,
    stepsUpByOne,
} from "./counted-loops.js";
import { declarationOrigin, resolvedSymbol, sameReference } from "./symbols.js";
import {
    outermostWrapper,
    referenceSite,
    unwrapExpression,
    writeSiteOf,
    isDeclaredInside,
    isSuspensionPoint,
    jumpBinding,
    jumpsTo,
    variableKind,
} from "./syntax.js";
import { someAnalysisNode } from "./analysis-walk.js";
import type { EvaluationOrder } from "./evaluation-order.js";

/**
 * The fill loop that makes `xs.length = n` growth unobservable:
 *
 * ```ts
 * xs.length = n;
 * for (let i = start; i < n; i++) { xs[i] = value; ... }
 * ```
 *
 * JavaScript leaves holes from the old length to `n`; reading one yields
 * `undefined`, which storage with one absent state cannot tell from `null`.
 * The loop writes slot `i` before anything else in its iteration, nothing it
 * reaches names `xs`, no other binding aliases the array, and it leaves only
 * by finishing or by throwing, so no hole is read while one exists. Holes before `start` would survive: the
 * caller checks `start` against the old length at run time.
 */
export interface FilledLengthGrowth {
    /** The loop's first slot, a constant or binding evaluated at the growth. */
    readonly start: ts.Expression;
}

/**
 * The fill loop following `assignment`, when one proves the growth
 * unobservable ({@link FilledLengthGrowth}); undefined otherwise.
 */
export function filledLengthGrowth(
    program: ts.Program,
    checker: ts.TypeChecker,
    order: EvaluationOrder,
    assignment: ts.BinaryExpression,
): FilledLengthGrowth | undefined {
    const statement = assignment.parent;
    if (
        assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
        !ts.isExpressionStatement(statement) ||
        !ts.isBlock(statement.parent)
    )
        return undefined;
    const lengthAccess = unwrapExpression(assignment.left);
    if (!ts.isPropertyAccessExpression(lengthAccess)) return undefined;
    const array = unwrapExpression(lengthAccess.expression);
    const arraySymbol = stablePathSymbol(checker, array);
    const length = unwrapExpression(assignment.right);
    const lengthSymbol = constantBindingSymbol(checker, length);
    if (!arraySymbol || !lengthSymbol) return undefined;
    const siblings = statement.parent.statements;
    const loop = siblings[siblings.indexOf(statement) + 1];
    if (!loop || !ts.isForStatement(loop)) return undefined;
    const counter = loopCounter(checker, loop, lengthSymbol);
    if (!counter || !ts.isBlock(loop.statement)) return undefined;
    const [first, ...rest] = loop.statement.statements;
    if (
        !first ||
        !ts.isExpressionStatement(first) ||
        !ts.isBinaryExpression(first.expression) ||
        first.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    )
        return undefined;
    const write = unwrapExpression(first.expression.left);
    if (
        !ts.isElementAccessExpression(write) ||
        stablePathSymbol(checker, unwrapExpression(write.expression)) !==
            arraySymbol ||
        !sameReference(checker, write.expression, array) ||
        resolvedSymbol(checker, unwrapExpression(write.argumentExpression)) !==
            counter.symbol
    )
        return undefined;
    if (identityEscapes(program, checker, arraySymbol)) return undefined;
    const reach = new ReachedReferences(order, checker, arraySymbol);
    if (
        reach.names(first.expression.right) ||
        rest.some((node) => reach.names(node) || exitsLoop(node, loop))
    )
        return undefined;
    const start = constantBindingSymbol(checker, counter.start)
        ? counter.start
        : numericLiteral(counter.start);
    return start ? { start } : undefined;
}

/** Array methods whose receiver identity no callback or result exposes. */
const enclosedArrayMethods = new Set([
    "at",
    "concat",
    "fill",
    "includes",
    "indexOf",
    "join",
    "lastIndexOf",
    "pop",
    "push",
    "shift",
    "slice",
    "splice",
    "unshift",
]);

/**
 * Whether a reference to the array binding `symbol` lets another binding
 * hold the same array: anything but a `length`, element, enclosed method or
 * iteration read, or a store into the binding itself. A private member or a
 * local is read only in its declaring scope; anything else, program-wide.
 */
function identityEscapes(
    program: ts.Program,
    checker: ts.TypeChecker,
    symbol: ts.Symbol,
): boolean {
    let escapes = escapingIdentities.get(symbol);
    if (escapes === undefined) {
        escapes = walkIdentityEscapes(program, checker, symbol);
        escapingIdentities.set(symbol, escapes);
    }
    return escapes;
}

/** @unjournaled Pure functions of the checked source: each array binding's answer. */
const escapingIdentities = new WeakMap<ts.Symbol, boolean>();

/** {@link identityEscapes}, walking the scopes that may read the binding. */
function walkIdentityEscapes(
    program: ts.Program,
    checker: ts.TypeChecker,
    symbol: ts.Symbol,
): boolean {
    const declaration = symbol.valueDeclaration;
    if (
        !declaration ||
        !(
            ts.isPropertyDeclaration(declaration) ||
            ts.isVariableDeclaration(declaration)
        ) ||
        (declaration.initializer !== undefined &&
            !freshArray(declaration.initializer))
    )
        return true;
    const enclosedScope =
        (ts.isPropertyDeclaration(declaration) &&
            (ts.isPrivateIdentifier(declaration.name) ||
                ts.getCombinedModifierFlags(declaration) &
                    ts.ModifierFlags.Private)) ||
        ts.isVariableDeclaration(declaration);
    const scopes: readonly ts.Node[] = enclosedScope
        ? [declaration.getSourceFile()]
        : program
              .getSourceFiles()
              .filter(
                  (file) =>
                      !file.isDeclarationFile &&
                      declarationOrigin(file) === "program",
              );
    let escapes = false;
    const visit = (node: ts.Node): void => {
        if (escapes) return;
        if (
            (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) &&
            resolvedSymbol(checker, node) === symbol &&
            node !== declaration.name
        ) {
            const site = referenceSite(node);
            escapes = site !== undefined && !enclosedReference(site);
            return;
        }
        ts.forEachChild(node, visit);
    };
    for (const scope of scopes) visit(scope);
    return escapes;
}

/** A reference that reads or stores through the binding without sharing it. */
function enclosedReference(site: ts.Expression): boolean {
    const reference = outermostWrapper(site);
    const parent = reference.parent;
    if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === reference
    )
        return (
            parent.name.text === "length" ||
            (enclosedArrayMethods.has(parent.name.text) &&
                ts.isCallExpression(parent.parent) &&
                parent.parent.expression === parent)
        );
    const write = writeSiteOf(reference);
    return (
        (ts.isElementAccessExpression(parent) &&
            parent.expression === reference) ||
        (ts.isForOfStatement(parent) && parent.expression === reference) ||
        ts.isSpreadElement(parent) ||
        (write?.kind === "assign" && freshArray(write.stored))
    );
}

/** An array literal: an array no other binding holds yet. */
function freshArray(node: ts.Expression | undefined): boolean {
    return (
        node !== undefined &&
        ts.isArrayLiteralExpression(unwrapExpression(node))
    );
}

/** `this.p`, `a.b` or `a`: a path whose last name resolves to one symbol. */
function stablePathSymbol(
    checker: ts.TypeChecker,
    node: ts.Expression,
): ts.Symbol | undefined {
    if (ts.isIdentifier(node)) return resolvedSymbol(checker, node);
    if (
        ts.isPropertyAccessExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ThisKeyword ||
            stablePathSymbol(checker, unwrapExpression(node.expression)))
    )
        return resolvedSymbol(checker, node);
    return undefined;
}

/** A `const` or never-assigned parameter binding `node` names. */
function constantBindingSymbol(
    checker: ts.TypeChecker,
    node: ts.Expression,
): ts.Symbol | undefined {
    if (!ts.isIdentifier(node)) return undefined;
    const symbol = resolvedSymbol(checker, node);
    const declaration = symbol?.valueDeclaration;
    if (
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        ts.isVariableDeclarationList(declaration.parent) &&
        variableKind(declaration.parent) === "const"
    )
        return symbol;
    return undefined;
}

function numericLiteral(node: ts.Expression): ts.Expression | undefined {
    return ts.isNumericLiteral(node) ? node : undefined;
}

/** `for (let i = start; i < length; i++ | ++i | i += 1)` over `lengthSymbol`. */
function loopCounter(
    checker: ts.TypeChecker,
    loop: ts.ForStatement,
    lengthSymbol: ts.Symbol,
): { symbol: ts.Symbol; start: ts.Expression } | undefined {
    const shape = countedLoopShape(loop, (identifier) =>
        resolvedSymbol(checker, identifier),
    );
    const condition = shape?.condition;
    if (
        !shape ||
        !condition ||
        condition.mirrored ||
        condition.operator !== "<" ||
        resolvedSymbol(checker, unwrapExpression(condition.bound)) !==
            lengthSymbol ||
        !stepsUpByOne(shape) ||
        counterWrite(checker, shape.symbol, loop.statement) !== undefined
    )
        return undefined;
    return { symbol: shape.symbol, start: unwrapExpression(shape.start) };
}

/**
 * Whether `node`, a statement of `loop`'s body, can leave the loop other
 * than by finishing or throwing, or suspend inside it: a `return`, `await`,
 * `yield`, a `break` out of `node`, or a `continue` past `loop`. Nested
 * functions and classes are other activations.
 */
function exitsLoop(node: ts.Node, loop: ts.IterationStatement): boolean {
    return someAnalysisNode(
        node,
        (child) =>
            ts.isClassLike(child)
                ? "skip"
                : ts.isReturnStatement(child) ||
                  isSuspensionPoint(child, { yield: true }) ||
                  (ts.isBreakStatement(child) &&
                      !isDeclaredInside(jumpBinding(child) ?? loop, node)) ||
                  (ts.isContinueStatement(child) &&
                      !isDeclaredInside(jumpBinding(child) ?? loop, node) &&
                      !jumpsTo(child, loop)),
        { functions: "skip" },
    );
}

/**
 * Whether code reaches a name of `target`: directly, or through the bodies
 * a call, construction or accessor runs (EvaluationOrder: overrides,
 * construction chains and field initializers included). Code it cannot
 * follow reaches anything.
 */
class ReachedReferences {
    /** @unjournaled One proof's walk, over the program alone. */
    private readonly visited = new Set<ts.Node>();

    public constructor(
        private readonly order: EvaluationOrder,
        private readonly checker: ts.TypeChecker,
        private readonly target: ts.Symbol,
    ) {}

    public names(node: ts.Node): boolean {
        return someAnalysisNode(node, (child) => {
            if (ts.isIdentifier(child) || ts.isPrivateIdentifier(child))
                return resolvedSymbol(this.checker, child) === this.target;
            if (ts.isCallExpression(child) || ts.isNewExpression(child)) {
                const units = this.order.callUnits(child);
                if (units === undefined) return true;
                if (units !== "library" && units.some(this.bodyReaches))
                    return true;
            } else if (ts.isTaggedTemplateExpression(child)) return true;
            else if (
                ts.isPropertyAccessExpression(child) ||
                ts.isElementAccessExpression(child)
            ) {
                const getters = this.order.accessorUnits(child, "get");
                if (getters === undefined || getters.some(this.bodyReaches))
                    return true;
            }
            return false;
        });
    }

    private readonly bodyReaches = (node: ts.Node): boolean => {
        if (this.visited.has(node)) return false;
        this.visited.add(node);
        return this.names(node);
    };
}

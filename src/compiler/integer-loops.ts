import ts from "typescript";
import {
    findAnalysisNodeWithState,
    someAnalysisNode,
} from "./analysis-walk.js";
import type { CompilerSymbols } from "./symbols.js";
import type { Value } from "./types.js";
import { isUpdateExpression } from "./syntax.js";
import {
    staticNumberValue,
    type PositiveIntegerContext,
} from "./option-helpers.js";
import { writesThroughTrackedRoot } from "./user-functions.js";

interface IntegerLoopContext extends PositiveIntegerContext {
    readonly checker: ts.TypeChecker;
    readonly symbols: CompilerSymbols;
    unwrap(expression: ts.Expression): ts.Expression;
}

/** A `for` counter the emitter declares as a native 64-bit integer. */
interface IntegerLoopCounter {
    readonly binding: ts.Identifier;
    readonly start: number;
    /** The signed amount the incrementor adds. */
    readonly step: number;
    /** `i < K`-shaped conditions against a generation-known integer. */
    readonly bound?: { readonly operator: string; readonly value: number };
}

// Bounds keep every value the counter can take within 2^53, where the
// integer converts to the JavaScript number exactly, for more than 2^44
// iterations -- beyond what a run performs.
const maximumStart = 2 ** 31;
const maximumStep = 2 ** 8;

const comparisons = new Map<ts.SyntaxKind, string>([
    [ts.SyntaxKind.LessThanToken, "<"],
    [ts.SyntaxKind.LessThanEqualsToken, "<="],
    [ts.SyntaxKind.GreaterThanToken, ">"],
    [ts.SyntaxKind.GreaterThanEqualsToken, ">="],
]);

/**
 * The counter of `for (let i = <integer>; <condition>; <step>)` when it can
 * count natively: the step is `i++`, `++i`, `i--`, `--i`, `i += <integer>`
 * or `i -= <integer>`, nothing else writes `i`, no function in the loop
 * refers to it (a closure would capture a per-iteration JavaScript number)
 * and no `await` or `yield` splits the loop. Reads convert the counter to a
 * number at each use.
 */
export function integerLoopCounter(
    context: IntegerLoopContext,
    statement: ts.ForStatement,
): IntegerLoopCounter | undefined {
    const list = statement.initializer;
    if (
        list === undefined ||
        !ts.isVariableDeclarationList(list) ||
        (list.flags & ts.NodeFlags.Let) === 0 ||
        (list.flags & ts.NodeFlags.Const) !== 0 ||
        list.declarations.length !== 1
    ) {
        return undefined;
    }
    const declaration = list.declarations[0]!;
    if (
        !ts.isIdentifier(declaration.name) ||
        declaration.initializer === undefined ||
        (context.checker.getTypeAtLocation(declaration.name).flags &
            (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) ===
            0
    ) {
        return undefined;
    }
    const start = staticInteger(context, declaration.initializer);
    const symbol = context.symbols.valueSymbol(declaration.name);
    if (
        start === undefined ||
        Math.abs(start) > maximumStart ||
        symbol === undefined ||
        statement.incrementor === undefined
    ) {
        return undefined;
    }
    const names = (node: ts.Node): boolean =>
        ts.isIdentifier(node) && context.symbols.valueSymbol(node) === symbol;
    const step = counterStep(context, statement.incrementor, names);
    if (step === undefined) return undefined;
    const regions = [statement.condition, statement.statement].filter(
        (node): node is ts.Expression | ts.Statement => node !== undefined,
    );
    const disqualified = regions.some(
        (region) =>
            someAnalysisNode(
                region,
                (node) =>
                    ts.isAwaitExpression(node) ||
                    ts.isYieldExpression(node) ||
                    writesThroughTrackedRoot(node, names),
                { functions: "skip" },
            ) ||
            findAnalysisNodeWithState(
                region,
                false,
                (node, inFunction) => inFunction && names(node),
                (node, inFunction) => inFunction || ts.isFunctionLike(node),
            ) !== undefined,
    );
    if (disqualified) return undefined;
    const bound = statement.condition
        ? integerBound(context, statement.condition, names)
        : undefined;
    return {
        binding: declaration.name,
        start,
        step,
        ...(bound ? { bound } : {}),
    };
}

/** A counter read as the JavaScript number it holds. */
export function integerCounterRead(cppName: string): string {
    return `static_cast<double>(${cppName})`;
}

/**
 * The native counter a value reads. A value stored under its own name (a
 * materialized parameter, a local initialized from the counter) drops the
 * metadata where it is stored.
 */
export function integerCounterOf(value: Value | undefined): string | undefined {
    return value?.integerCounterCpp;
}

/** The condition compared natively, when it tests the counter against an integer. */
export function integerLoopConditionCpp(
    counter: IntegerLoopCounter,
    cppName: string,
): string | undefined {
    return counter.bound
        ? `${cppName} ${counter.bound.operator} ${counter.bound.value}`
        : undefined;
}

/** The native statement that advances the counter, without its semicolon. */
export function integerLoopStepCpp(
    counter: IntegerLoopCounter,
    cppName: string,
): string {
    if (counter.step === 1) return `++${cppName}`;
    if (counter.step === -1) return `--${cppName}`;
    return counter.step > 0
        ? `${cppName} += ${counter.step}`
        : `${cppName} -= ${-counter.step}`;
}

function counterStep(
    context: IntegerLoopContext,
    incrementor: ts.Expression,
    names: (node: ts.Node) => boolean,
): number | undefined {
    const expression = context.unwrap(incrementor);
    if (
        isUpdateExpression(expression) &&
        names(context.unwrap(expression.operand))
    )
        return expression.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1;
    if (
        !ts.isBinaryExpression(expression) ||
        !names(context.unwrap(expression.left))
    ) {
        return undefined;
    }
    const amount = staticInteger(context, expression.right);
    if (amount === undefined || amount === 0 || Math.abs(amount) > maximumStep)
        return undefined;
    if (expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
        return amount;
    if (expression.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken)
        return -amount;
    return undefined;
}

/** `i < K` (or `K > i`, and the other orderings) against a static integer. */
function integerBound(
    context: IntegerLoopContext,
    condition: ts.Expression,
    names: (node: ts.Node) => boolean,
): IntegerLoopCounter["bound"] {
    const comparison = context.unwrap(condition);
    if (!ts.isBinaryExpression(comparison)) return undefined;
    const operator = comparisons.get(comparison.operatorToken.kind);
    if (!operator) return undefined;
    if (names(context.unwrap(comparison.left))) {
        const value = staticInteger(context, comparison.right);
        return value === undefined ? undefined : { operator, value };
    }
    if (!names(context.unwrap(comparison.right))) return undefined;
    const value = staticInteger(context, comparison.left);
    const mirrored = operator.startsWith("<")
        ? operator.replace("<", ">")
        : operator.replace(">", "<");
    return value === undefined ? undefined : { operator: mirrored, value };
}

/**
 * A generation-known safe integer (never -0), folded from literals and
 * `const` bindings only: a `let` or `var` can change before the loop runs.
 */
function staticInteger(
    context: IntegerLoopContext,
    expression: ts.Expression,
): number | undefined {
    const reassignable = someAnalysisNode(expression, (node) => {
        if (!ts.isIdentifier(node)) return false;
        const declaration = context.symbols.valueSymbol(node)?.valueDeclaration;
        return (
            declaration !== undefined &&
            ts.isVariableDeclaration(declaration) &&
            ts.isVariableDeclarationList(declaration.parent) &&
            (declaration.parent.flags & ts.NodeFlags.Const) === 0
        );
    });
    if (reassignable) return undefined;
    const value = staticNumberValue(context, expression);
    return value !== undefined &&
        Number.isSafeInteger(value) &&
        !Object.is(value, -0)
        ? value
        : undefined;
}

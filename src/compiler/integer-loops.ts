import ts from "typescript";
import {
    countedLoopShape,
    counterWrite,
    type CountedLoopShape,
} from "./counted-loops.js";
import {
    findAnalysisNodeWithState,
    someAnalysisNode,
} from "./analysis-walk.js";
import type { CompilerSymbols } from "./symbols.js";
import type { Value } from "./types.js";
import { isSuspensionPoint, variableKind } from "./syntax.js";
import {
    staticNumberValue,
    type PositiveIntegerContext,
} from "./option-helpers.js";

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
    const shape = countedLoopShape(statement, (identifier) =>
        context.symbols.valueSymbol(identifier),
    );
    if (
        !shape ||
        shape.keyword !== "let" ||
        (context.checker.getTypeAtLocation(shape.binding).flags &
            (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) ===
            0
    ) {
        return undefined;
    }
    const start = staticInteger(context, shape.start);
    if (start === undefined || Math.abs(start) > maximumStart) return undefined;
    const symbol = shape.symbol;
    const names = (node: ts.Node): boolean =>
        ts.isIdentifier(node) && context.symbols.valueSymbol(node) === symbol;
    const step = counterStep(context, shape.step);
    if (step === undefined) return undefined;
    const regions = [statement.condition, statement.statement].filter(
        (node): node is ts.Expression | ts.Statement => node !== undefined,
    );
    const disqualified = regions.some(
        (region) =>
            counterWrite(context.checker, symbol, region) !== undefined ||
            someAnalysisNode(
                region,
                (node) => isSuspensionPoint(node, { yield: true }),
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
    const bound = integerBound(context, shape.condition);
    return {
        binding: shape.binding,
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
    step: CountedLoopShape["step"],
): number | undefined {
    if (!step) return undefined;
    if (step.amount === undefined) return step.sign;
    const amount = staticInteger(context, step.amount);
    if (amount === undefined || amount === 0 || Math.abs(amount) > maximumStep)
        return undefined;
    return step.sign * amount;
}

/** `i < K` (or `K > i`, and the other orderings) against a static integer. */
function integerBound(
    context: IntegerLoopContext,
    condition: CountedLoopShape["condition"],
): IntegerLoopCounter["bound"] {
    if (!condition) return undefined;
    const value = staticInteger(context, condition.bound);
    return value === undefined
        ? undefined
        : { operator: condition.operator, value };
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
            variableKind(declaration.parent) !== "const"
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

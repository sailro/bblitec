/**
 * JavaScript's operators and `Math` calls: what they fold to at generation
 * and what they lower to in C++.
 *
 * Scene code (the static evaluator, the `Math` table, the option readers)
 * and pinned bodies (the numeric translator, the partial evaluator, the UBO
 * writers, the constant readers) are the same language. Keeping the folds
 * and spellings here means an operator one of them learns is an operator
 * all of them know, with one meaning: a fold is the host engine's own
 * evaluation, and a spelling carries the specified semantics (`ToInt32`
 * and the five-bit shift count) rather than whatever the nearest C++
 * operator does.
 *
 * What is deliberately *not* here is `||`. Its meaning depends on what the
 * pinned expression is doing with it: a boolean guard lowers to C++'s `||`,
 * while JavaScript's numeric `||` — an extent of zero falling through to the
 * next — needs `bbl::js::or_number`. Each caller knows which it is reading.
 */
import ts from "typescript";

/**
 * A binary operator over two numbers, folded the way JavaScript evaluates
 * it — the shifts and masks take `ToInt32` of both sides and the shift
 * count modulo 32 because the host engine does exactly that. Undefined for
 * an operator that is not numeric.
 */
export function foldNumericBinary(
    kind: ts.SyntaxKind,
    left: number,
    right: number,
): number | undefined {
    switch (kind) {
        case ts.SyntaxKind.PlusToken:
            return left + right;
        case ts.SyntaxKind.MinusToken:
            return left - right;
        case ts.SyntaxKind.AsteriskToken:
            return left * right;
        case ts.SyntaxKind.SlashToken:
            return left / right;
        case ts.SyntaxKind.PercentToken:
            return left % right;
        case ts.SyntaxKind.AsteriskAsteriskToken:
            return left ** right;
        case ts.SyntaxKind.LessThanLessThanToken:
            return left << right;
        case ts.SyntaxKind.GreaterThanGreaterThanToken:
            return left >> right;
        case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
            return left >>> right;
        case ts.SyntaxKind.AmpersandToken:
            return left & right;
        case ts.SyntaxKind.BarToken:
            return left | right;
        case ts.SyntaxKind.CaretToken:
            return left ^ right;
        default:
            return undefined;
    }
}

/**
 * A comparison of two numbers, folded. Over numbers the loose and strict
 * equalities agree, so both spellings fold alike.
 */
export function foldNumericComparison(
    kind: ts.SyntaxKind,
    left: number,
    right: number,
): boolean | undefined {
    switch (kind) {
        case ts.SyntaxKind.LessThanToken:
            return left < right;
        case ts.SyntaxKind.LessThanEqualsToken:
            return left <= right;
        case ts.SyntaxKind.GreaterThanToken:
            return left > right;
        case ts.SyntaxKind.GreaterThanEqualsToken:
            return left >= right;
        case ts.SyntaxKind.EqualsEqualsEqualsToken:
        case ts.SyntaxKind.EqualsEqualsToken:
            return left === right;
        case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        case ts.SyntaxKind.ExclamationEqualsToken:
            return left !== right;
        default:
            return undefined;
    }
}

/** A prefix `-`, `+` or `~` over a number, folded. */
export function foldNumericUnary(
    operator: ts.PrefixUnaryOperator,
    operand: number,
): number | undefined {
    switch (operator) {
        case ts.SyntaxKind.MinusToken:
            return -operand;
        case ts.SyntaxKind.PlusToken:
            return +operand;
        case ts.SyntaxKind.TildeToken:
            return ~operand;
        default:
            return undefined;
    }
}

/**
 * The `bbl::js` helper each bitwise operator lowers to. JavaScript coerces
 * both sides through `ToInt32` (`ToUint32` for `>>>`) and masks a shift
 * count to five bits; a bare C++ cast of a double outside int32 range, or a
 * shift by 32 or more, is undefined behaviour rather than that.
 */
export const JS_BITWISE_FUNCTIONS: ReadonlyMap<ts.SyntaxKind, string> = new Map<
    ts.SyntaxKind,
    string
>([
    [ts.SyntaxKind.AmpersandToken, "bitwise_and"],
    [ts.SyntaxKind.BarToken, "bitwise_or"],
    [ts.SyntaxKind.CaretToken, "bitwise_xor"],
    [ts.SyntaxKind.LessThanLessThanToken, "shift_left"],
    [ts.SyntaxKind.GreaterThanGreaterThanToken, "shift_right"],
    [
        ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
        "shift_right_unsigned",
    ],
]);

/**
 * The compound bitwise assignments, each by the binary operator it applies:
 * `v |= w` stores `v | w`, whose `ToInt32` result is a number again.
 */
export const PINNED_BITWISE_ASSIGNMENT_OPERATORS: ReadonlyMap<
    ts.SyntaxKind,
    ts.SyntaxKind
> = new Map<ts.SyntaxKind, ts.SyntaxKind>([
    [ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.AmpersandToken],
    [ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.BarToken],
    [ts.SyntaxKind.CaretEqualsToken, ts.SyntaxKind.CaretToken],
    [
        ts.SyntaxKind.LessThanLessThanEqualsToken,
        ts.SyntaxKind.LessThanLessThanToken,
    ],
    [
        ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
        ts.SyntaxKind.GreaterThanGreaterThanToken,
    ],
    [
        ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
        ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
    ],
]);

/** `~operand`: JavaScript's ToInt32 complement, the `bbl::js` helper. */
export function jsBitwiseNotCall(operand: string): string {
    return `bbl::js::bitwise_not(${operand})`;
}

/** A bitwise operator as its `bbl::js` call, or undefined for another kind. */
export function jsBitwiseCall(
    kind: ts.SyntaxKind,
    left: string,
    right: string,
): string | undefined {
    const helper = JS_BITWISE_FUNCTIONS.get(kind);
    return helper ? `bbl::js::${helper}(${left}, ${right})` : undefined;
}

/** The operators that mean in C++ exactly what they mean in TypeScript. */
export const PINNED_ARITHMETIC_OPERATORS: ReadonlyMap<ts.SyntaxKind, string> =
    new Map<ts.SyntaxKind, string>([
        [ts.SyntaxKind.PlusToken, "+"],
        [ts.SyntaxKind.MinusToken, "-"],
        [ts.SyntaxKind.AsteriskToken, "*"],
        [ts.SyntaxKind.SlashToken, "/"],
    ]);

/**
 * The assignment forms a pinned body states: `=` plus the compound
 * operators, each meaning in C++ exactly what it means in TypeScript over
 * the scalars these lowerers emit.
 */
export const PINNED_ASSIGNMENT_OPERATORS: ReadonlyMap<ts.SyntaxKind, string> =
    new Map<ts.SyntaxKind, string>([
        [ts.SyntaxKind.EqualsToken, "="],
        [ts.SyntaxKind.PlusEqualsToken, "+="],
        [ts.SyntaxKind.MinusEqualsToken, "-="],
        [ts.SyntaxKind.AsteriskEqualsToken, "*="],
        [ts.SyntaxKind.SlashEqualsToken, "/="],
    ]);

/** The four orderings, each meaning in C++ what it means over two numbers. */
export const PINNED_RELATIONAL_OPERATORS: ReadonlyMap<ts.SyntaxKind, string> =
    new Map<ts.SyntaxKind, string>([
        [ts.SyntaxKind.LessThanToken, "<"],
        [ts.SyntaxKind.LessThanEqualsToken, "<="],
        [ts.SyntaxKind.GreaterThanToken, ">"],
        [ts.SyntaxKind.GreaterThanEqualsToken, ">="],
    ]);

/**
 * The orderings plus the equalities. `==` covers both `==` and `===`, and
 * `!=` both `!=` and `!==`: every operand a pinned body compares has
 * already lowered to a native scalar, so the strict and loose forms are one
 * operator by the time they reach C++.
 */
export const PINNED_COMPARISON_OPERATORS: ReadonlyMap<ts.SyntaxKind, string> =
    new Map<ts.SyntaxKind, string>([
        ...PINNED_RELATIONAL_OPERATORS,
        [ts.SyntaxKind.EqualsEqualsEqualsToken, "=="],
        [ts.SyntaxKind.EqualsEqualsToken, "=="],
        [ts.SyntaxKind.ExclamationEqualsEqualsToken, "!="],
        [ts.SyntaxKind.ExclamationEqualsToken, "!="],
    ]);

/**
 * The arithmetic set plus the comparisons and boolean joins a writer guards
 * with.
 */
export const PINNED_BOOLEAN_OPERATORS: ReadonlyMap<ts.SyntaxKind, string> =
    new Map<ts.SyntaxKind, string>([
        ...PINNED_ARITHMETIC_OPERATORS,
        [ts.SyntaxKind.AmpersandAmpersandToken, "&&"],
        [ts.SyntaxKind.BarBarToken, "||"],
        ...PINNED_COMPARISON_OPERATORS,
    ]);

/**
 * JavaScript's `%`, which is the floating-point remainder over numbers.
 * C++'s `%` is integer modulo, so the operator has no infix row above and
 * every lowering that reaches it spells `std::fmod` through this.
 */
export function pinnedRemainderCall(left: string, right: string): string {
    return `std::fmod(${left}, ${right})`;
}

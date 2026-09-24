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

/** A bitwise operator as its `bbl::js` call, or undefined for another kind. */
export function jsBitwiseCall(
    kind: ts.SyntaxKind,
    left: string,
    right: string,
): string | undefined {
    const helper = JS_BITWISE_FUNCTIONS.get(kind);
    return helper ? `bbl::js::${helper}(${left}, ${right})` : undefined;
}

/**
 * `Math.max`/`Math.min` over a numeric range, as JavaScript defines them: a
 * NaN operand poisons the result and `-0` orders below `+0`, neither of
 * which `std::max`/`std::min` does. `source` is a range of doubles, or a
 * braced argument list (`mathExtremeCall`).
 */
export function mathExtremeCpp(method: string, source: string): string {
    return `bbl::js::math_extreme<${method === "max"}>(${source})`;
}

/**
 * `Math.max`/`Math.min` over a call's own arguments, at any arity: the one
 * spelling scene code and pinned bodies share. The braced list evaluates
 * left to right, as JavaScript's argument list does, and every operand,
 * whatever its native type, converts to JavaScript's own width first.
 */
export function mathExtremeCall(
    method: "max" | "min",
    args: readonly string[],
): string {
    return mathExtremeCpp(method, `{${args.join(", ")}}`);
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

/**
 * The `Math` members that are a `<cmath>` call of the same arity. Every one of
 * these takes and returns a double, which is what a pinned writer computes in
 * before it stores. `Math.max`/`Math.min` are not among them: they are
 * variadic, and JavaScript's NaN and signed-zero rules are not `std::max`'s,
 * so they lower through `mathExtremeCall`.
 */
const PINNED_MATH_FUNCTIONS: Readonly<Record<string, string>> = {
    pow: "std::pow",
    log: "std::log",
    cos: "std::cos",
    acos: "std::acos",
    asin: "std::asin",
    atan2: "std::atan2",
    sin: "std::sin",
    tan: "std::tan",
    sqrt: "std::sqrt",
    abs: "std::abs",
    log2: "std::log2",
    ceil: "std::ceil",
    floor: "std::floor",
};

/**
 * The spelling the shared table gives one member, for a consumer outside
 * the pinned-body layer that must agree with it — the scene-code compiler's
 * `Math` dispatch reads the members both layers accept through this, so the
 * two layers cannot drift on what a shared `<cmath>` member lowers to. A
 * member the table does not carry throws, which is what keeps the shared
 * list the single authority instead of a fallback.
 */
export function pinnedMathSpelling(name: string): string {
    const spelling = PINNED_MATH_FUNCTIONS[name];
    if (!spelling) {
        throw new Error(
            `Math.${name} is not in the shared pinned cmath table.`,
        );
    }
    return spelling;
}

/**
 * Math calls for numeric scopes: the `<cmath>` members one to one, and
 * `Math.max`/`Math.min` at any arity with JavaScript's NaN and signed-zero
 * rules through `mathExtremeCall`, all at JavaScript's width. Their spelling
 * lives in `bblite/js_data.hpp`, which every unit a pinned numeric scope
 * lands in includes. Math.round and Math.hypot are supplied by their
 * dedicated helpers.
 */
export function pinnedNumericMathCalls(): Map<
    string,
    (args: readonly string[]) => string
> {
    const calls = new Map(
        Object.entries(PINNED_MATH_FUNCTIONS).map(
            ([name, spelling]): [
                string,
                (args: readonly string[]) => string,
            ] => [`Math.${name}`, (args) => `${spelling}(${args.join(", ")})`],
        ),
    );
    for (const method of ["max", "min"] as const) {
        calls.set(`Math.${method}`, (args) => mathExtremeCall(method, args));
    }
    return calls;
}

/**
 * The same map, plus `Math.hypot` as the pin's own variadic helper.
 *
 * `<cmath>`'s `hypot` is two- or three-argument and rounds differently from
 * JavaScript's, so a lowering that reaches `Math.hypot` at all must spell it
 * as `bbl::js::hypot_js`, which takes the whole list. Every caller that
 * lowers a pinned body doing vector length or normalization needs exactly
 * this pair, so the reason lives here rather than beside each `new Map`.
 */
export function pinnedNumericMathCallsWithHypot(): Map<
    string,
    (args: readonly string[]) => string
> {
    const calls = pinnedNumericMathCalls();
    calls.set("Math.hypot", pinnedHypotCall);
    return calls;
}

/**
 * `Math.hypot` at any arity, as the one spelling both layers use.
 *
 * Scene code reaches it through the compiler's own `Math` dispatch and a
 * pinned body through the map above; spelling it once here is what keeps
 * the two from drifting, the way `pinnedMathSpelling` does for the plain
 * `<cmath>` members.
 */
export function pinnedHypotCall(args: readonly string[]): string {
    return `bbl::js::hypot_js({${args.join(", ")}})`;
}

/**
 * `Math.round` as the pin's own half-up rounding rather than `<cmath>`'s
 * half-away-from-zero, spelled once for every lowering that reaches it.
 */
export function pinnedRoundCall(args: readonly string[]): string {
    return `bbl::js::round_js(${args.join(", ")})`;
}

/**
 * A `Math.x(...)` call the numeric scopes' shared map lowers -- a `<cmath>`
 * member or `Math.max`/`Math.min` -- or undefined when the node is not one.
 */
export function pinnedMathCall(node: ts.Node): ts.CallExpression | undefined {
    if (
        !ts.isCallExpression(node) ||
        !ts.isPropertyAccessExpression(node.expression) ||
        !ts.isIdentifier(node.expression.expression) ||
        node.expression.expression.text !== "Math"
    ) {
        return undefined;
    }
    const name = node.expression.name.text;
    return name === "max" || name === "min" || PINNED_MATH_FUNCTIONS[name]
        ? node
        : undefined;
}

/**
 * What scene code's `Math` reaches: every member the compiler lowers with
 * its runtime spelling, its generation-time fold where one is exact, and
 * the constants a numeric reader folds or spells.
 *
 * The `<cmath>` members shared with the pinned layer are spelled through
 * `pinnedMathSpelling`, so the two layers cannot drift on them; the
 * compiler-only members follow the same `std::` rule here because no pinned
 * body reaches them. Members whose semantics differ from `<cmath>`
 * (`Math.round`'s tie rule, `Math.hypot`'s arity, `Math.sign`, `Math.imul`,
 * the seeded `Math.random`) carry the PAL spelling that implements the
 * spec's own rule, and say which runtime that spelling needs.
 *
 * `Math.max`/`Math.min` are deliberately absent: they are n-ary, fold only
 * when every operand is a finite static number, and lower a spread over a
 * numeric container as a loop, so `DataLowerer.compileMathCall` owns them
 * as one arm rather than this table pretending they are one call.
 */
import ts from "typescript";
import {
    pinnedHypotCall,
    pinnedMathSpelling,
    pinnedRoundCall,
} from "../lowering/pinned-operators.js";

export interface MathMember {
    /** How many arguments the member takes, or the minimum for a variadic one. */
    readonly arity: number;
    readonly variadic?: true;
    /** The C++ call over doubles. */
    readonly cpp: (args: readonly string[]) => string;
    /**
     * The exact generation-time fold. Only the integer-valued members carry
     * one: their result is exact in both engines, so the folded value and
     * the emitted call agree, and a scene that hands one to generation-time
     * state (a particle column) needs the value rather than the expression.
     * The transcendental members deliberately do NOT fold: V8 and a native
     * maths library need not agree on them.
     */
    readonly fold?: (value: number) => number;
    /** The runtime the spelling needs beyond `<cmath>`. */
    readonly reach?: "js-data" | "js-random";
    /** Whether two calls may answer differently, so the value cannot be folded or hoisted. */
    readonly impure?: true;
}

/** A member shared with the pinned layer, spelled through its table. */
function shared(name: string): MathMember["cpp"] {
    const spelling = pinnedMathSpelling(name);
    return (args) => `${spelling}(${args.join(", ")})`;
}

/** A compiler-only member, following the same `std::` rule. */
function compilerOnly(name: string): MathMember["cpp"] {
    return (args) => `std::${name}(${args.join(", ")})`;
}

export const MATH_MEMBERS: ReadonlyMap<string, MathMember> = new Map<
    string,
    MathMember
>([
    ["abs", { arity: 1, cpp: shared("abs"), fold: Math.abs }],
    ["ceil", { arity: 1, cpp: shared("ceil"), fold: Math.ceil }],
    ["cos", { arity: 1, cpp: shared("cos") }],
    ["floor", { arity: 1, cpp: shared("floor"), fold: Math.floor }],
    ["sin", { arity: 1, cpp: shared("sin") }],
    ["sqrt", { arity: 1, cpp: shared("sqrt") }],
    ["tan", { arity: 1, cpp: shared("tan") }],
    ["atan", { arity: 1, cpp: compilerOnly("atan") }],
    ["exp", { arity: 1, cpp: compilerOnly("exp") }],
    ["trunc", { arity: 1, cpp: compilerOnly("trunc"), fold: Math.trunc }],
    ["pow", { arity: 2, cpp: shared("pow") }],
    ["atan2", { arity: 2, cpp: compilerOnly("atan2") }],
    // Not `std::round`: JavaScript rounds a tie toward +Infinity and C
    // rounds it away from zero, so the two disagree on every negative
    // half. `round_js` carries the spec's own rule.
    [
        "round",
        { arity: 1, cpp: pinnedRoundCall, fold: Math.round, reach: "js-data" },
    ],
    [
        "sign",
        {
            arity: 1,
            cpp: (args) => `bbl::js::math_sign(${args.join(", ")})`,
            reach: "js-data",
        },
    ],
    [
        "imul",
        {
            arity: 2,
            cpp: (args) => `bbl::js::math_imul(${args.join(", ")})`,
            reach: "js-data",
        },
    ],
    // Not `std::hypot`: it is two- or three-argument, so a quaternion
    // length has no spelling there at all, and it rounds differently from
    // JavaScript's besides. `hypot_js` is the whole-list root of the sum of
    // squares every pinned lowering already reaches through
    // `pinnedNumericMathCallsWithHypot`, and the one spelling `fidelity.md`
    // records as `splat-hypot-approximation` -- so scene code and pinned
    // code agree on it rather than this one call site being the exception.
    ["hypot", { arity: 2, variadic: true, cpp: pinnedHypotCall, reach: "js-data" }],
    [
        "random",
        {
            arity: 0,
            cpp: () => "bbl::js::random_js()",
            reach: "js-random",
            impure: true,
        },
    ],
]);

/** The exact fold of a one-argument member, where the table carries one. */
export function mathUnaryFold(
    name: string,
): ((value: number) => number) | undefined {
    const member = MATH_MEMBERS.get(name);
    return member?.arity === 1 ? member.fold : undefined;
}

/** How a member's arity reads in a refusal. */
export function describeMathArity(member: MathMember): string {
    const count =
        member.arity === 0
            ? "no arguments"
            : member.arity === 1
              ? "one argument"
              : "two arguments";
    return member.variadic ? `at least ${count}` : count;
}

export interface MathConstant {
    readonly value: number;
    /**
     * The single-precision spelling a float sink takes, where the runtime
     * has one: `bbl::pi`, and the two square roots as `<cmath>` calls over
     * float literals. A constant without one is read at double width and
     * narrowed by the sink like any other number.
     */
    readonly floatCpp?: string;
}

/** The `Math` constants a numeric reader folds, and how a float sink spells them. */
export const MATH_CONSTANTS: ReadonlyMap<string, MathConstant> = new Map<
    string,
    MathConstant
>([
    ["PI", { value: Math.PI, floatCpp: "bbl::pi" }],
    ["E", { value: Math.E }],
    ["SQRT2", { value: Math.SQRT2, floatCpp: "std::sqrt(2.0f)" }],
    ["SQRT1_2", { value: Math.SQRT1_2, floatCpp: "std::sqrt(0.5f)" }],
]);

/**
 * The transcendental members a reader evaluates only when JavaScript
 * immediately formats the result into generation-time source text
 * (`toFixed` over a folded angle). Ordinary numeric expressions keep these
 * native, so their runtime width and library semantics are unchanged.
 */
export const FORMATTED_MATH_FOLDS: ReadonlyMap<
    string,
    { readonly arity: number; readonly fold: (...args: number[]) => number }
> = new Map([
    ["atan2", { arity: 2, fold: Math.atan2 }],
    ["cos", { arity: 1, fold: Math.cos }],
    ["sin", { arity: 1, fold: Math.sin }],
]);

/**
 * `Math.<member>` where `Math` is the default library's object, or
 * undefined for any other property access -- a scene's own binding named
 * `Math` is not this, however it is spelled.
 */
export function mathMemberAccess(
    expression: ts.Expression,
    isDefaultLibraryIdentifier: (identifier: ts.Identifier) => boolean,
): ts.PropertyAccessExpression | undefined {
    return ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "Math" &&
        isDefaultLibraryIdentifier(expression.expression)
        ? expression
        : undefined;
}

/** A call of one such member, with the member's name. */
export function mathMemberCall(
    expression: ts.Expression,
    isDefaultLibraryIdentifier: (identifier: ts.Identifier) => boolean,
): { readonly name: string; readonly call: ts.CallExpression } | undefined {
    if (!ts.isCallExpression(expression)) return undefined;
    const access = mathMemberAccess(
        expression.expression,
        isDefaultLibraryIdentifier,
    );
    return access ? { name: access.name.text, call: expression } : undefined;
}

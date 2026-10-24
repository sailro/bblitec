/**
 * What `Math` reaches, in scene code and pinned bodies alike: every member
 * with its runtime spelling, its generation-time fold where one is exact,
 * and the constants a numeric reader folds or spells.
 *
 * The `<cmath>` members spell `std::<name>`. Members whose semantics differ
 * from `<cmath>` (`Math.round`'s tie rule, `Math.hypot`'s arity,
 * `Math.sign`, `Math.imul`, the seeded `Math.random`) carry the PAL
 * spelling that implements the spec's own rule, and say which runtime that
 * spelling needs.
 *
 * `Math.max`/`Math.min` are deliberately absent: they are n-ary and lower a
 * spread over a numeric container as a loop, so `DataLowerer.compileMathCall`
 * owns them as one arm rather than this table pretending they are one call.
 * That arm spells an argument list through `mathExtremeCall`, the spelling
 * pinned bodies lower `Math.max`/`Math.min` through too.
 */
import { EmissionMap } from "./emission-transaction.js";
import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import {
    namedMember,
    type LibraryGlobal,
    type MemberReader,
    type NamedMember,
} from "./symbols.js";
import type { Value } from "./types.js";
import type { DataType } from "./data-types.js";
import { nativeFunctionValue } from "./native-function-values.js";
import { exponentiationCall } from "../lowering/pinned-operators.js";

interface MathMember {
    /** How many arguments the member takes, or the minimum for a variadic one. */
    readonly arity: number;
    readonly variadic?: true;
    /**
     * The C++ call over doubles; `statics` holds the arguments generation
     * already knows (`Math.pow` spells `std::pow` under a finite exponent).
     */
    readonly cpp: (
        args: readonly string[],
        statics?: readonly (number | undefined)[],
    ) => string;
    /** A variadic member over an already evaluated numeric range. */
    readonly rangeCpp?: (range: string) => string;
    /**
     * The exact generation-time fold. Only the members whose result is
     * exact in both engines carry one (the integer-valued ones, sign,
     * imul), so the folded value and the emitted call agree, and a scene
     * that hands one to generation-time state (a particle column) needs the
     * value rather than the expression. The transcendental members, pow and
     * hypot deliberately do NOT fold: V8 and a native maths library need
     * not agree on them.
     */
    readonly fold?: (...values: number[]) => number;
    /** The runtime the spelling needs beyond `<cmath>`. */
    readonly reach?: "js-data" | "js-random";
    /** Whether two calls may answer differently, so the value cannot be folded or hoisted. */
    readonly impure?: true;
}

/** A `<cmath>` member of the same name and arity over doubles. */
function cmath(name: string): MathMember["cpp"] {
    return (args) => `std::${name}(${args.join(", ")})`;
}

/**
 * `Math.max`/`Math.min` over a numeric range, as JavaScript defines them: a
 * NaN operand poisons the result and `-0` orders below `+0`, neither of
 * which `std::max`/`std::min` does. `source` is a range of doubles, or a
 * braced argument list (`mathExtremeCall`).
 */
function mathExtremeCpp(method: string, source: string): string {
    return `bbl::js::math_extreme<${method === "max"}>(${source})`;
}

/**
 * `Math.max`/`Math.min` over a call's own arguments, at any arity: the one
 * spelling scene code and pinned bodies share. The braced list evaluates
 * left to right, as JavaScript's argument list does, and every operand,
 * whatever its native type, converts to JavaScript's own width first.
 */
function mathExtremeCall(
    method: "max" | "min",
    args: readonly string[],
): string {
    return mathExtremeCpp(method, `{${args.join(", ")}}`);
}

export const MATH_MEMBERS: ReadonlyMap<string, MathMember> = new EmissionMap<
    string,
    MathMember
>([
    ["abs", { arity: 1, cpp: cmath("abs"), fold: Math.abs }],
    ["ceil", { arity: 1, cpp: cmath("ceil"), fold: Math.ceil }],
    ["cos", { arity: 1, cpp: cmath("cos") }],
    ["floor", { arity: 1, cpp: cmath("floor"), fold: Math.floor }],
    ["sin", { arity: 1, cpp: cmath("sin") }],
    ["sqrt", { arity: 1, cpp: cmath("sqrt") }],
    ["tan", { arity: 1, cpp: cmath("tan") }],
    ["atan", { arity: 1, cpp: cmath("atan") }],
    ["acos", { arity: 1, cpp: cmath("acos") }],
    ["asin", { arity: 1, cpp: cmath("asin") }],
    ["log", { arity: 1, cpp: cmath("log") }],
    ["log2", { arity: 1, cpp: cmath("log2") }],
    ["log10", { arity: 1, cpp: cmath("log10") }],
    ["log1p", { arity: 1, cpp: cmath("log1p") }],
    ["expm1", { arity: 1, cpp: cmath("expm1") }],
    ["cbrt", { arity: 1, cpp: cmath("cbrt") }],
    ["sinh", { arity: 1, cpp: cmath("sinh") }],
    ["cosh", { arity: 1, cpp: cmath("cosh") }],
    ["tanh", { arity: 1, cpp: cmath("tanh") }],
    ["asinh", { arity: 1, cpp: cmath("asinh") }],
    ["acosh", { arity: 1, cpp: cmath("acosh") }],
    ["atanh", { arity: 1, cpp: cmath("atanh") }],
    [
        "fround",
        {
            arity: 1,
            cpp: (args) => `bbl::js::math_fround(${args.join(", ")})`,
            fold: Math.fround,
            reach: "js-data",
        },
    ],
    [
        "clz32",
        {
            arity: 1,
            cpp: (args) => `bbl::js::math_clz32(${args.join(", ")})`,
            fold: Math.clz32,
            reach: "js-data",
        },
    ],
    ["exp", { arity: 1, cpp: cmath("exp") }],
    ["trunc", { arity: 1, cpp: cmath("trunc"), fold: Math.trunc }],
    // JavaScript exponentiation, as `**` lowers (exponentiationCall).
    [
        "pow",
        {
            arity: 2,
            cpp: (args, statics) =>
                exponentiationCall(args[0]!, args[1]!, statics?.[1]).cpp,
        },
    ],
    ["atan2", { arity: 2, cpp: cmath("atan2") }],
    // Not `std::round`: JavaScript rounds a tie toward +Infinity and C
    // rounds it away from zero, so the two disagree on every negative
    // half. `round_js` carries the spec's own rule.
    [
        "round",
        {
            arity: 1,
            cpp: (args) => `bbl::js::round_js(${args.join(", ")})`,
            fold: Math.round,
            reach: "js-data",
        },
    ],
    [
        "sign",
        {
            arity: 1,
            cpp: (args) => `bbl::js::math_sign(${args.join(", ")})`,
            fold: Math.sign,
            reach: "js-data",
        },
    ],
    [
        "imul",
        {
            arity: 2,
            cpp: (args) => `bbl::js::math_imul(${args.join(", ")})`,
            fold: Math.imul,
            reach: "js-data",
        },
    ],
    // Not `std::hypot`: it is two- or three-argument, so a quaternion
    // length has no spelling there at all, and it rounds differently from
    // JavaScript's besides. `hypot_js` is the whole-list root of the sum of
    // squares every pinned lowering already reaches through
    // the shared numeric lowerer, and the one spelling `fidelity.md`
    // records as `splat-hypot-approximation` -- so scene code and pinned
    // code agree on it rather than this one call site being the exception.
    [
        "hypot",
        {
            arity: 0,
            variadic: true,
            cpp: (args) => `bbl::js::hypot_js({${args.join(", ")}})`,
            rangeCpp: (range) => `bbl::js::hypot_js(${range})`,
            reach: "js-data",
        },
    ],
    [
        "random",
        {
            arity: 0,
            cpp: () => "bbl::js::random_js()",
            reach: "js-random",
            impure: true,
        },
    ],
    ...(["max", "min"] as const).map((name): [string, MathMember] => [
        name,
        {
            arity: 0,
            variadic: true,
            cpp: (args) => mathExtremeCall(name, args),
            rangeCpp: (range) => mathExtremeCpp(name, range),
            fold: (...values: number[]) => Math[name](...values),
            reach: "js-data",
        },
    ]),
]);

/** Whether two calls of the member may answer differently (`Math.random`). */
export function mathMemberIsImpure(name: string): boolean {
    return MATH_MEMBERS.get(name)?.impure === true;
}

/**
 * The generation-time value of `Math.<name>(...values)`, or undefined when
 * the call must run: the one fold every reader shares. The table's exact
 * members fold; an approximated member folds only into generation-time
 * source text (`formatted`, see FORMATTED_MATH_FOLDS), and an impure one
 * (random) never does.
 */
export function foldMathCall(
    name: string,
    values: readonly number[],
    formatted = false,
): number | undefined {
    const member = MATH_MEMBERS.get(name);
    const fold =
        member?.fold ??
        (formatted ? FORMATTED_MATH_FOLDS.get(name) : undefined);
    return fold && member && mathArityAccepts(member, values.length)
        ? fold(...values)
        : undefined;
}

/** Whether a member takes `count` arguments ({@link describeMathArity}). */
export function mathArityAccepts(member: MathMember, count: number): boolean {
    return member.variadic ? count >= member.arity : count === member.arity;
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

interface MathConstant {
    readonly value: number;
    /**
     * The single-precision spelling a float sink takes, where the runtime
     * has one: `bbl::pi`, and the two square roots as `<cmath>` calls over
     * float literals. A constant without one is read at double width and
     * narrowed by the sink like any other number.
     */
    readonly floatCpp?: string;
}

/** Every `Math` constant: a numeric reader folds it, and a float sink spells it. */
export const MATH_CONSTANTS: ReadonlyMap<string, MathConstant> =
    new EmissionMap<string, MathConstant>([
        ["PI", { value: Math.PI, floatCpp: "bbl::pi" }],
        ["E", { value: Math.E }],
        ["LN2", { value: Math.LN2 }],
        ["LN10", { value: Math.LN10 }],
        ["LOG2E", { value: Math.LOG2E }],
        ["LOG10E", { value: Math.LOG10E }],
        ["SQRT2", { value: Math.SQRT2, floatCpp: "std::sqrt(2.0f)" }],
        ["SQRT1_2", { value: Math.SQRT1_2, floatCpp: "std::sqrt(0.5f)" }],
    ]);

/** `Math.<constant>` where `Math` is the library's object, or undefined. */
export function mathConstantAccess(
    expression: ts.Expression,
    libraryGlobal: LibraryGlobal,
    member: MemberReader,
): MathConstant | undefined {
    const access = mathMemberAccess(expression, libraryGlobal, member);
    return access && MATH_CONSTANTS.get(access.name);
}

/**
 * The transcendental members a reader evaluates only when JavaScript
 * immediately formats the result into generation-time source text
 * (`toFixed` over a folded angle). Ordinary numeric expressions keep these
 * native, so their runtime width and library semantics are unchanged.
 */
const FORMATTED_MATH_FOLDS: ReadonlyMap<
    string,
    (...values: number[]) => number
> = new EmissionMap<string, (...values: number[]) => number>([
    ["atan2", Math.atan2],
    ["cos", Math.cos],
    ["sin", Math.sin],
]);

/**
 * `Math.<member>` where `Math` is the default library's object, or
 * undefined for any other property access -- a scene's own binding named
 * `Math` is not this, however it is spelled.
 */
export function mathMemberAccess(
    expression: ts.Node,
    libraryGlobal: LibraryGlobal,
    member: MemberReader,
): NamedMember | undefined {
    const access = member(expression);
    return access && libraryGlobal(access.expression) === "Math"
        ? access
        : undefined;
}

/** A call of one such member, with the member's name. */
export function mathMemberCall(
    expression: ts.Expression,
    libraryGlobal: LibraryGlobal,
    member: MemberReader,
): { readonly name: string; readonly call: ts.CallExpression } | undefined {
    if (!ts.isCallExpression(expression)) return undefined;
    const access = mathMemberAccess(
        expression.expression,
        libraryGlobal,
        member,
    );
    return access ? { name: access.name, call: expression } : undefined;
}

/** A call of a member the table spells, with its name. */
export function spelledMathCall(
    expression: ts.Expression,
    libraryGlobal: LibraryGlobal,
    member: MemberReader,
): ReturnType<typeof mathMemberCall> {
    const math = mathMemberCall(expression, libraryGlobal, member);
    return math && MATH_MEMBERS.has(math.name) ? math : undefined;
}

/** Math callbacks use the native numeric helpers and owned rest-array convention. */
export function mathFunctionValue(
    context: Pick<
        LoweringServices,
        | "checker"
        | "libraryGlobal"
        | "dataLowerer"
        | "dataTypes"
        | "callbackIdentity"
        | "reachJsData"
        | "reachJsRandom"
        | "fail"
    >,
    expression: ts.Expression,
): Value | undefined {
    const access = mathMemberAccess(
        expression,
        (candidate) => context.libraryGlobal(candidate),
        (node) => namedMember(context.checker, node),
    );
    if (!access) return undefined;
    const member = MATH_MEMBERS.get(access.name);
    if (!member) return undefined;
    const type: DataType<"function"> = {
        kind: "function",
        parameters: member.variadic
            ? [{ kind: "vector", element: { kind: "number" } }]
            : Array.from({ length: member.arity }, () => ({ kind: "number" })),
        ...(member.variadic ? { restParameter: 0 } : {}),
        result: { kind: "number" },
        identity: true,
    };
    const parameters = type.parameters.map((_, index) => `argument_${index}`);
    if (member.reach === "js-random") context.reachJsRandom();
    const body =
        member.variadic && member.rangeCpp
            ? member.rangeCpp("argument_0")
            : member.cpp(parameters);
    return nativeFunctionValue(context, access.access, type, `return ${body};`);
}

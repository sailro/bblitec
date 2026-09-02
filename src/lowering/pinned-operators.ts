/**
 * What a pinned expression's operators and `Math` calls lower to.
 *
 * The lowerers that read arithmetic out of pinned bodies — the material UBO
 * writers, the post-process uniform writers, and the glTF loader's expression
 * renderer — are all lowering the same language. Keeping the tables here means
 * an operator one of them learns is an operator all of them know, and means
 * none rebuilds a map per expression.
 *
 * What is deliberately *not* here is `||`. Its meaning depends on what the
 * pinned expression is doing with it: a boolean guard lowers to C++'s `||`,
 * while JavaScript's numeric `||` — an extent of zero falling through to the
 * next — needs `bbl::js::or_number`. Each caller knows which it is reading.
 */
import ts from "typescript";

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

/**
 * The arithmetic set plus the comparisons and boolean joins a writer guards
 * with. `==` covers both `==` and `===`: every operand a pinned writer
 * compares has already lowered to a native scalar, so the two are one operator
 * by the time they reach C++.
 */
export const PINNED_BOOLEAN_OPERATORS: ReadonlyMap<ts.SyntaxKind, string> =
    new Map<ts.SyntaxKind, string>([
        ...PINNED_ARITHMETIC_OPERATORS,
        [ts.SyntaxKind.AmpersandAmpersandToken, "&&"],
        [ts.SyntaxKind.BarBarToken, "||"],
        [ts.SyntaxKind.GreaterThanToken, ">"],
        [ts.SyntaxKind.LessThanToken, "<"],
        [ts.SyntaxKind.EqualsEqualsEqualsToken, "=="],
        [ts.SyntaxKind.EqualsEqualsToken, "=="],
    ]);

/**
 * The `Math` members that are a `<cmath>` call of the same arity. Every one of
 * these takes and returns a double, which is what a pinned writer computes in
 * before it stores.
 */
export const PINNED_MATH_FUNCTIONS: Readonly<Record<string, string>> = {
    pow: "std::pow",
    log: "std::log",
    max: "std::max",
    min: "std::min",
    cos: "std::cos",
    acos: "std::acos",
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
 * `PINNED_MATH_FUNCTIONS` as the spelling map `PinnedNumericLowerer` takes:
 * `Math.x` to its `<cmath>` call over doubles. `std::max`/`std::min` pin the
 * template argument, or a mixed-width call is ambiguous. Callers that need a
 * member with different semantics (`Math.round`, `Math.hypot`) layer it on
 * top of this map and say why.
 */
export function pinnedNumericMathCalls(): Map<
    string,
    (args: readonly string[]) => string
> {
    return new Map(
        Object.entries(PINNED_MATH_FUNCTIONS).map(
            ([name, spelling]): [
                string,
                (args: readonly string[]) => string,
            ] => [
                `Math.${name}`,
                name === "max" || name === "min"
                    ? (args) => `${spelling}<double>(${args.join(", ")})`
                    : (args) => `${spelling}(${args.join(", ")})`,
            ],
        ),
    );
}

/**
 * The `<cmath>` name a `Math.x(...)` call lowers to, or undefined when the
 * node is not such a call.
 */
export function pinnedMathCall(
    node: ts.Node,
): { native: string; call: ts.CallExpression } | undefined {
    if (
        !ts.isCallExpression(node) ||
        !ts.isPropertyAccessExpression(node.expression) ||
        !ts.isIdentifier(node.expression.expression) ||
        node.expression.expression.text !== "Math"
    ) {
        return undefined;
    }
    const native = PINNED_MATH_FUNCTIONS[node.expression.name.text];
    return native ? { native, call: node } : undefined;
}

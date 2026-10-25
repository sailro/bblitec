import ts from "typescript";
import { bindingRebinds } from "./binding-rebinds.js";
import {
    isDeclaredInside,
    isUpdateExpression,
    unwrapExpression,
    variableKind,
    type VariableKind,
    type WriteSite,
} from "./syntax.js";

/** A comparison of a loop counter against its bound, the counter on the left. */
export type LoopComparison = "<" | "<=" | ">" | ">=";

/**
 * `for (let i = start; i < bound; i++)` read as a counted loop's parts,
 * before any caller's policy: which starts, bounds and steps a caller
 * accepts (a literal start, a `.length` bound, an integer step) is its own.
 */
export interface CountedLoopShape {
    readonly binding: ts.Identifier;
    readonly symbol: ts.Symbol;
    readonly keyword: VariableKind | undefined;
    readonly start: ts.Expression;
    /** The condition with the counter on the left: `K > i` reads as `i < K`, mirrored. */
    readonly condition?: {
        readonly operator: LoopComparison;
        readonly bound: ts.Expression;
        readonly mirrored: boolean;
    };
    /** `i++` / `++i` step by +1, `i--` / `--i` by -1, `i += k` / `i -= k` by `amount`. */
    readonly step?: { readonly sign: 1 | -1; readonly amount?: ts.Expression };
}

/**
 * Whether a loop counts up by one: `i++`, `++i` or `i += 1`. `valueOf` reads
 * a step amount's number: its literal's, unless the caller folds more.
 */
export function stepsUpByOne(
    shape: CountedLoopShape,
    valueOf: (amount: ts.Expression) => number | undefined = (amount) =>
        ts.isNumericLiteral(amount) ? Number(amount.text) : undefined,
): boolean {
    const step = shape.step;
    return (
        step?.sign === 1 &&
        (step.amount === undefined || valueOf(step.amount) === 1)
    );
}

/**
 * The first write that rebinds the loop's counter inside `region` (`++`,
 * `+=`, a destructuring target, in a nested function too), if any: a local
 * `let` is written only where its scope reaches.
 */
export function counterWrite(
    checker: ts.TypeChecker,
    counter: ts.Symbol,
    region: ts.Node,
): WriteSite | undefined {
    return bindingRebinds(checker, [region.getSourceFile()], counter).find(
        ({ target }) => isDeclaredInside(target, region),
    );
}

const operators = new Map<ts.SyntaxKind, LoopComparison>([
    [ts.SyntaxKind.LessThanToken, "<"],
    [ts.SyntaxKind.LessThanEqualsToken, "<="],
    [ts.SyntaxKind.GreaterThanToken, ">"],
    [ts.SyntaxKind.GreaterThanEqualsToken, ">="],
]);

const mirror: Readonly<Record<LoopComparison, LoopComparison>> = {
    "<": ">",
    "<=": ">=",
    ">": "<",
    ">=": "<=",
};

/**
 * The counted shape of a `for` statement declaring one identifier with an
 * initializer, or undefined. `symbolOf` resolves the counter the caller's
 * way; a condition or step that does not name it is left out.
 */
export function countedLoopShape(
    loop: ts.ForStatement,
    symbolOf: (identifier: ts.Identifier) => ts.Symbol | undefined,
): CountedLoopShape | undefined {
    const list = loop.initializer;
    if (
        !list ||
        !ts.isVariableDeclarationList(list) ||
        list.declarations.length !== 1
    )
        return undefined;
    const declaration = list.declarations[0]!;
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
        return undefined;
    const symbol = symbolOf(declaration.name);
    if (!symbol) return undefined;
    const names = (expression: ts.Expression): boolean => {
        const node = unwrapExpression(expression);
        return ts.isIdentifier(node) && symbolOf(node) === symbol;
    };
    return {
        binding: declaration.name,
        symbol,
        keyword: variableKind(list),
        start: declaration.initializer,
        ...condition(loop.condition, names),
        ...step(loop.incrementor, names),
    };
}

function condition(
    expression: ts.Expression | undefined,
    names: (expression: ts.Expression) => boolean,
): Pick<CountedLoopShape, "condition"> {
    const comparison = expression && unwrapExpression(expression);
    if (!comparison || !ts.isBinaryExpression(comparison)) return {};
    const operator = operators.get(comparison.operatorToken.kind);
    if (!operator) return {};
    if (names(comparison.left))
        return {
            condition: { operator, bound: comparison.right, mirrored: false },
        };
    if (names(comparison.right))
        return {
            condition: {
                operator: mirror[operator],
                bound: comparison.left,
                mirrored: true,
            },
        };
    return {};
}

function step(
    incrementor: ts.Expression | undefined,
    names: (expression: ts.Expression) => boolean,
): Pick<CountedLoopShape, "step"> {
    const expression = incrementor && unwrapExpression(incrementor);
    if (!expression) return {};
    if (isUpdateExpression(expression) && names(expression.operand))
        return {
            step: {
                sign:
                    expression.operator === ts.SyntaxKind.PlusPlusToken
                        ? 1
                        : -1,
            },
        };
    if (!ts.isBinaryExpression(expression) || !names(expression.left))
        return {};
    if (expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
        return { step: { sign: 1, amount: expression.right } };
    if (expression.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken)
        return { step: { sign: -1, amount: expression.right } };
    return {};
}

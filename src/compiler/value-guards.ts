import ts from "typescript";
import { isRebound } from "./binding-rebinds.js";
import { libraryCallName, libraryGlobal, valueSymbolOf } from "./symbols.js";
import {
    equalityOperator,
    isOperandSelection,
    literalKey,
    operandYield,
    unwrapExpression,
    variableKind,
    type ValueClass,
} from "./syntax.js";

/**
 * Whether the assignment whose left side is `target` (`h[k] = v` or
 * `h.p = v`) cannot run while the slot it writes holds `current`: the
 * block holding the write first reads that slot into a `const`
 * (`const c = h[k]`, with `h` and `k` never rebound), and one `if` between
 * that read and the write tests `c` false for `current`. Another write
 * changing the slot in between is one a proof that the slot keeps
 * `current` counts on its own, so the read is the value the write tests.
 */
export function writeGuardRejects(
    checker: ts.TypeChecker,
    sourceFiles: readonly ts.SourceFile[],
    target: ts.Node,
    current: unknown,
): boolean {
    const assignment = target.parent;
    if (
        !ts.isBinaryExpression(assignment) ||
        assignment.left !== target ||
        assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
        !(
            ts.isElementAccessExpression(target) ||
            ts.isPropertyAccessExpression(target)
        )
    )
        return false;
    const holder = unwrapExpression(target.expression);
    const key = slotKey(checker, target);
    if (!ts.isIdentifier(holder) || key === undefined) return false;
    const holderSymbol = valueSymbolOf(checker, holder);
    if (!holderSymbol || isRebound(checker, sourceFiles, holderSymbol))
        return false;
    if (typeof key !== "string" && isRebound(checker, sourceFiles, key))
        return false;
    // The `if` statements the write sits in, innermost first, with the side
    // it takes, up to the block whose earlier statement reads the slot.
    const guards: { condition: ts.Expression; taken: boolean }[] = [];
    let node: ts.Node = assignment;
    while (node.parent && !ts.isFunctionLike(node.parent)) {
        const parent = node.parent;
        if (ts.isIfStatement(parent) && parent.expression !== node)
            guards.push({
                condition: parent.expression,
                taken: parent.thenStatement === node,
            });
        if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
            const index = parent.statements.indexOf(node as ts.Statement);
            const reads = new Set<ts.Symbol>();
            for (const statement of parent.statements.slice(0, index))
                for (const read of slotReads(
                    checker,
                    statement,
                    holderSymbol,
                    key,
                ))
                    reads.add(read);
            if (reads.size > 0)
                return guards.some(
                    ({ condition, taken }) =>
                        evaluateGuard(checker, condition, reads, current) ===
                        !taken,
                );
        }
        node = parent;
    }
    return false;
}

/** The key a slot access names: a property's name, a literal key, or the symbol of a key variable. */
function slotKey(
    checker: ts.TypeChecker,
    access: ts.ElementAccessExpression | ts.PropertyAccessExpression,
): string | ts.Symbol | undefined {
    if (ts.isPropertyAccessExpression(access)) return access.name.text;
    const argument = unwrapExpression(access.argumentExpression);
    return ts.isIdentifier(argument)
        ? valueSymbolOf(checker, argument)
        : literalKey(argument);
}

/** The `const`s a statement declares holding a read of the slot `holder[key]`. */
function slotReads(
    checker: ts.TypeChecker,
    statement: ts.Statement,
    holder: ts.Symbol,
    key: string | ts.Symbol,
): ts.Symbol[] {
    if (
        !ts.isVariableStatement(statement) ||
        variableKind(statement.declarationList) !== "const"
    )
        return [];
    return statement.declarationList.declarations.flatMap((declaration) => {
        const read =
            declaration.initializer &&
            unwrapExpression(declaration.initializer);
        if (
            !ts.isIdentifier(declaration.name) ||
            !read ||
            !(
                ts.isElementAccessExpression(read) ||
                ts.isPropertyAccessExpression(read)
            )
        )
            return [];
        const owner = unwrapExpression(read.expression);
        const symbol = valueSymbolOf(checker, declaration.name);
        return symbol &&
            ts.isIdentifier(owner) &&
            valueSymbolOf(checker, owner) === holder &&
            slotKey(checker, read) === key
            ? [symbol]
            : [];
    });
}

/** `Number`'s and the global tests a guard may apply to the slot's value. */
const VALUE_TESTS: Readonly<Record<string, (value: unknown) => boolean>> = {
    "Number.isFinite": (value) => Number.isFinite(value),
    "Number.isNaN": (value) => Number.isNaN(value),
    "Number.isInteger": (value) => Number.isInteger(value),
    "Array.isArray": (value) => Array.isArray(value),
};

/** The class of value a JavaScript value is ({@link ValueClass}). */
function valueClass(value: unknown): ValueClass {
    return value === null || value === undefined
        ? "nullish"
        : value
          ? "truthy"
          : "falsy";
}

/**
 * A guard's value where each of `reads` holds `current`: true or false, or
 * undefined for any test it does not settle (another value, a call, an
 * effect).
 */
function evaluateGuard(
    checker: ts.TypeChecker,
    expression: ts.Expression,
    reads: ReadonlySet<ts.Symbol>,
    current: unknown,
): boolean | undefined {
    const value = (node: ts.Expression): { known: unknown } | undefined => {
        const unwrapped = unwrapExpression(node);
        if (ts.isIdentifier(unwrapped)) {
            const symbol = valueSymbolOf(checker, unwrapped);
            if (symbol && reads.has(symbol)) return { known: current };
            return unwrapped.text === "undefined" &&
                libraryGlobal(checker, unwrapped) === "undefined"
                ? { known: undefined }
                : undefined;
        }
        if (ts.isStringLiteralLike(unwrapped)) return { known: unwrapped.text };
        if (ts.isNumericLiteral(unwrapped))
            return { known: Number(unwrapped.text) };
        if (unwrapped.kind === ts.SyntaxKind.TrueKeyword)
            return { known: true };
        if (unwrapped.kind === ts.SyntaxKind.FalseKeyword)
            return { known: false };
        if (unwrapped.kind === ts.SyntaxKind.NullKeyword)
            return { known: null };
        if (ts.isTypeOfExpression(unwrapped)) {
            const operand = value(unwrapped.expression);
            return operand && { known: typeof operand.known };
        }
        if (
            ts.isPrefixUnaryExpression(unwrapped) &&
            unwrapped.operator === ts.SyntaxKind.ExclamationToken
        ) {
            const operand = value(unwrapped.operand);
            return operand && { known: !operand.known };
        }
        if (
            ts.isCallExpression(unwrapped) &&
            unwrapped.arguments.length === 1
        ) {
            const name = libraryCallName(checker, unwrapped);
            const test = name === undefined ? undefined : VALUE_TESTS[name];
            const argument = value(unwrapped.arguments[0]!);
            return test && argument
                ? { known: test(argument.known) }
                : undefined;
        }
        if (ts.isBinaryExpression(unwrapped)) {
            const operator = unwrapped.operatorToken.kind;
            const left = value(unwrapped.left);
            // `&&`, `||` and `??` yield the left operand where its value is
            // of a class they pass on, else the right.
            const passed = isOperandSelection(unwrapped)
                ? operandYield(unwrapped, unwrapped.left)
                : undefined;
            if (passed)
                return left && passed.has(valueClass(left.known))
                    ? left
                    : left && value(unwrapped.right);
            const right = value(unwrapped.right);
            if (!left || !right) return undefined;
            const a = left.known;
            const b = right.known;
            const equality = equalityOperator(operator);
            if (equality) {
                const equal = equality.loose ? a == b : a === b;
                return { known: equality.negated ? !equal : equal };
            }
            switch (operator) {
                case ts.SyntaxKind.LessThanToken:
                case ts.SyntaxKind.LessThanEqualsToken:
                case ts.SyntaxKind.GreaterThanToken:
                case ts.SyntaxKind.GreaterThanEqualsToken:
                    if (typeof a !== "number" || typeof b !== "number")
                        return undefined;
                    return {
                        known:
                            operator === ts.SyntaxKind.LessThanToken
                                ? a < b
                                : operator === ts.SyntaxKind.LessThanEqualsToken
                                  ? a <= b
                                  : operator === ts.SyntaxKind.GreaterThanToken
                                    ? a > b
                                    : a >= b,
                    };
            }
        }
        return undefined;
    };
    const result = value(expression);
    return result === undefined ? undefined : Boolean(result.known);
}

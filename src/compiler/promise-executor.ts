import ts from "typescript";
import { argumentAt } from "./syntax.js";

/** The default-library Promise constructor with one named arrow-executor parameter. */
export function promiseExecutor(
    expression: ts.Expression,
    isGlobal: (identifier: ts.Identifier) => boolean,
): { executor: ts.ArrowFunction; resolve: ts.Identifier } | undefined {
    if (!ts.isNewExpression(expression) || !ts.isIdentifier(expression.expression) ||
        expression.expression.text !== "Promise" || !isGlobal(expression.expression) ||
        expression.arguments?.length !== 1) return undefined;
    const executor = argumentAt(expression, 0);
    if (!ts.isArrowFunction(executor) || executor.parameters.length !== 1 ||
        !ts.isIdentifier(executor.parameters[0]!.name)) return undefined;
    return { executor, resolve: executor.parameters[0]!.name };
}

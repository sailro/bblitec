import ts from "typescript";
import { argumentAt } from "./syntax.js";
import type { LibraryGlobal } from "./symbols.js";

/** The default-library Promise constructor with one named arrow-executor parameter. */
export function promiseExecutor(
    expression: ts.Expression,
    libraryGlobal: LibraryGlobal,
): { executor: ts.ArrowFunction; resolve: ts.Identifier } | undefined {
    if (
        !ts.isNewExpression(expression) ||
        libraryGlobal(expression.expression) !== "Promise" ||
        expression.arguments?.length !== 1
    )
        return undefined;
    const executor = argumentAt(expression, 0);
    if (
        !ts.isArrowFunction(executor) ||
        executor.parameters.length !== 1 ||
        !ts.isIdentifier(executor.parameters[0]!.name)
    )
        return undefined;
    return { executor, resolve: executor.parameters[0]!.name };
}

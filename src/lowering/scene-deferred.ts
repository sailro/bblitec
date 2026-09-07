import ts from "typescript";
import type { LoweringContext } from "./context.js";

/** The adapter may collect failures only when the source callback rejects. */
export function assertAsyncSceneBuilder(context: LoweringContext, declaration: ts.FunctionDeclaration): void {
    const calls = context.findNodes(declaration, (node): node is ts.CallExpression =>
        ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "push" && ts.isPropertyAccessExpression(node.expression.expression) &&
        node.expression.expression.name.text === "_deferredBuilders");
    const callback = calls[0]?.arguments[0];
    if (calls.length !== 1 || calls[0]!.arguments.length !== 1 || !callback ||
        !ts.isArrowFunction(callback) || !callback.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
        context.contractError(declaration, "Expected one async deferred scene builder; synchronous throws must stop the batch map.");
    }
}

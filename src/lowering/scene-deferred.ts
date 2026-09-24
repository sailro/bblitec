import ts from "typescript";
import type { LoweringContext } from "./context.js";

/** The adapter may collect failures only when the source callback rejects. */
export function assertAsyncSceneBuilder(
    context: LoweringContext,
    declaration: ts.FunctionDeclaration,
): void {
    const calls = context.findNodes(
        declaration,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "push" &&
            ts.isPropertyAccessExpression(node.expression.expression) &&
            node.expression.expression.name.text === "_deferredBuilders",
    );
    const callback = calls[0]?.arguments[0];
    if (
        calls.length !== 1 ||
        calls[0]!.arguments.length !== 1 ||
        !callback ||
        !ts.isArrowFunction(callback) ||
        !callback.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
        )
    ) {
        context.contractError(
            declaration,
            "Expected one async deferred scene builder; synchronous throws must stop the batch map.",
        );
    }
}

/**
 * The native scene's deferred-builder queue stands in for the pin's
 * `addDeferredSceneRenderables`: one async builder whose result's
 * renderables join the scene's renderables and whose disposer joins its
 * disposables. The queue is the native runtime's scene; this holds it to
 * the pin's publication.
 */
export function assertDeferredSceneRenderables(context: LoweringContext): void {
    const { declaration } = context.functionDeclaration(
        "src/scene/scene-core.ts",
        "addDeferredSceneRenderables",
    );
    assertAsyncSceneBuilder(context, declaration);
    const pushes = (list: string, member: string, spread: boolean) =>
        context.findNodes(
            declaration,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                node.expression.name.text === "push" &&
                ts.isPropertyAccessExpression(node.expression.expression) &&
                node.expression.expression.name.text === list &&
                node.arguments.length === 1 &&
                (spread
                    ? ts.isSpreadElement(node.arguments[0]!) &&
                      ts.isPropertyAccessExpression(
                          node.arguments[0].expression,
                      ) &&
                      node.arguments[0].expression.name.text === member
                    : ts.isPropertyAccessExpression(node.arguments[0]!) &&
                      node.arguments[0].name.text === member),
        ).length;
    if (
        pushes("_renderables", "renderables", true) !== 1 ||
        pushes("_disposables", "dispose", false) !== 1
    )
        context.contractError(
            declaration,
            "Expected the deferred builder to publish its renderables and adopt its disposer.",
        );
}

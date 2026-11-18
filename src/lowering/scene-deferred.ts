import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { isAsyncFunction } from "../compiler/syntax.js";

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
        !isAsyncFunction(callback)
    ) {
        context.contractError(
            declaration,
            "Expected one async deferred scene builder; synchronous throws must stop the batch map.",
        );
    }
}

export const sceneRenderableCollection =
    "src/scene/scene-renderable-collection.ts";

/** The shared native add port represents the pin's add-only collection lifecycle. */
export function assertSceneRenderableAdd(context: LoweringContext): void {
    const { declaration } = context.functionDeclaration(
        sceneRenderableCollection,
        "_addSceneRenderable",
    );
    assertAsyncSceneBuilder(context, declaration);
    context.assertStatementShapes(
        declaration,
        declaration.body!.statements.slice(0, 5),
        `const collection = getCollection(scene, family);
         const members = collection._members;
         if (members.has(entity)) { return; }
         const entry: SceneRenderableEntry = { _unregister: register?.() };
         members.set(entity, entry);`,
        "scene renderable membership before attachment",
    );
    const attach = context.callExpression(declaration, "attach");
    context.assertExpressionShape(
        attach,
        "attach(scene.surface.engine)",
        "scene renderable attachment",
    );
    for (const expression of [
        "scene._renderables.push(attachment._renderable)",
        "scene._disposables.push((entry._dispose = () => attachment._detach?.()()))",
    ]) {
        context.expectShapeCount(
            declaration,
            expression,
            "deferred scene renderable publication",
        );
    }
}

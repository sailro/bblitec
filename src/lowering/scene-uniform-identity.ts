import ts from "typescript";
import { LoweringContext } from "./context.js";

/** The loaders assign the new texture object, while glTF retains it in _sceneSetup. */
export function assertEnvironmentTextureIdentity(
    context: LoweringContext,
    scope: ts.Node,
    factoryModule: string,
    retainedSetup = false,
): void {
    const { declaration: assemble } = context.functionDeclaration(factoryModule, "assembleEnvironmentTextures");
    const returns = context.findNodes(assemble, (node): node is ts.ReturnStatement => ts.isReturnStatement(node));
    if (returns.length !== 1 || !returns[0]!.expression ||
        !ts.isObjectLiteralExpression(returns[0]!.expression)) {
        context.contractError(assemble, "Expected environment assembly to return one fresh object literal.");
    }
    const textures = context.variableInitializer(scope, "textures");
    if (!ts.isCallExpression(textures) ||
        context.propertyPath(textures.expression)?.join(".") !== "assembleEnvironmentTextures") {
        context.contractError(textures, "Expected a fresh assembled environment texture object.");
    }
    const replacements = context.findNodes(scope, (node): node is ts.BinaryExpression =>
        ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        context.propertyPath(node.left)?.join(".") === "scene._envTextures");
    if (replacements.length !== 1) {
        context.contractError(scope, "Expected one environment texture object replacement.");
    }
    context.assertExpressionShape(replacements[0]!.right, "textures", "Pinned environment object replacement");
    if (retainedSetup) {
        const setup = context.variableInitializer(scope, "_sceneSetup");
        if (!ts.isArrowFunction(setup) || textures.pos >= setup.pos ||
            replacements[0]!.pos < setup.pos || replacements[0]!.end > setup.end) {
            context.contractError(setup, "Expected glTF scene setup to retain its previously assembled texture object.");
        }
    }
}

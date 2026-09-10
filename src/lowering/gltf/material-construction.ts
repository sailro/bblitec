import ts from "typescript";
import { LoweringContext } from "../context.js";
import { identifierParameters } from "./shared.js";

/** Locate the single closed resource-construction call within a cache builder. */
export function closedMaterialConstruction(context: LoweringContext, builder: ts.Node): {call: ts.CallExpression; body: ts.Block} {
    const calls = context.findNodes(builder, (node): node is ts.CallExpression =>
        ts.isCallExpression(node) && ts.isArrowFunction(context.unwrapExpression(node.expression)));
    if (calls.length !== 1 || calls[0]!.arguments.length) context.contractError(builder, "Expected one closed glTF material construction boundary.");
    const call = calls[0]!;
    const closure = context.unwrapExpression(call.expression);
    if (!ts.isArrowFunction(closure) || !ts.isBlock(closure.body) || closure.parameters.length)
        context.contractError(call, "Expected a closed glTF material construction body.");
    return {call, body: closure.body};
}

/** The resource boundary shared by source scheduling and native construction. */
export function gltfBaseMaterialConstruction(context: LoweringContext) {
    const {file, declaration} = context.functionDeclaration("src/loader-gltf/load-gltf.ts", "uploadMeshes");
    const builders = context.findNodes(declaration, (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "buildPbrFromGltfMat");
    const builder = builders.length === 1 && builders[0]!.initializer;
    if (!builder || !ts.isArrowFunction(builder)) context.contractError(declaration, "Expected one glTF material builder.");
    const {call, body} = closedMaterialConstruction(context, builder);
    const parameters = identifierParameters("buildPbrFromGltfMat", file, builder);
    const uploadParameters = identifierParameters("uploadMeshes", file, declaration);
    if (parameters.length !== 1 || uploadParameters.length !== 3)
        context.contractError(builder, "Expected glTF material and upload context parameters.");
    return {file, declaration, call, body, material: parameters[0]!, uploadContext: uploadParameters[2]!};
}

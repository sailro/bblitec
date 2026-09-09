import ts from "typescript";
import { LoweringContext } from "../context.js";
import { lowerGltfMaterialObjectFunction } from "./material-object-lowerer.js";
import { gltfSamplerFields } from "./sampler-resolver.js";

/** Project the source upload sampler through the native descriptor boundary. */
export function lowerGltfDefaultSampler(context: LoweringContext): string {
    const module = "src/loader-gltf/load-gltf.ts";
    const { declaration } = context.functionDeclaration(module, "uploadMeshes");
    const sampler = declaration.body!.statements.flatMap(statement => ts.isVariableStatement(statement)
        ? [...statement.declarationList.declarations] : []).find(variable => ts.isIdentifier(variable.name) && variable.name.text === "sampler");
    const call = sampler?.initializer;
    if (!call || !ts.isCallExpression(call) || !context.expressionMatchesShape(call.expression, "getOrCreateSampler") || call.arguments.length !== 2)
        context.contractError(declaration, "Expected the loader's shared sampler creation.");
    const descriptor = call.arguments[1]!;
    if (!ts.isObjectLiteralExpression(descriptor)) context.contractError(descriptor, "Expected a shared sampler descriptor.");
    for (const property of descriptor.properties) {
        const name = ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) ? property.name.text : undefined;
        if (!gltfSamplerFields.some(([field]) => field === name))
            context.contractError(property, "Unrepresented shared sampler field.");
    }
    const file = ts.createSourceFile(module, `function gltf_default_sampler_descriptor() { return ${descriptor.getText()}; }`, ts.ScriptTarget.Latest, true);
    const selected = file.statements[0];
    if (!selected || !ts.isFunctionDeclaration(selected)) context.contractError(descriptor, "Expected a sampler descriptor function.");
    return lowerGltfMaterialObjectFunction(context, { module, name: "gltf_default_sampler_descriptor", cpp: "gltf_default_sampler_descriptor",
        declaration: selected, sourceSymbol: "uploadMeshes" }, () => undefined) + `
TextureSamplerState gltf_project_sampler(const GltfPbrValue& descriptor);
TextureSamplerState gltf_default_sampler_state() {
    return gltf_project_sampler(gltf_default_sampler_descriptor());
}`;
}

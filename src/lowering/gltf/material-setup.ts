import ts from "typescript";
import { LoweringContext } from "../context.js";
import { lowerGltfMaterialObjectFunction, type GltfMaterialFunction } from "./material-object-lowerer.js";
import { lowerGltfDefaultSampler } from "./sampler-mapping.js";

/** Document-wide material path selection from the loader's upload setup. */
export function lowerGltfMaterialSetup(context: LoweringContext, resolveCall: (name: string) => string | undefined): {
    source: string; functions: readonly GltfMaterialFunction[];
} {
    const module = "src/loader-gltf/load-gltf.ts";
    const { declaration } = context.functionDeclaration(module, "uploadMeshes");
    const statements = declaration.body!.statements;
    const start = statements.findIndex(statement => ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(variable => ts.isIdentifier(variable.name) && variable.name.text === "_needsPbrExt"));
    const guard = statements[start + 1];
    if (start < 0 || !guard || !ts.isIfStatement(guard))
        context.contractError(declaration, "Expected material path initialization and guard.");
    const samplerGate = statements.find(statement => ts.isIfStatement(statement) &&
        context.findNodes(statement.thenStatement, (node): node is ts.CallExpression =>
            ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!) &&
            node.arguments[0].text === "./gltf-sampler-desc.js").length > 0);
    if (!samplerGate || !ts.isIfStatement(samplerGate))
        context.contractError(declaration, "Expected sampled material path selection.");
    const builder = context.findNodes(declaration, (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "buildPbrFromGltfMat")[0];
    const construction = builder && context.findNodes(builder, (node): node is ts.CallExpression =>
        ts.isCallExpression(node) && ts.isArrowFunction(context.unwrapExpression(node.expression)));
    if (!construction || construction.length !== 1) context.contractError(declaration, "Expected one material construction closure.");
    const closure = context.unwrapExpression(construction[0]!.expression);
    if (!ts.isArrowFunction(closure) || !ts.isBlock(closure.body)) context.contractError(declaration, "Expected a material construction body.");
    const functions = [
        ["gltf_pbr_needs_extended", "json, wrapTex, identityTexWrap",
            `${statements[start]!.getText()}\n${guard.getText()}\nreturn _needsPbrExt;`],
        ["gltf_pbr_needs_sampler", "json", `return ${samplerGate.expression.getText()};`],
        ["gltf_pbr_build_material", "mat, matExts, extCtx, _needsPbrExt, buildSampledPbrTextures",
            closure.body.statements.map(statement => statement.getText()).join("\n")],
    ] satisfies [string, string, string][];
    const targets = functions.map(([name, parameters, body]): GltfMaterialFunction => {
        const async = name === "gltf_pbr_build_material" ? "async " : "";
        const file = ts.createSourceFile(module, `${async}function ${name}(${parameters}) { ${body} }`, ts.ScriptTarget.Latest, true);
        const selected = file.statements[0];
        if (!selected || !ts.isFunctionDeclaration(selected)) context.contractError(declaration, "Expected material setup body.");
        return { module, name, cpp: name, declaration: selected, sourceSymbol: "uploadMeshes",
            ...(name === "gltf_pbr_build_material" ? { contextParameter: "extCtx" } : {}) };
    });
    return { functions: targets, source: lowerGltfDefaultSampler(context) + "\n" + targets.map(target => lowerGltfMaterialObjectFunction(context, target, resolveCall,
        (call, lowerer) => {
            if (context.expressionMatchesShape(call.expression, "_ensurePbrExt") && call.arguments.length === 0)
                return "GltfPbrValue{true}";
            if (context.expressionMatchesShape(call.expression, "ctx._runMatExts")) {
                const run = resolveCall("runGltfMaterialFeatures");
                if (!run || call.arguments.length !== 3) context.contractError(call, "Expected the material extension runner.");
                return `${run}(${call.arguments.map(argument => lowerer.expression(argument)).join(", ")})`;
            }
            const builders = [
                ["extMod.buildDefaultPbrTexturesExt", "extended_textures", ["engine", "mat", "sampler", "_generateMipmaps!", "getCachedTexture", "wrapTex", "samplerFor"]],
                ["buildSampledPbrTextures", "sampled_textures", ["engine", "mat", "sampler", "_generateMipmaps!", "samplerFor!", "getCachedTexture"]],
                ["buildDefaultPbrTextures", "default_textures", ["engine", "mat", "sampler", "_generateMipmaps!", "getCachedTexture"]],
            ] as const;
            for (const [name, member, parameters] of builders) {
                if (!context.expressionMatchesShape(call.expression, name)) continue;
                if (call.arguments.length !== parameters.length) context.contractError(call, "Expected material texture upload arguments.");
                call.arguments.forEach((argument, index) => context.assertExpressionShape(argument, parameters[index]!, "Material texture boundary"));
                return `extCtx.${member}(${lowerer.expression(call.arguments[1]!)})`;
            }
            return undefined;
        })).join("\n") };
}

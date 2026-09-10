import ts from "typescript";
import { LoweringContext } from "../context.js";
import type { GltfMaterialFunction } from "./material-object-lowerer.js";

/** Separate the variant loader's resource construction from its scheduling AST. */
export function gltfVariantMaterialSource(context: LoweringContext): {
    schedule: string; build: GltfMaterialFunction; upload: GltfMaterialFunction;
} {
    const module = "src/loader-gltf/gltf-variants.ts";
    const { file, declaration } = context.functionDeclaration(module, "loadVariantMaterials");
    const statements = declaration.body!.statements;
    const variable = (name: string) => {
        const found = statements.flatMap(statement => ts.isVariableStatement(statement)
            ? [...statement.declarationList.declarations] : []).find(value => ts.isIdentifier(value.name) && value.name.text === name);
        if (!found?.initializer) context.contractError(declaration, `Expected variant ${name} state.`);
        return found;
    };
    const pbr = variable("getPbr");
    const assemblies = context.findNodes(variable("getMat"), (node): node is ts.CallExpression =>
        ts.isCallExpression(node) && context.expressionMatchesShape(node.expression, "assembleMaterial"));
    if (assemblies.length !== 1 || assemblies[0]!.arguments.length !== 5)
        context.contractError(declaration, "Expected variant material assembly arguments.");
    const constructions = context.findNodes(pbr, (node): node is ts.CallExpression => ts.isCallExpression(node) &&
        ts.isArrowFunction(context.unwrapExpression(node.expression)));
    if (constructions.length !== 1 || constructions[0]!.arguments.length) context.contractError(pbr, "Expected one variant material construction closure.");
    const construction = context.unwrapExpression(constructions[0]!.expression);
    if (!ts.isArrowFunction(construction) || !ts.isBlock(construction.body) || construction.parameters.length)
        context.contractError(pbr, "Expected a closed variant material construction body.");
    const buildFile = ts.createSourceFile(module,
        `async function gltf_pbr_build_variant(gltfMat, exts, extCtx) ${construction.body.getText(file)}`,
        ts.ScriptTarget.Latest, true);
    const build = buildFile.statements[0];
    if (!build || !ts.isFunctionDeclaration(build)) context.contractError(declaration, "Expected variant material function.");
    const uploadArrow = variable("getCachedTex").initializer!;
    if (!ts.isArrowFunction(uploadArrow) || ts.isBlock(uploadArrow.body)) context.contractError(uploadArrow, "Expected a variant texture upload expression.");
    const uploadFile = ts.createSourceFile(module, `function gltf_pbr_variant_texture(${uploadArrow.parameters.map(parameter => parameter.getText(file)).join(", ")}, extCtx) {
        return ${uploadArrow.body.getText(file)};
    }`, ts.ScriptTarget.Latest, true);
    const upload = uploadFile.statements[0];
    if (!upload || !ts.isFunctionDeclaration(upload)) context.contractError(declaration, "Expected variant texture upload function.");
    const start = statements.findIndex(statement => ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.includes(variable("originals")));
    if (start < 0) context.contractError(declaration, "Expected variant mapping construction.");
    // The source caches and complete mapping walk execute at generation. Only
    // the material constructor is replaced by a recording resource boundary;
    // that same constructor is lowered below for native execution.
    const transformed = ts.transform(pbr.initializer!, [visitorContext => root => {
        const visit: ts.Visitor = node => node === constructions[0]
            ? ts.factory.createCallExpression(ts.factory.createIdentifier("buildMaterial"), undefined, [ts.factory.createIdentifier("gltfMat")])
            : ts.visitEachChild(node, visit, visitorContext);
        return ts.visitNode(root, visit) as ts.Expression;
    }]);
    const printer = ts.createPrinter();
    const pbrCache = printer.printNode(ts.EmitHint.Expression, transformed.transformed[0]!, file);
    transformed.dispose();
    const declarations = ["matCache", "imageCache", "getMat", "pbrCache"].map(name => `const ${variable(name).getText(file)};`);
    return {
        schedule: `${declarations.join("\n")}\nconst getPbr = ${pbrCache};\n${statements.slice(start).map(statement => statement.getText(file)).join("\n")}`,
        build: { module, name: "gltf_pbr_build_variant", cpp: "gltf_pbr_build_variant", declaration: build,
            contextParameter: "extCtx", sourceSymbol: "loadVariantMaterials" },
        upload: { module, name: "gltf_pbr_variant_texture", cpp: "gltf_pbr_variant_texture", declaration: upload,
            contextParameter: "extCtx", sourceSymbol: "loadVariantMaterials" },
    };
}

import ts from "typescript";
import { LoweringContext } from "../context.js";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";
import type { PinnedBinding } from "../pinned-numeric-lowerer.js";

/** Source material cache closures over identity-preserving settled promises. */
export function lowerGltfMaterialCaches(context: LoweringContext): string {
    const module = "src/loader-gltf/load-gltf.ts";
    const functions: string[] = [];
    for (const [owner, closure, sourceCache, cppCache, result] of [
        ["extractAllMeshes", "getMat", "matCache", "GltfCoreMaterialCache", "GltfCoreMaterialRef"],
        ["uploadMeshes", "buildPbrFromGltfMat", "builtMaterialCache", "GltfBuiltMaterialCache", "MaterialHandle"],
    ] as const) {
        const { file, declaration } = context.functionDeclaration(module, owner);
        const declarations = declaration.body!.statements.flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []);
        const cache = declarations.find(variable => ts.isIdentifier(variable.name) && variable.name.text === sourceCache);
        const selected = declarations.find(variable => ts.isIdentifier(variable.name) && variable.name.text === closure);
        const arrow = selected?.initializer && context.unwrapExpression(selected.initializer);
        const core = owner === "extractAllMeshes";
        if (!cache?.initializer || !(core ? ts.isArrayLiteralExpression(cache.initializer) && !cache.initializer.elements.length :
            ts.isNewExpression(cache.initializer) && context.expressionMatchesShape(cache.initializer.expression, "Map") && !cache.initializer.arguments?.length) ||
            !arrow || !ts.isArrowFunction(arrow) || !ts.isBlock(arrow.body) || arrow.parameters.length !== 1 || !ts.isIdentifier(arrow.parameters[0]!.name))
            context.contractError(declaration, "Expected a material cache and one-parameter resolver.");
        const parameter = arrow.parameters[0]!.name.text;
        const bindings = new Map<string, PinnedBinding>([[parameter, core ? { cpp: "(*material_index)", type: "scalar", absentCpp: "!material_index" } :
            { cpp: "material", type: "opaque", absentCpp: "!material" }]]);
        const nullable = new Set<string>();
        const body = lowerPinnedBody(file, arrow.body.statements, {
            bindings, calls: new Map(), foldConditions: false,
            expression(node, lowerer) {
                if (ts.isBinaryExpression(node)) {
                    if (core && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && ts.isIdentifier(node.left) && node.left.text === parameter)
                        return `(material_index ? ${lowerer.expression(node.left)} : ${lowerer.expression(node.right)})`;
                    if (core && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken && ts.isElementAccessExpression(node.left) &&
                        context.expressionMatchesShape(node.left.expression, sourceCache)) {
                        const call = context.unwrapExpression(node.right);
                        if (!ts.isCallExpression(call) || !context.expressionMatchesShape(call.expression, "assembleMaterial") || call.arguments.length !== 5)
                            context.contractError(node, "Expected cached material assembly.");
                        for (const [index, name] of [[0, "json"], [1, "binChunk"], [3, "baseUrl"], [4, "imageCache"]] as const)
                            context.assertExpressionShape(call.arguments[index]!, name, "Core material cache environment");
                        return `[&]() { auto& promise = bbl::js::array_index_write(cache, bbl::js::array_index(${lowerer.expression(node.left.argumentExpression)}));
                            if (!promise) promise = GltfLoadPromise<${result}>::settle([&] { return build(${lowerer.expression(call.arguments[2]!)}); });
                            return promise; }()`;
                    }
                    if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && nullable.has(node.left.text))
                        return `(${node.left.text} = ${lowerer.expression(node.right)})`;
                }
                if (ts.isCallExpression(node)) {
                    if (!core && context.expressionMatchesShape(node.expression, `${sourceCache}.get`) && node.arguments.length === 1)
                        return `cache.get(${lowerer.expression(node.arguments[0]!)})`;
                    if (!core && context.expressionMatchesShape(node.expression, `${sourceCache}.set`) && node.arguments.length === 2)
                        return `cache.set(${node.arguments.map(argument => lowerer.expression(argument)).join(", ")})`;
                    const callee = context.unwrapExpression(node.expression);
                    if (!core && ts.isArrowFunction(callee) && node.arguments.length === 0) {
                        const constructions = context.findNodes(arrow, (candidate): candidate is ts.CallExpression =>
                            ts.isCallExpression(candidate) && ts.isArrowFunction(context.unwrapExpression(candidate.expression)));
                        if (constructions.length !== 1 || constructions[0] !== node)
                            context.contractError(node, "Expected the source material construction closure.");
                        // The same closure body is emitted by lowerGltfMaterialSetup.
                        return `GltfLoadPromise<${result}>::settle([&] { return build(material); })`;
                    }
                }
                return undefined;
            },
            statement(statement, lowerer, indent) {
                if (ts.isExpressionStatement(statement)) return [`${indent}${lowerer.expression(statement.expression)};`];
                if (!ts.isVariableStatement(statement)) return undefined;
                return statement.declarationList.declarations.map(variable => {
                    if (!ts.isIdentifier(variable.name) || !variable.initializer) context.contractError(variable, "Expected material cache state.");
                    const name = variable.name.text, initializer = context.unwrapExpression(variable.initializer), rendered = lowerer.expression(initializer);
                    const optional = !core && ts.isCallExpression(initializer) && context.expressionMatchesShape(initializer.expression, `${sourceCache}.get`);
                    if (optional) nullable.add(name);
                    bindings.set(name, { cpp: optional ? `(*${name})` : name, type: core ? "scalar" : "opaque", absentCpp: `!${name}` });
                    return `${indent}auto ${name} = ${rendered};`;
                });
            },
            returnValue: (expression, lowerer) => lowerer.expression(expression!),
        });
        functions.push(`// ${context.provenance(module, owner)}
template<class Build> GltfLoadPromise<${result}> ${core ? "gltf_cached_core_material" : "gltf_cached_built_material"}(
    ${cppCache}& cache, ${core ? "[[maybe_unused]] bbl::js::Nullable<double> material_index" : "GltfCoreMaterialRef material"}, Build build) {
${body}
}`);
    }
    return `using GltfCoreMaterialRef = std::shared_ptr<const GltfCoreMaterial>;
using GltfCoreMaterialCache = bbl::js::Array<GltfLoadPromise<GltfCoreMaterialRef>>;
using GltfBuiltMaterialCache = bbl::js::Map<GltfCoreMaterialRef, GltfLoadPromise<MaterialHandle>>;
${functions.join("\n")}`;
}

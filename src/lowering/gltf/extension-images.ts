import ts from "typescript";
import { LoweringContext } from "../context.js";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";
import type { PinnedBinding } from "../pinned-numeric-lowerer.js";

/** Source activation, image fetch and wrapping for the loader's material extension context. */
export function lowerGltfExtensionImages(context: LoweringContext): string {
    const module = "src/loader-gltf/load-gltf.ts";
    const { file, declaration } = context.functionDeclaration(module, "uploadMeshes");
    const statements = declaration.body!.statements;
    const first = statements.findIndex(statement => ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(variable => ts.isIdentifier(variable.name) && variable.name.text === "extImageCache"));
    if (first < 0) context.contractError(declaration, "Expected extension image cache initialization.");
    const bindings = new Map<string, PinnedBinding>([["matExts.length", { cpp: "extension_count", type: "scalar" }]]);
    const setup = lowerPinnedBody(file, statements.slice(first, first + 2), {
        bindings, calls: new Map(),
        statement(statement, lowerer, indent) {
            if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1)
                context.contractError(statement, "Expected extension image state.");
            const variable = statement.declarationList.declarations[0]!;
            if (!ts.isIdentifier(variable.name) || !variable.initializer) context.contractError(variable, "Expected named extension image state.");
            const name = variable.name.text, initializer = context.unwrapExpression(variable.initializer);
            if (!ts.isConditionalExpression(initializer) || initializer.whenFalse.kind !== ts.SyntaxKind.NullKeyword)
                context.contractError(initializer, "Expected a nullable extension image initializer.");
            const condition = lowerer.expression(initializer.condition);
            bindings.set(name, { cpp: name, type: "opaque", absentCpp: `!${name}` });
            if (name === "extImageCache") {
                if (!ts.isArrayLiteralExpression(initializer.whenTrue) || initializer.whenTrue.elements.length)
                    context.contractError(initializer, "Expected an empty extension image cache.");
                return [`${indent}auto ${name} = ${condition} ? std::make_shared<GltfMaterialImageCache>() : nullptr;`];
            }
            if (name !== "extFetchImg") context.contractError(variable, "Unrepresented extension image binding.");
            context.assertExpressionShape(initializer.whenTrue, "makeImageFetcher(json, binChunk, baseUrl, extImageCache)", "Extension image environment");
            return [`${indent}GltfImageFetcher ${name} = ${condition} ? GltfImageFetcher{[&json, cache = extImageCache, resolve_image](const ts::JsonValue* info) {
                return make_gltf_image_fetcher(json, *cache, resolve_image)(info);
            }} : GltfImageFetcher{};`];
        },
    });
    const variables = context.findNodes(declaration, (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "extCtx");
    const object = variables[0]?.initializer && context.unwrapExpression(variables[0].initializer);
    if (variables.length !== 1 || !object || !ts.isObjectLiteralExpression(object)) context.contractError(declaration, "Expected one material extension context.");
    const methods = object.properties.filter((property): property is ts.MethodDeclaration =>
        ts.isMethodDeclaration(property) && ts.isIdentifier(property.name) && property.name.text === "_texture");
    const method = methods[0];
    if (methods.length !== 1 || !method?.body || method.parameters.length !== 2) context.contractError(object, "Expected the extension texture method.");
    const textureBindings = new Map<string, PinnedBinding>([["extFetchImg", { cpp: "fetch_image", type: "opaque", absentCpp: "!fetch_image" }]]);
    method.parameters.forEach((parameter, index) => {
        if (!ts.isIdentifier(parameter.name)) context.contractError(parameter, "Expected a named extension texture parameter.");
        textureBindings.set(parameter.name.text, index ? { cpp: "srgb", type: "bool" } : { cpp: "info", type: "opaque", absentCpp: "!info.truthy()" });
    });
    const body = lowerPinnedBody(file, method.body.statements, {
        bindings: textureBindings, calls: new Map([
            ["getCachedTexture", args => `cached_texture(${args.join(", ")})`],
            ["wrapTex", args => `wrap_texture(${args.join(", ")})`],
        ]), booleanOr: true, foldConditions: false,
        expression(node, lowerer) {
            if (ts.isIdentifier(node) && node.text === "undefined") return "GltfPbrValue{}";
            if (ts.isAwaitExpression(node)) return `(${lowerer.expression(node.expression)}).get()`;
            if (ts.isCallExpression(node) && context.expressionMatchesShape(node.expression, "extFetchImg") && node.arguments.length === 1)
                return `fetch_image((${lowerer.expression(node.arguments[0]!)}).source())`;
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (!ts.isVariableStatement(statement)) return undefined;
            return statement.declarationList.declarations.map(variable => {
                if (!ts.isIdentifier(variable.name) || !variable.initializer) context.contractError(variable, "Expected an extension image result.");
                const name = variable.name.text, initial = lowerer.expression(variable.initializer);
                textureBindings.set(name, { cpp: name, type: "opaque", absentCpp: `!${name}` });
                return `${indent}const auto ${name} = ${initial};`;
            });
        },
        returnValue: (expression, lowerer) => lowerer.expression(expression!),
    });
    return `using GltfImageFetcher = std::function<GltfMaterialImagePromise(const ts::JsonValue*)>;
// ${context.provenance(module, "uploadMeshes")}
template<class ResolveImage> GltfImageFetcher make_gltf_extension_image_fetcher(
    const JsonObject& json, double extension_count, ResolveImage resolve_image) {
${setup}
    return extFetchImg;
}
// ${context.provenance(module, "uploadMeshes")}
template<class CachedTexture, class WrapTexture> GltfPbrValue gltf_extension_texture(
    GltfPbrValue info, bool srgb, const GltfImageFetcher& fetch_image, CachedTexture cached_texture, WrapTexture wrap_texture) {
${body}
}`;
}

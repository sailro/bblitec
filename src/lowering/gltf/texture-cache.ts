import ts from "typescript";
import { LoweringContext } from "../context.js";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";
import type { PinnedBinding } from "../pinned-numeric-lowerer.js";

/** The loader's per-image upload cache over native Map and Array storage. */
export function lowerGltfTextureCache(context: LoweringContext): string {
    const module = "src/loader-gltf/load-gltf.ts";
    const { file, declaration } = context.functionDeclaration(module, "uploadMeshes");
    const variables = context.findNodes(declaration, (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node));
    const cache = variables.find(node => ts.isIdentifier(node.name) && node.name.text === "texCache");
    const selected = variables.find(node => ts.isIdentifier(node.name) && node.name.text === "getCachedTexture");
    const arrow = selected?.initializer && context.unwrapExpression(selected.initializer);
    if (!cache?.initializer || !ts.isNewExpression(cache.initializer) ||
        !context.expressionMatchesShape(cache.initializer.expression, "Map") || cache.initializer.arguments?.length ||
        !arrow || !ts.isArrowFunction(arrow) || !ts.isBlock(arrow.body) || arrow.parameters.length !== 2)
        context.contractError(declaration, "Expected the per-load texture Map and upload closure.");
    const parameters = arrow.parameters.map(parameter => {
        if (!ts.isIdentifier(parameter.name)) context.contractError(parameter, "Expected a named texture cache input.");
        return parameter.name.text;
    });
    const bindings = new Map<string, PinnedBinding>([
        [parameters[0]!, { cpp: "bitmap", type: "opaque", absentCpp: "!bitmap" }],
        [parameters[1]!, { cpp: "srgb", type: "bool" }],
    ]);
    const arrays = new Set<string>();
    const body = lowerPinnedBody(file, arrow.body.statements, {
        bindings, calls: new Map(),
        expression(node, lowerer) {
            if (ts.isArrayLiteralExpression(node))
                return `bbl::js::Array<GltfMaterialTexture>{${node.elements.map(element => lowerer.expression(element)).join(", ")}}`;
            if (ts.isCallExpression(node)) {
                if (context.expressionMatchesShape(node.expression, "texCache.get") && node.arguments.length === 1)
                    return `cache.get(${lowerer.expression(node.arguments[0]!)})`;
                if (context.expressionMatchesShape(node.expression, "texCache.set") && node.arguments.length === 2)
                    return `cache.set(${lowerer.expression(node.arguments[0]!)}, *(${lowerer.expression(node.arguments[1]!)}))`;
                if (context.expressionMatchesShape(node.expression, "uploadTex")) {
                    const [engine, image, srgb, sampler, mipmaps] = node.arguments;
                    if (node.arguments.length !== 5 || !engine || !image || !srgb || !sampler || !mipmaps)
                        context.contractError(node, "Expected the shared image upload boundary.");
                    context.assertExpressionShape(engine, "engine", "Texture upload engine");
                    context.assertExpressionShape(sampler, "sampler", "Texture upload sampler");
                    context.assertExpressionShape(mipmaps, "_generateMipmaps!", "Texture upload mipmaps");
                    return `upload(${lowerer.expression(image)}, ${lowerer.expression(srgb)})`;
                }
            }
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                const left = context.unwrapExpression(node.left);
                if (ts.isElementAccessExpression(left) && ts.isIdentifier(left.expression) && arrays.has(left.expression.text))
                    return `(bbl::js::array_index_write(*${left.expression.text}, bbl::js::array_index(${lowerer.expression(left.argumentExpression)})) = ${lowerer.expression(node.right)})`;
                if (ts.isIdentifier(left) && bindings.has(left.text)) return `(${lowerer.expression(left)} = ${lowerer.expression(node.right)})`;
            }
            if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && arrays.has(node.expression.text))
                return `bbl::js::array_at_or_default(*${node.expression.text}, ${lowerer.expression(node.argumentExpression)})`;
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (ts.isExpressionStatement(statement)) return [`${indent}${lowerer.expression(statement.expression)};`];
            if (!ts.isVariableStatement(statement)) return undefined;
            return statement.declarationList.declarations.map(variable => {
                if (!ts.isIdentifier(variable.name) || !variable.initializer)
                    context.contractError(variable, "Expected an initialized texture cache binding.");
                const name = variable.name.text, initializer = context.unwrapExpression(variable.initializer);
                const array = ts.isCallExpression(initializer) && context.expressionMatchesShape(initializer.expression, "texCache.get");
                const texture = ts.isElementAccessExpression(initializer);
                const rendered = lowerer.expression(initializer);
                if (array) arrays.add(name);
                bindings.set(name, { cpp: name, type: array || texture ? "opaque" : "scalar",
                    ...(array || texture ? { absentCpp: `!${name}` } : {}) });
                return `${indent}auto ${name} = ${rendered};`;
            });
        },
        returnValue: (node, lowerer) => lowerer.expression(node!),
    });
    return `using GltfTextureCache = bbl::js::Map<GltfMaterialImage, bbl::js::Array<GltfMaterialTexture>>;
// ${context.provenance(module, "uploadMeshes")}
template<class Upload> GltfMaterialTexture gltf_cached_texture(
    GltfTextureCache& cache, GltfMaterialImage bitmap, bool srgb, Upload upload) {
${body}
}`;
}

/** The sampled fast path shares uploads and derives wrappers only for a different sampler. */
export function lowerGltfSampledTexture(context: LoweringContext): string {
    const module = "src/loader-gltf/gltf-sampler-desc.ts";
    const { file, declaration } = context.functionDeclaration(module, "buildSampledPbrTextures");
    const selected = context.findNodes(declaration, (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "cached");
    const arrow = selected[0]?.initializer && context.unwrapExpression(selected[0].initializer);
    if (selected.length !== 1 || !arrow || !ts.isArrowFunction(arrow) || !ts.isBlock(arrow.body) || arrow.parameters.length !== 3)
        context.contractError(declaration, "Expected the sampled texture cache closure.");
    const bindings = new Map<string, PinnedBinding>([["defaultSampler", { cpp: "default_sampler", type: "opaque" }]]);
    arrow.parameters.forEach((parameter, index) => {
        if (!ts.isIdentifier(parameter.name)) context.contractError(parameter, "Expected a named sampled texture input.");
        bindings.set(parameter.name.text, { cpp: ["bitmap", "srgb", "info"][index]!, type: index === 1 ? "bool" : "opaque" });
    });
    const body = lowerPinnedBody(file, arrow.body.statements, {
        bindings, calls: new Map([
            ["samplerFor", args => `sampler_for(${args.join(", ")})`],
            ["getCachedTex", args => `cached_texture(${args.join(", ")})`],
        ]), foldConditions: false,
        expression(node, lowerer) {
            if (ts.isCallExpression(node) && context.expressionMatchesShape(node.expression, "engine._dlr?.d") && node.arguments.length === 2)
                return `register_derived(${node.arguments.map(argument => lowerer.expression(argument)).join(", ")})`;
            if (ts.isObjectLiteralExpression(node)) {
                const [spread, sampler] = node.properties;
                if (node.properties.length !== 2 || !spread || !ts.isSpreadAssignment(spread) || !sampler ||
                    !ts.isPropertyAssignment(sampler) || !ts.isIdentifier(sampler.name) || sampler.name.text !== "sampler")
                    context.contractError(node, "Expected a texture spread with sampler replacement.");
                return `[&]() { auto result = (${lowerer.expression(spread.expression)}).clone(); result.sampler = ${lowerer.expression(sampler.initializer)}; return result; }()`;
            }
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (ts.isExpressionStatement(statement)) return [`${indent}${lowerer.expression(statement.expression)};`];
            if (!ts.isVariableStatement(statement)) return undefined;
            return statement.declarationList.declarations.map(variable => {
                if (!ts.isIdentifier(variable.name) || !variable.initializer) context.contractError(variable, "Expected an initialized texture wrapper binding.");
                const rendered = lowerer.expression(variable.initializer), name = variable.name.text;
                bindings.set(name, { cpp: name, type: "opaque" });
                return `${indent}const auto ${name} = ${rendered};`;
            });
        },
        returnValue: (node, lowerer) => lowerer.expression(node!),
    });
    return `// ${context.provenance(module, "buildSampledPbrTextures")}
template<class SamplerFor, class Cached, class Register> GltfMaterialTexture gltf_sampled_texture(
    GltfMaterialImage bitmap, bool srgb, const ts::JsonValue* info, [[maybe_unused]] GltfMaterialSampler default_sampler,
    SamplerFor sampler_for, Cached cached_texture, Register register_derived) {
${body}
}`;
}

/** The extension builder's local sampler/image maps and upload retry path. */
export function lowerGltfExtendedTexturePicker(context: LoweringContext): string {
    const module = "src/loader-gltf/gltf-pbr-builder-ext.ts";
    const { file, declaration } = context.functionDeclaration(module, "buildDefaultPbrTexturesExt");
    const declarations = declaration.body!.statements.slice(1, 5).map(statement => {
        if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1)
            context.contractError(statement, "Expected extension texture cache bindings.");
        return statement.declarationList.declarations[0]!;
    });
    const expected = ["_localCache", "_ids", "_nextId", "pickTex"];
    declarations.forEach((variable, index) => {
        if (!ts.isIdentifier(variable.name) || variable.name.text !== expected[index] || !variable.initializer)
            context.contractError(variable, "Expected extension texture cache state.");
    });
    const arrow = context.unwrapExpression(declarations[3]!.initializer!);
    if (!ts.isArrowFunction(arrow) || !ts.isBlock(arrow.body) || arrow.parameters.length !== 3)
        context.contractError(arrow, "Expected an extension texture picker.");
    const bindings = new Map<string, PinnedBinding>([
        ["samplerFor", { cpp: "sampler_for", type: "opaque", absentCpp: "!sampler_for" }],
        ["_nextId", { cpp: "_nextId", type: "scalar" }],
    ]);
    arrow.parameters.forEach((parameter, index) => {
        if (!ts.isIdentifier(parameter.name)) context.contractError(parameter, "Expected a named texture picker parameter.");
        bindings.set(parameter.name.text, { cpp: ["image", "srgb", "info"][index]!, type: index === 1 ? "bool" : "opaque" });
    });
    const nullable = new Set<string>();
    const maps = new Map([["_localCache", "GltfLocalTextureCache"], ["_ids", "GltfTextureImageIds"]]);
    const mapReceiver = (node: ts.Expression) => {
        const receiver = context.unwrapExpression(node);
        return ts.isIdentifier(receiver) && maps.has(receiver.text) ? receiver.text : undefined;
    };
    const body = lowerPinnedBody(file, arrow.body.statements, {
        bindings, calls: new Map([
            ["samplerFor", args => `sampler_for(${args.join(", ")})`],
            ["getCachedTex", args => `cached_texture(${args.join(", ")})`],
        ]), foldConditions: false,
        expression(node, lowerer) {
            if (ts.isNewExpression(node) && context.expressionMatchesShape(node.expression, "Map") && !node.arguments?.length)
                return "GltfSamplerTextures{}";
            if (ts.isBinaryExpression(node)) {
                const left = context.unwrapExpression(node.left);
                if (ts.isIdentifier(left) && nullable.has(left.text) && ts.isIdentifier(node.right) && node.right.text === "undefined" &&
                    [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind))
                    return `${node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? "!" : ""}${left.text}.has_value()`;
                if (ts.isIdentifier(left) && bindings.has(left.text) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
                    return `(${left.text} = ${lowerer.expression(node.right)})`;
            }
            if (ts.isCallExpression(node)) {
                if (ts.isPropertyAccessExpression(node.expression)) {
                    const receiver = mapReceiver(node.expression.expression), operation = node.expression.name.text;
                    if (receiver && operation === "get" && node.arguments.length === 1)
                        return `${receiver}->get(${lowerer.expression(node.arguments[0]!)})`;
                    if (receiver && operation === "set" && node.arguments.length === 2) {
                        const key = lowerer.expression(node.arguments[0]!), value = lowerer.expression(node.arguments[1]!);
                        return `${receiver}->set(${key}, ${receiver === "_localCache" || receiver === "_ids" ? `*(${value})` : value})`;
                    }
                }
                if (context.expressionMatchesShape(node.expression, "uploadTex")) {
                    if (node.arguments.length !== 5) context.contractError(node, "Expected the extension texture upload.");
                    context.assertExpressionShape(node.arguments[0]!, "engine", "Extension upload engine");
                    context.assertExpressionShape(node.arguments[4]!, "generateMipmaps", "Extension upload mipmaps");
                    return `upload(${node.arguments.slice(1, 4).map(argument => lowerer.expression(argument)).join(", ")})`;
                }
            }
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (ts.isExpressionStatement(statement)) return [`${indent}${lowerer.expression(statement.expression)};`];
            if (!ts.isVariableStatement(statement)) return undefined;
            return statement.declarationList.declarations.map(variable => {
                if (!ts.isIdentifier(variable.name) || !variable.initializer) context.contractError(variable, "Expected an initialized extension cache binding.");
                const name = variable.name.text, initializer = context.unwrapExpression(variable.initializer);
                const rendered = lowerer.expression(initializer);
                const receiver = ts.isCallExpression(initializer) && ts.isPropertyAccessExpression(initializer.expression) &&
                    initializer.expression.name.text === "get" && mapReceiver(initializer.expression.expression);
                if (receiver) nullable.add(name);
                if (receiver === "_localCache") maps.set(name, "GltfSamplerTextures");
                const scalar = receiver === "_ids" || ts.isBinaryExpression(initializer);
                bindings.set(name, { cpp: receiver ? `(*${name})` : name, type: scalar ? "scalar" : "opaque", absentCpp: `!${name}` });
                return `${indent}auto ${name} = ${rendered};`;
            });
        },
        returnValue: (node, lowerer) => lowerer.expression(node!),
    });
    const initial = lowerPinnedBody(file, declaration.body!.statements.slice(1, 4), {
        bindings: new Map([["samplerFor", { cpp: "sampler_for", type: "opaque", absentCpp: "!sampler_for" }]]), calls: new Map(),
        statement(statement, lowerer, indent) {
            if (!ts.isVariableStatement(statement)) return undefined;
            return statement.declarationList.declarations.map(variable => {
                if (!ts.isIdentifier(variable.name) || !variable.initializer) context.contractError(variable, "Expected cache allocation state.");
                const name = variable.name.text, initializer = context.unwrapExpression(variable.initializer), type = maps.get(name);
                if (type) {
                    if (!ts.isConditionalExpression(initializer) || initializer.whenFalse.kind !== ts.SyntaxKind.NullKeyword ||
                        !ts.isNewExpression(initializer.whenTrue) || !context.expressionMatchesShape(initializer.whenTrue.expression, "Map") ||
                        initializer.whenTrue.arguments?.length) context.contractError(initializer, "Expected a conditional texture Map allocation.");
                    return `${indent}auto ${name} = ${lowerer.expression(initializer.condition)} ? std::optional<${type}>{std::in_place} : std::nullopt;`;
                }
                return `${indent}double ${name} = ${lowerer.expression(initializer)};`;
            });
        },
    });
    return `using GltfSamplerTextures = bbl::js::Map<double, GltfMaterialTexture>;
using GltfLocalTextureCache = bbl::js::Map<GltfMaterialSampler, GltfSamplerTextures>;
using GltfTextureImageIds = bbl::js::Map<GltfMaterialImage, double>;
// ${context.provenance(module, "buildDefaultPbrTexturesExt")}
template<class Cached, class Upload> auto gltf_extended_texture_picker(
    std::function<GltfMaterialSampler(const ts::JsonValue*)> sampler_for, Cached cached_texture, Upload upload) {
${initial}
    return [=](GltfMaterialImage image, bool srgb, const ts::JsonValue* info) mutable -> GltfMaterialTexture {
${body}
    };
}`;
}

import ts from "typescript";
import { LoweringContext } from "../context.js";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";
import type { PinnedBinding } from "../pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls, pinnedRoundCall } from "../pinned-operators.js";
import { lowerGltfExtendedTexturePicker, lowerGltfSampledTexture, lowerGltfTextureCache } from "./texture-cache.js";
import { gltfSamplerDeclarations } from "./sampler-resolver.js";

const builderModule = "src/loader-gltf/gltf-pbr-builder.ts";
const extModule = "src/loader-gltf/gltf-pbr-builder-ext.ts";
const textureFields = ["baseColorTexture", "ormTexture", "normalTexture", "emissiveTexture", "occlusionTexture"];

/** Source texture selection produces descriptors; the PAL owns image uploads and GPU caches. */
export function lowerGltfMaterialTextures(context: LoweringContext): string {
    const functions: string[] = [];
    for (const [symbol, signature, parameters] of [
        ["uploadBaseColorFactorTexture", "gltf_base_factor_texture(const std::vector<double>& factor)",
            [["factor", { cpp: "factor", type: "f64-buffer" }]]],
        ["uploadOrmFactorTexture", "gltf_orm_factor_texture(double roughness, double metallic)",
            [["roughness", { cpp: "roughness", type: "scalar" }], ["metallic", { cpp: "metallic", type: "scalar" }]]],
    ] satisfies [string, string, [string, PinnedBinding][]][]) {
        const { file, declaration } = context.functionDeclaration(builderModule, symbol);
        const bindings = new Map<string, PinnedBinding>(parameters);
        const calls = new Map<string, (args: readonly string[]) => string>([
            ...pinnedNumericMathCalls(), ["Math.round", pinnedRoundCall],
            ["linearToSrgbByte", args => `linear_to_srgb_byte(${args.join(", ")})`],
        ]);
        const body = lowerPinnedBody(file, declaration.body!.statements, {
            bindings, calls,
            expression(node, lowerer) {
                if (!ts.isCallExpression(node) || !context.expressionMatchesShape(node.expression, "uploadTex")) return undefined;
                const [engine, bitmap, srgb, sampler, mipmaps, fallback] = node.arguments;
                if (node.arguments.length !== 6 || !engine || !bitmap || !srgb || !sampler || !mipmaps || !fallback || bitmap.kind !== ts.SyntaxKind.NullKeyword)
                    context.contractError(node, "Expected a factor texture upload.");
                context.assertExpressionShape(engine, "engine", "Factor upload engine");
                context.assertExpressionShape(sampler, "sampler", "Factor upload sampler");
                context.assertExpressionShape(mipmaps, "generateMipmaps", "Factor upload mipmaps");
                const bytes = context.unwrapExpression(fallback);
                if (!ts.isNewExpression(bytes) || !context.expressionMatchesShape(bytes.expression, "U8") ||
                    bytes.arguments?.length !== 1 || !ts.isArrayLiteralExpression(bytes.arguments[0]!) || bytes.arguments[0].elements.length !== 4)
                    context.contractError(bytes, "Expected four factor texture bytes.");
                return `GltfMaterialTexture{nullptr, ${lowerer.expression(srgb)}, std::array<std::uint8_t, 4>{${bytes.arguments[0].elements.map(
                    lane => `bbl::js::to_uint8(${lowerer.expression(lane)})`).join(", ")}}, nullptr}`;
            },
            statement(statement, lowerer, indent) {
                if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined;
                const variable = statement.declarationList.declarations[0]!;
                if (!ts.isIdentifier(variable.name) || !variable.initializer || !ts.isArrowFunction(variable.initializer)) return undefined;
                const arrow = variable.initializer, parameter = arrow.parameters[0]?.name;
                if (arrow.parameters.length !== 1 || !parameter || !ts.isIdentifier(parameter) || ts.isBlock(arrow.body))
                    context.contractError(arrow, "Expected a scalar factor conversion.");
                bindings.set(parameter.text, { cpp: parameter.text, type: "scalar" });
                const expression = lowerer.expression(arrow.body);
                bindings.delete(parameter.text);
                const name = variable.name.text;
                calls.set(name, args => `${name}(${args.join(", ")})`);
                return [`${indent}const auto ${variable.name.text} = [](double ${parameter.text}) { return ${expression}; };`];
            },
            returnValue: (node, lowerer) => lowerer.expression(node!),
        });
        functions.push(`// ${context.provenance(builderModule, symbol)}\nGltfMaterialTexture ${signature} {\n${body}\n}`);
    }
    for (const [module, symbol, signature] of [
        [extModule, "occlusionNeedsSplit", "bool gltf_occlusion_needs_split(const JsonObject& raw)"],
        [builderModule, "buildDefaultPbrTextures", "GltfPbrTextures gltf_default_pbr_textures(const GltfCoreMaterial& mat, GltfTextureCache* cache = nullptr, GltfSamplerContext* sampler_context = nullptr)"],
        [extModule, "buildDefaultPbrTexturesExt", "GltfPbrTextures gltf_default_pbr_textures_ext(const GltfCoreMaterial& mat, bool sampled = false, GltfTextureCache* cache = nullptr, GltfSamplerContext* sampler_context = nullptr)"],
        ["src/loader-gltf/gltf-sampler-desc.ts", "buildSampledPbrTextures", "GltfPbrTextures gltf_sampled_pbr_textures(const GltfCoreMaterial& mat, GltfTextureCache* cache = nullptr, GltfSamplerContext* sampler_context = nullptr)"],
    ] as const) {
        const { file, declaration } = context.functionDeclaration(module, symbol);
        const bindings = new Map<string, PinnedBinding>();
        const objects = new Set<string>(symbol === "occlusionNeedsSplit" ? ["raw"] : []);
        const pointers = new Set<string>();
        const types = new Map<string, string>();
        for (const name of ["_baseColorImage", "_metallicRoughnessImage", "_normalImage", "_occlusionImage", "_emissiveImage"])
            bindings.set(`mat.${name}`, { cpp: `mat.${name}`, type: "opaque", absentCpp: `!mat.${name}` });
        for (const name of ["_metallicFactor", "_roughnessFactor", "_occlusionTexCoord"])
            bindings.set(`mat.${name}`, { cpp: `mat.${name}`, type: "scalar" });
        bindings.set("mat._baseColorFactor", { cpp: "mat._baseColorFactor", type: "f64-buffer" });
        const jsonPath = (expression: ts.Expression): string | undefined => {
            const keys: string[] = [];
            let node = context.unwrapExpression(expression);
            while (ts.isPropertyAccessExpression(node)) {
                keys.unshift(node.name.text);
                node = context.unwrapExpression(node.expression);
            }
            if (!ts.isIdentifier(node) || !keys.length) return undefined;
            const root = objects.has(node.text) ? node.text : pointers.has(node.text) ? `gltf_material_object(${node.text})` : undefined;
            return root ? `gltf_json_path(${root}, {${keys.map(key => JSON.stringify(key)).join(", ")}})` : undefined;
        };
        const nativeType = (expression: ts.Expression): string => {
            const node = context.unwrapExpression(expression);
            if (ts.isIdentifier(node) && types.has(node.text)) return types.get(node.text)!;
            if (jsonPath(node)) return "const ts::JsonValue*";
            if (ts.isPropertyAccessExpression(node) && node.name.text.endsWith("Image")) return "GltfMaterialImage";
            if (ts.isConditionalExpression(node)) return nativeType(node.whenTrue);
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) return nativeType(node.left);
            if (ts.isBinaryExpression(node)) return "bool";
            return "GltfMaterialTexture";
        };
        let statements: readonly ts.Statement[] = declaration.body!.statements;
        if (symbol === "buildDefaultPbrTexturesExt") {
            // Cache state and pickTex are emitted by lowerGltfExtendedTexturePicker.
            const resourceBindings = ["wrap", "_localCache", "_ids", "_nextId", "pickTex"];
            for (const [index, name] of resourceBindings.entries()) {
                const statement = statements[index];
                const variable = statement && ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
                    ? statement.declarationList.declarations[0] : undefined;
                if (!variable || !ts.isIdentifier(variable.name) || variable.name.text !== name)
                    context.contractError(statement ?? declaration, "Expected the texture upload and wrapper boundary.");
            }
            statements = statements.slice(resourceBindings.length);
        }
        const body = lowerPinnedBody(file, statements, {
            bindings, calls: new Map(), booleanAnd: true, booleanOr: true,
            expression(node, lowerer) {
                if (node.kind === ts.SyntaxKind.NullKeyword) return "nullptr";
                if (ts.isIdentifier(node) && node.text === "undefined") return "GltfMaterialTexture{}";
                if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
                    const left = lowerer.expression(node.left);
                    return `(${left} ? ${left} : ${lowerer.expression(node.right)})`;
                }
                if (ts.isBinaryExpression(node) && node.right.kind === ts.SyntaxKind.NullKeyword &&
                    [ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(node.operatorToken.kind)) {
                    const left = jsonPath(node.left);
                    if (left) return `(${left} ${node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken ? "!=" : "=="} nullptr)`;
                }
                if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
                    const args = node.arguments, name = node.expression.text;
                    const argument = (index: number) => {
                        const value = args[index];
                        if (!value) context.contractError(node, "Missing texture builder argument.");
                        return lowerer.expression(value);
                    };
                    if (name === "getCachedTex" && args.length === 2) return `gltf_cached_material_texture(tex_cache, ${argument(0)}, ${argument(1)}, sampler_context ? sampler_context->default_sampler : nullptr)`;
                    if (name === "pickTex" && args.length === 3)
                        return `pick_texture(${argument(0)}, ${argument(1)}, ${argument(2)})`;
                    if (name === "cached" && symbol === "buildSampledPbrTextures" && args.length === 3)
                        return `gltf_sampled_material_texture(tex_cache, ${argument(0)}, ${argument(1)}, ${argument(2)}, *sampler_context)`;
                    if (name === "wrap" && args.length === 2) return `gltf_wrap_material_texture(${argument(0)}, ${argument(1)})`;
                    if (name === "uploadBaseColorFactorTexture" && args.length === 4) return `gltf_base_factor_texture(${argument(1)})`;
                    if (name === "uploadOrmFactorTexture" && args.length === 5) return `gltf_orm_factor_texture(${argument(1)}, ${argument(2)})`;
                    if (name === "occlusionNeedsSplit" && args.length === 1) return `gltf_occlusion_needs_split(${argument(0)})`;
                }
                const path = jsonPath(node);
                return path && ts.isPropertyAccessExpression(node) && node.name.text === "index" ? `gltf_json_number(${path})` : path;
            },
            statement(statement, lowerer, indent) {
                if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined;
                const variable = statement.declarationList.declarations[0]!;
                if (!ts.isIdentifier(variable.name)) return undefined;
                const name = variable.name.text, init = variable.initializer && context.unwrapExpression(variable.initializer);
                if (symbol === "buildSampledPbrTextures" && name === "cached" && init && ts.isArrowFunction(init)) {
                    // The closure is emitted by lowerGltfSampledTexture.
                    return [];
                }
                if (init && ts.isBinaryExpression(init) && init.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
                    ts.isObjectLiteralExpression(init.right) && init.right.properties.length === 0) {
                    const pointer = context.expressionMatchesShape(init.left, "mat._rawMatDef") ? "mat._rawMatDef" : jsonPath(init.left);
                    if (!pointer) context.contractError(init, "Expected a raw material JSON object.");
                    objects.add(name);
                    bindings.set(name, { cpp: name, type: "opaque" });
                    return [`${indent}const JsonObject& ${name} = gltf_material_object(${pointer});`];
                }
                const type = init ? nativeType(init) : "GltfMaterialTexture";
                types.set(name, type);
                if (type === "const ts::JsonValue*") pointers.add(name);
                const rendered = init ? lowerer.expression(init) : "{}";
                bindings.set(name, { cpp: name, type: type === "bool" ? "bool" : "opaque",
                    ...(type !== "bool" ? { absentCpp: `!${name}` } : {}) });
                return [`${indent}${type} ${name} = ${rendered};`];
            },
            returnValue(node, lowerer) {
                if (symbol === "occlusionNeedsSplit") return lowerer.expression(node!);
                const returned = node && context.unwrapExpression(node);
                if (!returned || !ts.isObjectLiteralExpression(returned)) context.contractError(declaration, "Expected PBR texture slots.");
                const seen = new Set<string>();
                const assignments = returned.properties.map(property => {
                    if (!ts.isShorthandPropertyAssignment(property) && !ts.isPropertyAssignment(property))
                        context.contractError(property, "Unsupported PBR texture slot.");
                    if (!ts.isIdentifier(property.name) || !textureFields.includes(property.name.text) || seen.has(property.name.text))
                        context.contractError(property, "Unrepresented PBR texture slot.");
                    seen.add(property.name.text);
                    return `result.${property.name.text} = ${lowerer.expression(ts.isPropertyAssignment(property) ? property.initializer : property.name)};`;
                });
                if (seen.size !== (symbol === "buildDefaultPbrTexturesExt" ? 5 : 4)) context.contractError(returned, "Incomplete PBR texture slots.");
                return `[&]() { GltfPbrTextures result; ${assignments.join(" ")} return result; }()`;
            },
        });
        const cache = symbol === "occlusionNeedsSplit" ? "" :
            (symbol === "buildSampledPbrTextures" ? "    if (!sampler_context) throw std::runtime_error(\"Missing glTF sampler context.\");\n" :
                symbol === "buildDefaultPbrTexturesExt" ? "    if (sampled && !sampler_context) throw std::runtime_error(\"Missing glTF sampler context.\");\n" : "") +
            "    std::optional<GltfTextureCache> local_cache;\n" +
            "    if (!cache) { local_cache.emplace(); cache = &*local_cache; }\n" +
            "    GltfTextureCache& tex_cache = *cache;\n";
        const picker = symbol !== "buildDefaultPbrTexturesExt" ? "" : `    std::function<GltfMaterialSampler(const ts::JsonValue*)> sampler_for;
    if (sampled) sampler_for = [sampler_context](const ts::JsonValue* info) { return sampler_context->resolve(info); };
    auto pick_texture = gltf_extended_texture_picker(std::move(sampler_for),
        [&](GltfMaterialImage image, bool srgb) { return gltf_cached_material_texture(tex_cache, std::move(image), srgb, sampler_context ? sampler_context->default_sampler : nullptr); },
        [](GltfMaterialImage image, bool srgb, GltfMaterialSampler sampler) { return GltfMaterialTexture{std::move(image), srgb, std::nullopt, nullptr, std::move(sampler)}; });
`;
        functions.push(`// ${context.provenance(module, symbol)}\n${signature} {\n${cache}${picker}${body}\n}`);
    }
    return `${gltfSamplerDeclarations}
struct GltfPbrObject;
struct GltfTextureIdentity { std::weak_ptr<GltfPbrObject> value; };
struct GltfMaterialTexture {
    GltfMaterialImage image;
    bool srgb = false;
    std::optional<std::array<std::uint8_t, 4>> fallback;
    const ts::JsonValue* info = nullptr;
    GltfMaterialSampler sampler = nullptr;
    std::shared_ptr<GltfTextureIdentity> identity = image || fallback ? std::make_shared<GltfTextureIdentity>() : nullptr;
    explicit operator bool() const { return image || fallback.has_value(); }
    GltfMaterialTexture clone() const {
        auto result = *this;
        if (result) result.identity = std::make_shared<GltfTextureIdentity>();
        return result;
    }
};
struct GltfPbrTextures {
${textureFields.map(name => `    GltfMaterialTexture ${name};`).join("\n")}
};
${lowerGltfTextureCache(context)}
${lowerGltfSampledTexture(context)}
${lowerGltfExtendedTexturePicker(context)}
GltfMaterialTexture gltf_cached_material_texture(GltfTextureCache& cache, GltfMaterialImage image, bool srgb, GltfMaterialSampler sampler = nullptr) {
    return gltf_cached_texture(cache, std::move(image), srgb, [&](GltfMaterialImage bitmap, bool encoded) {
        return GltfMaterialTexture{std::move(bitmap), encoded, std::nullopt, nullptr, sampler};
    });
}
GltfMaterialTexture gltf_sampled_material_texture(GltfTextureCache& cache, GltfMaterialImage image, bool srgb, const ts::JsonValue* info, GltfSamplerContext& context) {
    auto texture = gltf_sampled_texture(std::move(image), srgb, info, context.default_sampler,
        [&](const ts::JsonValue* selected) { return context.resolve(selected); },
        [&](GltfMaterialImage bitmap, bool encoded) { return gltf_cached_material_texture(cache, std::move(bitmap), encoded, context.default_sampler); },
        [](const GltfMaterialTexture&, const GltfMaterialTexture&) {});
    texture.info = info;
    return texture;
}
GltfMaterialTexture gltf_wrap_material_texture(GltfMaterialTexture texture, const ts::JsonValue* info) {
    texture.info = info;
    return texture;
}
${functions.join("\n")}`;
}

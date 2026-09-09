import ts from "typescript";
import { LoweringContext } from "../context.js";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";
import type { PinnedBinding, PinnedNumericLowerer } from "../pinned-numeric-lowerer.js";
import { gltfLoadPromise } from "./load-promise.js";

export const gltfCoreMaterialFields = new Map([
    ["_baseColorFactor", "std::vector<double>"], ["_metallicFactor", "double"], ["_roughnessFactor", "double"],
    ["_emissiveFactor", "std::vector<double>"], ["_baseColorImage", "GltfMaterialImage"],
    ["_metallicRoughnessImage", "GltfMaterialImage"], ["_normalImage", "GltfMaterialImage"],
    ["_normalScale", "double"], ["_occlusionTexCoord", "double"], ["_occlusionImage", "GltfMaterialImage"],
    ["_emissiveImage", "GltfMaterialImage"], ["_doubleSided", "bool"], ["_alphaMode", "std::string"],
    ["_alphaCutoff", "double"], ["_rawMatDef", "const ts::JsonValue*"],
]);
const fields = gltfCoreMaterialFields;

/** Complete core material assembly; image handles name packaged source images. */
export function lowerGltfMaterialAssembly(context: LoweringContext): string {
    const module = "src/loader-gltf/gltf-material.ts";
    const { file, declaration } = context.functionDeclaration(module, "assembleMaterial");
    const bindings = new Map<string, PinnedBinding>();
    const objects = new Map<string, string>();
    const imageFetchers = new Set<string>();
    const parameters = declaration.parameters.map(parameter => {
        if (!ts.isIdentifier(parameter.name)) context.contractError(parameter, "Expected named material inputs.");
        return parameter.name.text;
    });
    if (parameters.length !== 5) context.contractError(declaration, "Expected the five core material inputs.");
    objects.set(parameters[0]!, "json");
    bindings.set(parameters[2]!, { cpp: "material_index", type: "index" });
    const jsonPath = (expression: ts.Expression): string | undefined => {
        const keys: string[] = [];
        let node = context.unwrapExpression(expression);
        while (ts.isPropertyAccessExpression(node)) {
            keys.unshift(node.name.text);
            node = context.unwrapExpression(node.expression);
        }
        const root = ts.isIdentifier(node) && objects.get(node.text);
        return root && keys.length ? `gltf_json_path(${root}, {${keys.map(key => JSON.stringify(key)).join(", ")}})` : undefined;
    };
    const value = (expression: ts.Expression, type: string, lowerer: PinnedNumericLowerer): string => {
        const node = context.unwrapExpression(expression);
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
            const left = jsonPath(node.left);
            if (left) return `(${left} ? ${value(node.left, type, lowerer)} : ${value(node.right, type, lowerer)})`;
        }
        if (ts.isConditionalExpression(node)) return `(${lowerer.expression(node.condition)} ? ${value(node.whenTrue, type, lowerer)} : ${value(node.whenFalse, type, lowerer)})`;
        const property = jsonPath(node);
        if (property) {
            if (type === "std::vector<double>") return `double_array(${property})`;
            if (type === "std::string") return `${property}->as_string()`;
            if (type === "double") return `gltf_json_number(${property})`;
        }
        if (ts.isArrayLiteralExpression(node)) {
            if (type !== "std::vector<double>") context.contractError(node, "Unexpected material array storage.");
            return `std::vector<double>{${node.elements.map(element => lowerer.expression(element)).join(", ")}}`;
        }
        if (ts.isStringLiteralLike(node)) return `std::string{${JSON.stringify(node.text)}}`;
        return lowerer.expression(node);
    };
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings, calls: new Map(),
        expression(node, lowerer) {
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && jsonPath(node.left))
                return value(node, "double", lowerer);
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
                ts.isTypeOfExpression(context.unwrapExpression(node.left)) && ts.isStringLiteral(node.right) && node.right.text === "number") {
                const left = context.unwrapExpression(node.left);
                if (!ts.isTypeOfExpression(left)) return undefined;
                const property = jsonPath(left.expression);
                if (property) return `(${property} && ${property}->is_number())`;
            }
            if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
                const operand = context.unwrapExpression(node.operand);
                if (ts.isPrefixUnaryExpression(operand) && operand.operator === ts.SyntaxKind.ExclamationToken) {
                    const property = jsonPath(operand.operand);
                    if (property) return `gltf_material_truthy(${property})`;
                }
            }
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && imageFetchers.has(node.expression.text)) {
                if (node.arguments.length !== 1) context.contractError(node, "Expected one material texture info.");
                const property = jsonPath(node.arguments[0]!);
                if (!property) context.contractError(node, "Expected a material texture property.");
                return `${node.expression.text}(${property})`;
            }
            const property = jsonPath(node);
            return property ? `gltf_json_number(${property})` : undefined;
        },
        statement(statement, lowerer, indent) {
            if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined;
            const variable = statement.declarationList.declarations[0]!;
            if (!variable.initializer) return undefined;
            const initializer = context.unwrapExpression(variable.initializer);
            if (ts.isArrayBindingPattern(variable.name)) {
                const awaited = ts.isAwaitExpression(initializer) && context.unwrapExpression(initializer.expression);
                if (!awaited || !ts.isCallExpression(awaited) || !context.expressionMatchesShape(awaited.expression, "Promise.all") ||
                    awaited.arguments.length !== 1 || !ts.isArrayLiteralExpression(awaited.arguments[0]!))
                    context.contractError(variable, "Expected concurrent core material image reads.");
                const reads = awaited.arguments[0].elements;
                if (reads.length !== variable.name.elements.length) context.contractError(variable, "Material image arity changed.");
                const collected = "material_image_promises";
                return [`${indent}const std::array ${collected}{${reads.map(read => lowerer.expression(read)).join(", ")}};`, ...variable.name.elements.map((element, index) => {
                    if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name) || element.dotDotDotToken || element.initializer)
                        context.contractError(element, "Expected a named image result.");
                    bindings.set(element.name.text, { cpp: element.name.text, type: "opaque", absentCpp: `${element.name.text} == nullptr` });
                    return `${indent}const auto ${element.name.text} = ${collected}[${index}].get();`;
                })];
            }
            if (!ts.isIdentifier(variable.name)) return undefined;
            const name = variable.name.text;
            if (ts.isElementAccessExpression(initializer) && initializer.argumentExpression &&
                context.expressionMatchesShape(initializer.expression, `${parameters[0]}.materials`)) {
                bindings.set(name, { cpp: name, type: "opaque", absentCpp: `${name} == nullptr` });
                return [`${indent}const ts::JsonValue* ${name} = gltf_material_at(json, ${lowerer.expression(initializer.argumentExpression)});`];
            }
            if (ts.isBinaryExpression(initializer) && initializer.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
                ts.isObjectLiteralExpression(initializer.right) && initializer.right.properties.length === 0) {
                const left = jsonPath(initializer.left) ?? lowerer.expression(initializer.left);
                objects.set(name, name);
                bindings.set(name, { cpp: name, type: "opaque" });
                return [`${indent}const JsonObject& ${name} = gltf_material_object(${left});`];
            }
            if (ts.isCallExpression(initializer) && context.expressionMatchesShape(initializer.expression, "makeImageFetcher")) {
                context.assertExpressionShape(initializer, `makeImageFetcher(${parameters[0]}, ${parameters[1]}, ${parameters[3]}, ${parameters[4]})`, "Material image environment");
                imageFetchers.add(name);
                return [`${indent}const auto ${name} = make_gltf_image_fetcher(json, image_cache, resolve_image);`];
            }
            return undefined;
        },
        returnValue(expression, lowerer) {
            const returned = expression && context.unwrapExpression(expression);
            if (!returned || !ts.isObjectLiteralExpression(returned)) context.contractError(declaration, "Expected the core material record.");
            const seen = new Set<string>();
            const stores = returned.properties.map(property => {
                if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) context.contractError(property, "Unsupported core material member.");
                const name = property.name.text, type = fields.get(name);
                if (!type || seen.has(name)) context.contractError(property, `Unrepresented core material member '${name}'.`);
                seen.add(name);
                return `result.${name} = ${value(property.initializer, type, lowerer)};`;
            });
            if (seen.size !== fields.size) context.contractError(returned, "The core material record is incomplete.");
            return `[&]() { GltfCoreMaterial result; ${stores.join(" ")} return result; }()`;
        },
    });
    const { declaration: fetcher } = context.functionDeclaration(module, "makeImageFetcher");
    const returnedFetcher = fetcher.body?.statements[0];
    if (fetcher.body?.statements.length !== 1 || !returnedFetcher || !ts.isReturnStatement(returnedFetcher) ||
        !returnedFetcher.expression || !ts.isArrowFunction(returnedFetcher.expression) || !ts.isBlock(returnedFetcher.expression.body))
        context.contractError(fetcher, "Expected the per-load material image fetcher.");
    const arrow = returnedFetcher.expression;
    if (!ts.isBlock(arrow.body)) context.contractError(arrow, "Expected a material image fetch body.");
    const texture = arrow.parameters[0]?.name;
    if (arrow.parameters.length !== 1 || !texture || !ts.isIdentifier(texture)) context.contractError(arrow, "Expected a texture info input.");
    const fetchBindings = new Map<string, PinnedBinding>([[texture.text, {
        cpp: "texture_info", type: "opaque", absentCpp: "texture_info == nullptr",
    }]]);
    const fetchBody = lowerPinnedBody(file, arrow.body.statements, {
        bindings: fetchBindings, calls: new Map(), booleanOr: true,
        expression(node, lowerer) {
            if (context.expressionMatchesShape(node, "Promise.resolve(null)")) return "GltfMaterialImagePromise{GltfMaterialImage{}}";
            if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === texture.text)
                return `gltf_json_number(gltf_json_path(texture_info->as_object(), {${JSON.stringify(node.name.text)}}))`;
            if (ts.isCallExpression(node) && context.expressionMatchesShape(node.expression, "getTextureImageIndex")) {
                context.assertExpressionShape(node, `getTextureImageIndex(json.textures[${texture.text}.index])`, "Material image source selection");
                return 'texture_image_index(gltf_array_or_empty(json, "textures").at(gltf_checked_index(gltf_json_number(gltf_json_path(texture_info->as_object(), {"index"})))).as_object())';
            }
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken &&
                ts.isElementAccessExpression(node.left) && context.expressionMatchesShape(node.left.expression, "imageCache") &&
                node.left.argumentExpression && ts.isCallExpression(node.right)) {
                const index = lowerer.expression(node.left.argumentExpression);
                context.assertExpressionShape(node.right, `resolveImage(json, binChunk, ${node.left.argumentExpression.getText(file)}, baseUrl)`, "Material image resolution");
                return `gltf_cached_material_image(image_cache, ${index}, resolve_image)`;
            }
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined;
            const variable = statement.declarationList.declarations[0]!;
            if (!ts.isIdentifier(variable.name) || !variable.initializer) return undefined;
            fetchBindings.set(variable.name.text, { cpp: variable.name.text, type: "index" });
            return [`${indent}const std::size_t ${variable.name.text} = ${lowerer.expression(variable.initializer)};`];
        },
        returnValue: (expression, lowerer) => lowerer.expression(expression!),
    });
    return `${gltfLoadPromise}
struct GltfMaterialImageSource {
    std::size_t index;
    std::shared_ptr<const pal::DecodedImage> decoded;
    explicit GltfMaterialImageSource(std::size_t value) : index(value) {}
    explicit GltfMaterialImageSource(pal::DecodedImage value)
        : index(std::numeric_limits<std::size_t>::max()), decoded(std::make_shared<const pal::DecodedImage>(std::move(value))) {}
};
using GltfMaterialImage = std::shared_ptr<const GltfMaterialImageSource>;
using GltfMaterialImagePromise = GltfLoadPromise<GltfMaterialImage>;
using GltfMaterialImageCache = std::unordered_map<std::size_t, GltfMaterialImagePromise>;
struct GltfCoreMaterial {
${[...fields].map(([name, type]) => `    ${type} ${name}{};`).join("\n")}
};
const ts::JsonValue* gltf_material_at(const JsonObject& json, std::size_t index) {
    const auto& materials = gltf_array_or_empty(json, "materials");
    return index < materials.size() && !materials[index].is_null() ? &materials[index] : nullptr;
}
const JsonObject& gltf_material_object(const ts::JsonValue* value) {
    static const JsonObject empty;
    return value && !value->is_null() ? value->as_object() : empty;
}
bool gltf_material_truthy(const ts::JsonValue* value) {
    return value && value->truthy();
}
template <typename ResolveImage>
GltfMaterialImagePromise gltf_cached_material_image(GltfMaterialImageCache& cache, std::size_t index, ResolveImage& resolve_image) {
    auto& image = cache[index];
    if (!image) image = GltfMaterialImagePromise::settle([&] { return resolve_image(index); });
    return image;
}
// ${context.provenance(module, "makeImageFetcher")}
template <typename ResolveImage>
auto make_gltf_image_fetcher(const JsonObject& json, GltfMaterialImageCache& image_cache, ResolveImage& resolve_image) {
    return [&](const ts::JsonValue* texture_info) -> GltfMaterialImagePromise {
${fetchBody}
    };
}
// ${context.provenance(module, "assembleMaterial")}
template <typename ResolveImage>
GltfCoreMaterial assemble_gltf_material(const JsonObject& json, std::size_t material_index,
    GltfMaterialImageCache& image_cache, ResolveImage& resolve_image) {
${body}
}`;
}

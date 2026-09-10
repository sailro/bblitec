import ts from "typescript";
import { LoweringContext } from "../context.js";
import { lowerGltfMaterialObjectFunction, type GltfMaterialFunction } from "./material-object-lowerer.js";
import { gltfMaterialValueRuntime } from "./material-value-runtime.js";
import { gltfCoreMaterialFields } from "./material-assembly.js";
import { lowerGltfMaterialSetup } from "./material-setup.js";
import { lowerGltfSamplers } from "./sampler-resolver.js";
import { lowerGltfExtensionImages } from "./extension-images.js";
import { lowerGltfOrmComposition } from "./orm-composition.js";
import {lowerPbrSceneHookRegistry} from "../pbr-scene-hooks.js";

const setters = [
    ["set-clearcoat", "setPbrClearCoat"], ["set-sheen", "setPbrSheen"], ["set-iridescence", "setPbrIridescence"],
    ["set-unlit", "setPbrUnlit"], ["set-emissive", "setPbrEmissive"], ["set-alpha-cutoff", "setPbrAlphaCutoff"],
    ["set-transmission", "setPbrTransmission"], ["set-dispersion", "setPbrDispersion"],
    ["set-metallic-reflectance", "setPbrMetallicReflectance"], ["enable-material-uv-transform", "enableMaterialUvTransform"],
    ["set-anisotropy", "setPbrAnisotropy"], ["set-subsurface", "setPbrSubsurface"],
] as const;

/** Property builders and extension setters share one object/array lowering. */
export function lowerGltfMaterialProperties(context: LoweringContext): {
    source: string; functions: readonly GltfMaterialFunction[];
    features: readonly { handler: GltfMaterialFunction; trigger: GltfMaterialFunction }[];
    textureWrapTriggers: readonly GltfMaterialFunction[];
} {
    const functions: GltfMaterialFunction[] = [];
    const add = (module: string, name: string, method = false) => {
        const candidates = method ? context.findNodes(context.sourceFile(module), (node): node is ts.MethodDeclaration =>
            ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) : [];
        const declaration = method ? candidates[0] : context.functionDeclaration(module, name).declaration;
        if (!declaration || (method && candidates.length !== 1)) context.contractError(context.sourceFile(module), "Expected one material method.");
        const contextName = method && name === "applyMaterial" ? declaration.parameters[1]?.name : undefined;
        if (contextName && !ts.isIdentifier(contextName)) context.contractError(contextName, "Expected a material texture context.");
        const cpp = `gltf_pbr_${module.slice(module.lastIndexOf("/") + 1, -3).replaceAll("-", "_")}_${name}`;
        functions.push({ module, name, cpp, declaration, ...(contextName ? { contextParameter: contextName.text } : {}) });
    };
    for (const [file, name] of setters) add(`src/material/pbr/${file}.ts`, name);
    add("src/loader-gltf/animation-pointer-ext.ts", "iorToF0Factor");
    for (const file of ["gltf-pbr-builder", "gltf-pbr-builder-ext"])
        add(`src/loader-gltf/${file}.ts`, "isDefaultBaseColorFactor");
    add("src/loader-gltf/gltf-ext-uv-transform.ts", "wrapTexture", true);
    add("src/loader-gltf/gltf-pbr-builder-ext.ts", "wrapTexCoord");
    add("src/loader-gltf/gltf-pbr-builder.ts", "needsGltfEmissive");
    add("src/loader-gltf/gltf-pbr-builder.ts", "assemblePbrProps");
    add("src/loader-gltf/gltf-pbr-builder.ts", "applyGltfOptInPbrFeatures");
    add("src/loader-gltf/gltf-pbr-builder-ext.ts", "needsGltfUvTransform");
    add("src/loader-gltf/gltf-pbr-builder-ext.ts", "assemblePbrPropsExt");
    add("src/loader-gltf/gltf-pbr-builder-ext.ts", "applyGltfUvTransform");
    add("src/loader-gltf/gltf-parser.ts", "getTextureImageIndex");
    add("src/loader-gltf/gltf-parser.ts", "needsOrmComposite");
    for (const file of ["gltf-ext-clearcoat", "gltf-ext-iridescence", "gltf-ext-emissive-strength", "gltf-ext-sheen",
        "gltf-ext-anisotropy", "gltf-ext-diffuse-transmission", "gltf-ext-unlit", "gltf-ext-spec-gloss", "gltf-ext-dielectric", "gltf-ext-orm"])
        add(`src/loader-gltf/${file}.ts`, "applyMaterial", true);
    add("src/loader-gltf/animation-pointer-basecolor.ts", "whiteFallback");
    add("src/loader-gltf/gltf-feature-animation-pointer.ts", "applyMaterial", true);
    for (const target of functions.slice(-2)) {
        const declaration = target.declaration;
        const file = ts.createSourceFile(target.module, `function ${target.name}(${[
            ...declaration.parameters.map(parameter => parameter.getText()), "pointerContext",
        ].join(", ")}) ${declaration.body!.getText()}`, ts.ScriptTarget.Latest, true);
        const lowered = file.statements[0];
        if (!lowered || !ts.isFunctionDeclaration(lowered)) context.contractError(declaration, "Expected a source pointer material function.");
        target.declaration = lowered;
        target.contextParameter = "pointerContext";
    }
    const registryModule = "src/loader-gltf/gltf-feature-registry.ts";
    const registry = context.sourceFile(registryModule);
    const constants = new Map<string, string>();
    for (const statement of registry.statements) if (ts.isVariableStatement(statement))
        for (const variable of statement.declarationList.declarations)
            if (ts.isIdentifier(variable.name) && variable.initializer && ts.isStringLiteralLike(variable.initializer))
                constants.set(variable.name.text, variable.initializer.text);
    const table = context.findNodes(registry, (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "_features")[0];
    if (!table?.initializer || !ts.isArrayLiteralExpression(table.initializer)) context.contractError(registry, "Expected a glTF feature registry.");
    const features: { handler: GltfMaterialFunction; trigger: GltfMaterialFunction }[] = [];
    const textureWrapTriggers: GltfMaterialFunction[] = [];
    for (const row of table.initializer.elements) {
        if (!ts.isArrayLiteralExpression(row) || row.elements.length !== 2) context.contractError(row, "Expected a glTF feature row.");
        const imports = context.findNodes(row.elements[1]!, (node): node is ts.CallExpression =>
            ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword);
        if (imports.length !== 1 || imports[0]!.arguments.length !== 1 || !ts.isStringLiteralLike(imports[0]!.arguments[0]!))
            context.contractError(row, "Expected one glTF feature import.");
        const module = `src/loader-gltf/${imports[0]!.arguments[0].text.replace(/^\.\//, "").replace(/\.js$/, ".ts")}`;
        const handler = functions.find(target => target.module === module && target.name === "applyMaterial");
        const textureWrap = functions.some(target => target.module === module && target.name === "wrapTexture");
        if (!handler && !textureWrap) continue;
        const expression = row.elements[0]!;
        const name = handler ? `gltf_pbr_feature_${features.length}` : `gltf_pbr_texture_wrap_${textureWrapTriggers.length}`;
        const parameter = ts.isArrowFunction(expression) ? expression.parameters[0]?.name : undefined;
        if (parameter && !ts.isIdentifier(parameter)) context.contractError(parameter, "Expected a feature document parameter.");
        const predicate = ts.isIdentifier(expression) && functions.some(target => target.name === expression.text &&
            target.module === context.moduleOfImport(registryModule, expression.text));
        const body = ts.isArrowFunction(expression)
            ? ts.isBlock(expression.body) ? expression.body.getText() : `{ return ${expression.body.getText()}; }`
            : predicate ? `{ return ${expression.getText()}(document); }`
            : `{ return (document.extensionsUsed ?? []).includes(${expression.getText()}); }`;
        const file = ts.createSourceFile(registryModule, `function ${name}(${parameter?.getText() ?? "document"}) ${body}`, ts.ScriptTarget.Latest, true);
        const declaration = file.statements[0];
        if (!declaration || !ts.isFunctionDeclaration(declaration)) context.contractError(row, "Expected a material feature predicate.");
        const trigger: GltfMaterialFunction = { module: registryModule, name, cpp: name, declaration, constants };
        functions.push(trigger);
        if (handler) features.push({ handler, trigger });
        if (textureWrap) textureWrapTriggers.push(trigger);
    }
    if (features.length !== functions.filter(target => target.name === "applyMaterial").length)
        context.contractError(registry, "A lowered material handler is missing from the feature registry.");
    add(registryModule, "runGltfMaterialFeatures");
    functions[functions.length - 1]!.contextParameter = "ctx";
    const bodies = functions.map(target => lowerGltfMaterialObjectFunction(context, target, name =>
        (functions.find(candidate => candidate.module === target.module && candidate.name === name) ??
            functions.find(candidate => candidate.name === name))?.cpp, (call, lowerer) => {
                if (target.name === "whiteFallback" && context.expressionMatchesShape(call.expression, "_animBaseColorDefs?.has")) {
                    if (call.arguments.length !== 1) context.contractError(call, "Expected source base-color definition membership.");
                    context.assertExpressionShape(call.arguments[0]!, "mat._rawMatDef", "Source animation base-color owner");
                    return "GltfPbrValue{pointerContext.base_color_definition}";
                }
                if (target.module === "src/loader-gltf/gltf-feature-animation-pointer.ts" &&
                    context.expressionMatchesShape(call.expression, "_baseColorMod?.whiteFallback")) {
                    if (call.arguments.length !== 1) context.contractError(call, "Expected the source base-color material feature call.");
                    const handler = functions.find(target => target.name === "whiteFallback")!;
                    return `(pointerContext.base_color_module ? ${handler.cpp}(${lowerer.expression(call.arguments[0]!)}, pointerContext) : GltfPbrValue{})`;
                }
                if (target.module !== "src/loader-gltf/gltf-ext-orm.ts" || !context.expressionMatchesShape(call.expression, "compositeOrm")) return undefined;
                if (call.arguments.length !== 2 || !target.contextParameter) context.contractError(call, "Expected two ORM bitmaps and their image context.");
                return `gltf_pbr_composite_orm(${target.contextParameter}, ${call.arguments.map(argument => lowerer.expression(argument)).join(", ")})`;
            }));
    const setup = lowerGltfMaterialSetup(context, name => functions.find(target => target.name === name)?.cpp);
    return { functions: [...functions, ...setup.functions], features, textureWrapTriggers, source: `${lowerPbrSceneHookRegistry(context)}
${gltfMaterialValueRuntime}
struct GltfPbrContext {
    bool base_color_module = false;
    bool base_color_definition = false;
    std::function<GltfPbrValue(const GltfPbrValue&, bool)> texture;
    std::function<GltfPbrValue(const GltfPbrValue&, bool)> upload_image;
    std::function<pal::DecodedImage(const GltfMaterialImage&)> decode_image;
    std::function<GltfPbrValue(const GltfPbrValue&)> default_textures;
    std::function<GltfPbrValue(const GltfPbrValue&)> sampled_textures;
    std::function<GltfPbrValue(const GltfPbrValue&)> extended_textures;
};
${lowerGltfOrmComposition(context)}
GltfPbrValue gltf_pbr_composite_orm(const GltfPbrContext& context, const GltfPbrValue& mr, const GltfPbrValue& occ) {
    if (!context.decode_image) throw std::runtime_error("Missing glTF bitmap decoder.");
    const auto mr_image = context.decode_image(mr.image());
    const auto occ_image = context.decode_image(occ.image());
    return GltfPbrValue{std::make_shared<GltfMaterialImageSource>(gltf_composite_orm(mr_image, occ_image))};
}
GltfPbrValue gltf_pbr_apply_feature(GltfPbrValue feature, GltfPbrValue material, const GltfPbrContext& context);
${lowerGltfExtensionImages(context)}
${lowerGltfExtensionImages(context, true)}
${bodies.join("\n")}
${setup.source}
${lowerGltfSamplers(context)}
bool gltf_pbr_has_texture_wrap(GltfPbrValue document) {
    return ${textureWrapTriggers.map(trigger => `${trigger.cpp}(document).truthy()`).join(" || ") || "false"};
}
GltfPbrValue gltf_pbr_apply_feature(GltfPbrValue feature, GltfPbrValue material, const GltfPbrContext& context) {
${features.map(({handler}, index) => `    if (feature.number() == ${index}.0) return ${handler.cpp}(material${handler.contextParameter ? ", context" : ""});`).join("\n")}
    throw std::runtime_error("Unknown glTF material feature.");
}
GltfPbrValue gltf_pbr_material_features(GltfPbrValue document) {
    auto result = GltfPbrValue::array({});
${features.map(({trigger}, index) => `    if (${trigger.cpp}(document).truthy()) result.push(GltfPbrValue{${index}.0});`).join("\n")}
    return result;
}
GltfPbrValue gltf_pbr_core_value(const GltfCoreMaterial& core) {
    auto result = GltfPbrValue::object();
${[...gltfCoreMaterialFields.keys()].map(name => `    result.set("${name}", GltfPbrValue{core.${name}});`).join("\n")}
    return result;
}
GltfCoreMaterial gltf_pbr_core_storage(const GltfPbrValue& value) {
    GltfCoreMaterial core;
${[...gltfCoreMaterialFields].map(([name, type]) => {
    const access = `value.get(${JSON.stringify(name)})`;
    const expression = type === "std::vector<double>" ? `*${access}.numeric_array()` : type === "double" ? `${access}.number()`
        : type === "bool" ? `${access}.truthy()` : type === "std::string" ? `${access}.string()`
        : type === "GltfMaterialImage" ? `${access}.nullish() ? GltfMaterialImage{} : ${access}.image()` : `${access}.source()`;
    return `    core.${name} = ${expression};`;
}).join("\n")}
    return core;
}
[[maybe_unused]] double gltf_pbr_emissive_strength(const GltfCoreMaterial& core, const GltfPbrValue& features) {
    if (!gltf_pbr_includes(features, GltfPbrValue{${features.findIndex(({handler}) => handler.module.endsWith("/gltf-ext-emissive-strength.ts"))}.0}).truthy()) return 1.0;
    auto input = gltf_pbr_core_value(core);
    input.set("_emissiveFactor", GltfPbrValue::array({GltfPbrValue{1.0}, GltfPbrValue{1.0}, GltfPbrValue{1.0}}));
    const auto layer = gltf_pbr_gltf_ext_emissive_strength_applyMaterial(input);
    const auto color = layer.get("_emissiveColor", true);
    return color.nullish() ? 1.0 : color.at(0).number();
}` };
}

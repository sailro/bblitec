import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerGltfMaterialProperties } from "../src/lowering/gltf/material-properties.js";
import { gltfCoreMaterialFields, lowerGltfMaterialAssembly } from "../src/lowering/gltf/material-assembly.js";
import { GltfLowerer } from "../src/lowering/gltf/loader.js";
import { lowerGltfParserJson } from "../src/lowering/gltf/parser-json.js";
import { lowerGltfMaterialTextures } from "../src/lowering/gltf/material-textures.js";
import { lowerGltfFactorBake } from "../src/lowering/gltf/factor-bake.js";
import { gltfMaterialProjection } from "../src/lowering/gltf/material-projection.js";
import type { GltfMaterialFunction } from "../src/lowering/gltf/material-object-lowerer.js";
import { transpileCommonJs } from "../src/typescript-transpile.js";
import { cppFunction, cppRecord, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";
import { doctoredContext } from "./doctored-store.js";

type RecordValue = Record<string, unknown>;
type MaterialFunction = (...args: unknown[]) => unknown;

function reversedMaterialRegistry(): LoweringContext {
    const module = "src/loader-gltf/gltf-feature-registry.ts";
    const source = new LoweringContext().sourceFile(module).getFullText();
    const rows = source.split("\n").filter(line => line.includes('import("./gltf-ext-diffuse-transmission.js")') || line.includes('import("./gltf-ext-dielectric.js")'));
    assert.equal(rows.length, 2);
    return doctoredContext(module, source, source.replace(rows[0]!, "MATERIAL_ROW").replace(rows[1]!, rows[0]!).replace("MATERIAL_ROW", rows[1]!));
}

function alteredMaterialSetup(): LoweringContext {
    const module = "src/loader-gltf/load-gltf.ts";
    const source = new LoweringContext().sourceFile(module).getFullText();
    return doctoredContext(module, source, source.replace(`includes('"texCoord":1')`, `includes('"texCoord":2')`)
        .replace("s.wrapS > 10497", "s.wrapS > 33071").replace("s.magFilter === 9728", "s.magFilter === 9729")
        .replace("maxAnisotropy: 4,", "maxAnisotropy: 2,"));
}

/** Execute source bodies with imports bound to the same selected setter declarations. */
function executableFunctions(functions: readonly GltfMaterialFunction[]): Map<string, MaterialFunction> {
    const result = new Map<string, MaterialFunction>();
    const modules: Record<string, Record<string, MaterialFunction>> = {};
    const textures = () => ({ baseColorTexture: {}, ormTexture: {} });
    const boundaries: Record<string, unknown> = {
        _registerPbrExt() {}, _registerPbrSceneHook() {}, _setDispersionSampleWgsl() {},
        pbrExt: {}, stdUvTransformExt: {}, registerPbrTransmission: {}, DISPERSION_SAMPLE_WGSL: {},
        getPbrGroupBuilder: () => true,
        cloneTexture2D: (texture: object, fields: object) => ({ ...texture, ...fields }),
        engine: {}, sampler: {}, _generateMipmaps() {}, getCachedTexture() {}, wrapTex() {}, samplerFor() {},
        buildDefaultPbrTextures: textures,
        _ensurePbrExt: () => ({ ...modules["src/loader-gltf/gltf-pbr-builder-ext.ts"], buildDefaultPbrTexturesExt: textures }),
        ctx: { _runMatExts: (...args: unknown[]) => modules["src/loader-gltf/gltf-feature-registry.ts"]!.runGltfMaterialFeatures!(...args) },
    };
    for (const target of functions) {
        const source = ts.isMethodDeclaration(target.declaration)
            ? `const selected = { ${target.declaration.getText()} }; exports.selected = selected.${target.name};`
            : `${target.declaration.getText()}\nexports.selected = ${target.name};`;
        const file = ts.createSourceFile(target.module, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const transformed = ts.transform(file, [context => {
            const visit: ts.Visitor = node => {
                if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                    const path = node.arguments[0];
                    assert.ok(path && ts.isStringLiteralLike(path));
                    const module = posix.normalize(posix.join(posix.dirname(target.module), path.text)).replace(/\.js$/, ".ts");
                    return context.factory.createElementAccessExpression(context.factory.createIdentifier("runtimeImports"),
                        context.factory.createStringLiteral(module));
                }
                return ts.visitEachChild(node, visit, context);
            };
            return node => ts.visitNode(node, visit, ts.isSourceFile)!;
        }]);
        const text = ts.createPrinter().printFile(transformed.transformed[0]!);
        transformed.dispose();
        const imports: Record<string, unknown> = { ...boundaries, runtimeImports: modules, ...Object.fromEntries(target.constants ?? []) };
        for (const candidate of functions) {
            const executed = result.get(candidate.cpp);
            if (executed) imports[candidate.name] = executed;
        }
        for (const candidate of functions.filter(candidate => candidate.module === target.module)) {
            const executed = result.get(candidate.cpp);
            if (executed) imports[candidate.name] = executed;
        }
        const exported: { selected?: MaterialFunction } = {};
        new Function("exports", ...Object.keys(imports), transpileCommonJs(text, target.module))(exported, ...Object.values(imports));
        assert.ok(exported.selected);
        result.set(target.cpp, exported.selected);
        (modules[target.module] ??= {})[target.name] = exported.selected;
    }
    return result;
}

for (const [variant, context] of [
    ["pinned", new LoweringContext()],
    ["dielectric", doctoredContext("src/loader-gltf/gltf-ext-dielectric.ts", "((ior - 1) / (ior + 1)) ** 2 / 0.04", "((ior - 1) / (ior + 1)) ** 2 / 0.08")],
    ["sheen", doctoredContext("src/loader-gltf/gltf-ext-sheen.ts", "intensity: 1,", "intensity: 0.25,")],
    ["registry", reversedMaterialRegistry()],
    ["setup", alteredMaterialSetup()],
    ["construction", doctoredContext("src/loader-gltf/load-gltf.ts",
        "await applyGltfOptInPbrFeatures(props, mat);", "await applyGltfOptInPbrFeatures(props, mat); props.reflectance = 0.125;")],
] as const) test(`native material handlers and projection follow ${variant} source`, async t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const lowered = lowerGltfMaterialProperties(context);
    const execute = executableFunctions(lowered.functions);
    const upload = context.functionDeclaration("src/loader-gltf/load-gltf.ts", "uploadMeshes").declaration;
    const samplerCall = context.findNodes(upload, (node): node is ts.CallExpression =>
        ts.isCallExpression(node) && context.expressionMatchesShape(node.expression, "getOrCreateSampler"))[0]!;
    const samplerDefaults = new Function(`return (${samplerCall.arguments[1]!.getText()});`)() as Record<string, number | string>;
    const setupCases = [
        {}, { materials: null }, { materials: [] }, { materials: [{}] },
        ...[0, 1, 2, 10, 1.25, 1e-7, -1, null].map(texCoord => ({ materials: [{ normalTexture: { texCoord } }] })),
        { materials: [{ extras: { text: '"texCoord":1' } }] },
        ...[[], [{}], [{ wrapS: 10497, wrapT: 10497, magFilter: 9729, minFilter: 9987 }],
            [{ wrapS: 33071 }], [{ wrapT: 33648 }], [{ magFilter: 9728 }], [{ minFilter: null }],
            ...[9728, 9729, 9984, 9985, 9986, 9987].map(minFilter => [{ minFilter }])].map(samplers => ({ samplers })),
    ].flatMap(document => [false, true].map(wrap => {
        const input = { ...document, extensionsUsed: wrap ? ["KHR_texture_transform"] : [] };
        return { document: input, wrap,
            extended: !!execute.get("gltf_pbr_needs_extended")!(input, wrap, false),
            sampled: !!execute.get("gltf_pbr_needs_sampler")!(input) };
    }));
    const materials: RecordValue[] = [{}, { extensions: {} }, { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }, {
        extensions: {
            KHR_materials_clearcoat: { clearcoatFactor: .3, clearcoatTexture: { index: 0 }, clearcoatNormalTexture: { index: 1, scale: .4 } },
            KHR_materials_sheen: { sheenColorFactor: [.1, .2, .3], sheenRoughnessFactor: .4, sheenColorTexture: { index: 2 }, sheenRoughnessTexture: { index: 2 } },
            KHR_materials_iridescence: { iridescenceFactor: .6, iridescenceTexture: { index: 3 }, iridescenceThicknessTexture: { index: 4 } },
            KHR_materials_emissive_strength: { emissiveStrength: 4 }, KHR_materials_unlit: {},
            KHR_materials_anisotropy: { anisotropyStrength: .65, anisotropyRotation: Math.PI / 2,
                anisotropyTexture: { index: 0, extensions: { KHR_texture_transform: { offset: [.2, .7], scale: [2, 3], rotation: .25 } } } },
            KHR_materials_diffuse_transmission: { diffuseTransmissionFactor: .7, diffuseTransmissionColorTexture: { index: 2 }, diffuseTransmissionTexture: { index: 3 } },
            KHR_materials_pbrSpecularGlossiness: { diffuseTexture: { index: 5 }, specularGlossinessTexture: { index: 6 }, specularFactor: [.8, .2, .4], glossinessFactor: .7 },
        },
    }];
    materials.push({ extensions: { KHR_materials_diffuse_transmission: {}, KHR_materials_anisotropy: {} } },
        { extensions: { KHR_materials_diffuse_transmission: { diffuseTransmissionTexture: { index: 0 }, diffuseTransmissionColorFactor: [.2, .4] } } });
    for (const ior of [1.5, 1.2]) for (const specular of [undefined, 1, .25]) for (const transmission of [0, .5]) for (const volume of [false, true]) {
        materials.push({ extensions: {
            KHR_materials_ior: { ior }, KHR_materials_specular: { specularFactor: specular, specularColorFactor: [.4, .5, .6], specularTexture: { index: 1 } },
            KHR_materials_transmission: { transmissionFactor: transmission }, KHR_materials_dispersion: { dispersion: 2 },
            KHR_materials_diffuse_transmission: { diffuseTransmissionFactor: .6 },
            ...(volume ? { KHR_materials_volume: { thicknessFactor: .2, thicknessTexture: { index: 2 } } } : {}),
        } });
    }
    const fixtures: object[] = [];
    for (const raw of materials) {
        const mat = JSON.parse(JSON.stringify({ _rawMatDef: raw, _baseColorFactor: [.2, .3, .4, .5], _emissiveFactor: [.1, .2, .3],
            _baseColorImage: {}, _metallicRoughnessImage: {}, _normalScale: .6, _metallicFactor: .7, _roughnessFactor: .8,
            _occlusionImage: null, _occlusionTexCoord: 0, _doubleSided: true, _alphaMode: "MASK", _alphaCutoff: .45 })) as RecordValue;
        const layers: RecordValue = {};
        const expected: RecordValue = {};
        const ctx = { _texture: (info: { index: number } | undefined, srgb: boolean) => info
            ? execute.get(lowered.functions.find(target => target.name === "wrapTexture")!.cpp)!({ _textureIndex: info.index, _srgb: srgb }, info) : undefined };
        for (const target of lowered.functions.filter(target => target.name === "applyMaterial")) {
            const value = await execute.get(target.cpp)!(mat, ctx);
            expected[target.cpp] = value;
            Object.assign(layers, value);
        }
        const tex = { baseColorTexture: {}, ormTexture: {} };
        const propsTarget = lowered.functions.find(target => target.name === "assemblePbrPropsExt")!;
        const props = execute.get(propsTarget.cpp)!(mat, tex, layers) as RecordValue;
        const optIn = lowered.functions.find(target => target.name === "applyGltfOptInPbrFeatures")!;
        const uv = lowered.functions.find(target => target.name === "applyGltfUvTransform")!;
        await execute.get(uv.cpp)!(props, tex);
        await execute.get(optIn.cpp)!(props, mat);
        expected.props = props;
        for (const used of [Object.keys((raw.extensions ?? {}) as RecordValue), []]) for (const withWrap of [false, true]) for (const withSampler of [false, true]) {
            const document = { materials: [raw], extensionsUsed: [...used, ...(withWrap ? ["KHR_texture_transform"] : [])],
                samplers: [{ magFilter: 9729, minFilter: 9729 }, ...(withSampler ? [{ magFilter: 9728 }] : [])] };
            const wrap = lowered.textureWrapTriggers.some(target => execute.get(target.cpp)!(document));
            const extended = !!execute.get("gltf_pbr_needs_extended")!(document, wrap, false);
            const sampled = !!execute.get("gltf_pbr_needs_sampler")!(document);
            const selectedContext = { _texture: (info: { index: number } | undefined, srgb: boolean) => info
                ? wrap ? ctx._texture(info, srgb) : { _textureIndex: info.index, _srgb: srgb } : undefined };
            const selected = lowered.features.flatMap((feature, index) => execute.get(feature.trigger.cpp)!(document) ? [index] : []);
            const run = lowered.functions.find(target => target.name === "runGltfMaterialFeatures")!;
            const selectedLayers = await execute.get(run.cpp)!(mat, selected.map(index => ({ applyMaterial: execute.get(lowered.features[index]!.handler.cpp)! })), selectedContext);
            const selectedProps = await execute.get("gltf_pbr_build_material")!(mat,
                selected.map(index => ({ applyMaterial: execute.get(lowered.features[index]!.handler.cpp)! })),
                selectedContext, extended, sampled ? () => tex : undefined) as RecordValue;
            fixtures.push({ mat, tex, document, selected, wrap, extended, sampled, expected: { ...expected, layers: selectedLayers, selectedProps } });
        }
    }
    const directory = resolve(`artifacts/gltf-material-properties-${variant}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "cases.json"), JSON.stringify({ materials: fixtures, setup: setupCases },
        (_key, value: unknown) => value === undefined ? { __undefined: true } : value));
    const source = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    const named = (name: string) => lowered.functions.find(target => target.name === name)!.cpp;
    const loader = new GltfLowerer(context).lowerLoaderAdapter({ animationPointerMaterials: true }).source;
    const animationWrite = (kind: string) => {
        const label = `case MaterialTrackKind::${kind}:`;
        const begin = loader.indexOf(label);
        const end = loader.indexOf("break;", begin);
        assert.ok(begin >= 0 && end > begin);
        return loader.slice(begin + label.length, end);
    };
    const iorFunction = lowered.functions.find(target => target.name === "iorToF0Factor")!;
    writeFileSync(source, `#include <bblite/ts_runtime.hpp>
        #include <bblite/pal_image_canvas.hpp>
        #include <bblite/runtime.hpp>
        #include <array>
        #include <cassert>
        #include <fstream>
        #include <functional>
        #include <optional>
        namespace bbl {
            using JsonObject = ts::JsonValue::Object;
            using JsonArray = ts::JsonValue::Array;
            namespace upstream { struct ParsedGlbContainer {}; }
            ${cppRecord(loader, "struct BufferViewInfo {")}
            ${["const ts::JsonValue& required(", "const ts::JsonValue* optional(", "std::size_t unsigned_value(", "std::size_t unsigned_or(",
                "float float_or(", "std::string string_or(", "std::vector<float> float_array(", "std::vector<double> double_array(",
                "const ts::JsonValue* texture_transform_value("].map(signature => cppFunction(loader, signature)).join("\n")}
            ${lowerGltfParserJson(context)}
            ${lowerGltfMaterialAssembly(context)}
            ${lowerGltfFactorBake(context.sourceFile("src/math/color.ts"))}
            ${lowerGltfMaterialTextures(context)}
            ${lowered.source}
            TextureData image_data(const ts::ArrayBuffer&, const upstream::ParsedGlbContainer&, const std::vector<BufferViewInfo>&, const JsonArray&, std::size_t index) {
                TextureData result; result.bytes = {static_cast<std::uint8_t>(index + 1)}; return result;
            }
            ${gltfMaterialProjection(true)}
            void animate_ior(MaterialRecord& material, float sample) {
                const Vec4 a{sample, 0, 0, 0}, b{sample, 0, 0, 0};
                const auto mix = [](float left, float right) { return left + (right - left) * .25f; };
                ${animationWrite("index_of_refraction")}
            }
            void animate_thickness(MaterialRecord& material, float sample) {
                const Vec4 a{sample, 0, 0, 0}, b{sample, 0, 0, 0};
                const auto mix = [](float left, float right) { return left + (right - left) * .25f; };
                ${animationWrite("volume_thickness")}
            }
            void compare(const GltfPbrValue& actual, const nlohmann::json& expected) {
                if (expected.is_object() && expected.contains("__undefined")) { assert(actual.undefined()); return; }
                assert(!actual.undefined());
                if (expected.is_null()) { assert(actual.nullish()); return; }
                if (expected.is_boolean()) { assert(actual.truthy() == expected.get<bool>()); return; }
                if (expected.is_number()) { assert(std::abs(actual.number() - expected.get<double>()) < 1e-12); return; }
                if (expected.is_string()) { assert(actual.string() == expected.get<std::string>()); return; }
                assert(actual.size() == expected.size());
                if (expected.is_array()) {
                    assert(actual.is_array());
                    for (std::size_t index = 0; index < expected.size(); ++index) compare(actual.at(double(index)), expected[index]);
                } else for (const auto& [key, value] : expected.items()) compare(actual.get(key), value);
            }
        }
        int main() {
            using namespace bbl;
            {
                GltfTextureCache cache;
                const auto image = std::make_shared<GltfMaterialImageSource>(GltfMaterialImageSource{3});
                const auto texture = gltf_cached_material_texture(cache, image, true);
                GltfPbrValue first{texture};
                const GltfPbrValue second{gltf_cached_material_texture(cache, image, true)};
                assert(first.equals(second));
                first.set("uOffset", GltfPbrValue{0.25});
                assert(second.get("uOffset").number() == 0.25);
                const GltfPbrValue linear{gltf_cached_material_texture(cache, image, false)};
                assert(!first.equals(linear));
                const auto cloned = first.clone();
                assert(!first.equals(cloned));
                cloned.set("uOffset", GltfPbrValue{0.5});
                assert(first.get("uOffset").number() == 0.25);
                assert(GltfPbrValue{cloned.texture()}.equals(cloned));
                const GltfPbrValue sampled{texture.clone()};
                assert(!sampled.equals(first));
                const GltfPbrValue factorA{gltf_base_factor_texture({1,1,1,1})};
                const GltfPbrValue factorB{gltf_base_factor_texture({1,1,1,1})};
                assert(!factorA.equals(factorB));
                auto independent = texture.clone();
                { const GltfPbrValue temporary{independent}; assert(!independent.identity->value.expired()); }
                assert(independent.identity->value.expired());
            }
            {
                const auto document = ts::json_parse(R"({"materials":[{"pbrMetallicRoughness":{"metallicRoughnessTexture":{"index":0}},"occlusionTexture":{"index":1}}],"textures":[{"source":0},{"source":1}],"images":[{},{}]})");
                const auto& object = document.as_object();
                GltfMaterialImageCache cache;
                const auto resolve_image = [](std::size_t index) -> GltfMaterialImage { return std::make_shared<GltfMaterialImageSource>(index); };
                const auto core = assemble_gltf_material(object, 0, cache, resolve_image);
                const auto features = gltf_pbr_material_features(GltfPbrValue{&document});
                assert(features.size() == 1);
                const auto fetcher = make_gltf_extension_image_fetcher(object, double(features.size()), resolve_image);
                Engine engine;
                unsigned decodes = 0;
                load_material(engine, core._rawMatDef->as_object(), core, {}, {}, {}, object.at("images").as_array(), object.at("textures").as_array(),
                    {}, fetcher, false, features, false, false, false, nullptr, nullptr,
                    [&](const TextureData& texture) {
                        ++decodes;
                        return texture.bytes[0] == 1 ? pal::DecodedImage{2, 1, {10,40,60,255, 14,44,66,255}}
                            : pal::DecodedImage{2, 1, {20,3,5,255, 35,9,8,255}};
                    });
                assert(decodes == 2);
                const auto& orm = engine.materials.back().metallic_roughness_texture;
                assert(orm.rgba_width == 2 && orm.rgba_height == 1);
                assert((std::vector<std::uint8_t>(orm.bytes.begin(), orm.bytes.end()) == std::vector<std::uint8_t>{20,40,60,255, 35,44,66,255}));
                const auto bitmap = GltfPbrValue{core._metallicRoughnessImage};
                unsigned uploads = 0;
                const auto upload = [&](GltfMaterialImage image, bool srgb) { ++uploads; return GltfPbrValue{GltfMaterialTexture{std::move(image), srgb, std::nullopt, nullptr}}; };
                const auto first = gltf_extension_upload_image(bitmap, false, upload);
                const auto second = gltf_extension_upload_image(bitmap, false, upload);
                assert(uploads == 2 && !first.equals(second));
                assert(first.texture().image == second.texture().image && !first.texture().srgb);
                const auto absent = GltfPbrValue::object();
                absent.set("_metallicRoughnessImage", bitmap);
                absent.set("_occlusionImage", bitmap);
                const GltfPbrContext unused_context;
                assert(gltf_pbr_gltf_ext_orm_applyMaterial(absent, unused_context).nullish());
                absent.erase("_occlusionImage");
                assert(gltf_pbr_gltf_ext_orm_applyMaterial(absent, unused_context).nullish());
            }
            {
                MaterialRecord animated;
                ${[1, 1.2, 1.5, 2, 3].map(sample => `animate_ior(animated, static_cast<float>(${context.doubleLiteral(sample)}));
                assert(std::abs(animated.metallic_f0_factor - static_cast<float>(${Number(execute.get(iorFunction.cpp)!(Math.fround(sample)))})) < 1e-6f);
                assert(animated.specular_weight == 1.0f);`).join("\n")}
                animate_thickness(animated, .25f);
                assert(animated.thickness == .25f && animated.use_thickness_as_depth);
            }
            nlohmann::json cases;
            std::ifstream("cases.json") >> cases;
            GltfPbrContext context;
            context.texture = [](const GltfPbrValue& info, bool srgb) {
                if (info.nullish()) return GltfPbrValue{};
                auto texture = GltfPbrValue::object();
                texture.set("_textureIndex", info.get("index"));
                texture.set("_srgb", GltfPbrValue{srgb});
                return ${named("wrapTexture")}(texture, info);
            };
            for (const auto& row : cases.at("setup")) {
                const auto document = ts::JsonValue::from_native(row.at("document"));
                const GltfPbrValue value{&document};
                const auto wrap = gltf_pbr_has_texture_wrap(value);
                assert(wrap == row.at("wrap").get<bool>());
                assert(gltf_pbr_needs_extended(value, GltfPbrValue{wrap}, GltfPbrValue{false}).truthy() == row.at("extended").get<bool>());
                assert(gltf_pbr_needs_sampler(value).truthy() == row.at("sampled").get<bool>());
            }
            for (const auto& row : cases.at("materials")) {
                const auto input = ts::JsonValue::from_native(row.at("mat"));
                const auto texture_input = ts::JsonValue::from_native(row.at("tex"));
                const GltfPbrValue mat{&input}, textures{&texture_input};
                auto layers = GltfPbrValue::object();
                ${lowered.functions.filter(target => target.name === "applyMaterial").map(target => `{
                    const auto value = ${target.cpp}(mat${target.contextParameter ? ", context" : ""});
                    compare(value, row.at("expected").at("${target.cpp}"));
                    layers.merge(value);
                }`).join("\n")}
                auto props = ${named("assemblePbrPropsExt")}(mat, textures, layers);
                ${named("applyGltfUvTransform")}(props, textures);
                ${named("applyGltfOptInPbrFeatures")}(props, mat);
                compare(props, row.at("expected").at("props"));
                assert(props.get("baseColorFactor").equals(mat.get("_baseColorFactor")));
                const auto document = ts::JsonValue::from_native(row.at("document"));
                const auto features = gltf_pbr_material_features(GltfPbrValue{&document});
                const auto wrap = gltf_pbr_has_texture_wrap(GltfPbrValue{&document});
                const auto extended = gltf_pbr_needs_extended(GltfPbrValue{&document}, GltfPbrValue{wrap}, GltfPbrValue{false}).truthy();
                const auto sampled = gltf_pbr_needs_sampler(GltfPbrValue{&document}).truthy();
                assert(wrap == row.at("wrap").get<bool>() && extended == row.at("extended").get<bool>() && sampled == row.at("sampled").get<bool>());
                GltfPbrContext selected_context;
                selected_context.texture = [&](const GltfPbrValue& info, bool srgb) {
                    if (wrap || info.nullish()) return context.texture(info, srgb);
                    auto texture = GltfPbrValue::object();
                    texture.set("_textureIndex", info.get("index"));
                    texture.set("_srgb", GltfPbrValue{srgb});
                    return texture;
                };
                compare(features, row.at("selected"));
                compare(${named("runGltfMaterialFeatures")}(mat, features, selected_context), row.at("expected").at("layers"));
                selected_context.default_textures = [&](const GltfPbrValue& input_mat) { assert(input_mat.equals(mat)); return textures; };
                selected_context.sampled_textures = selected_context.default_textures;
                selected_context.extended_textures = selected_context.default_textures;
                compare(gltf_pbr_build_material(mat, features, selected_context, GltfPbrValue{extended}, GltfPbrValue{sampled}),
                    row.at("expected").at("selectedProps"));
                GltfCoreMaterial core;
                ${[...gltfCoreMaterialFields].map(([name, type]) => {
                    const value = `mat.get("${name}")`;
                    const expression = type === "GltfMaterialImage" ? `${value}.truthy() ? std::make_shared<GltfMaterialImageSource>(GltfMaterialImageSource{7}) : GltfMaterialImage{}`
                        : type === "const ts::JsonValue*" ? `${value}.source()`
                        : type === "std::vector<double>" ? `double_array(${value}.source())`
                        : type === "std::string" ? `${value}.string()` : type === "bool" ? `${value}.truthy()` : `${value}.number()`;
                    return `core.${name} = ${expression};`;
                }).join("\n")}
                Engine engine;
                const auto source_textures = ts::JsonValue::from_native(nlohmann::json::parse(R"([{ "source": 0, "sampler": 0 },{ "source": 1, "sampler": 0 },{ "source": 2 },{ "source": 3 },{ "source": 4 },{ "source": 5 },{ "source": 6 }])"));
                const JsonObject image_document{{"textures", source_textures}};
                const auto extension_fetcher = make_gltf_extension_image_fetcher(image_document, double(features.size()),
                    [](std::size_t index) -> GltfMaterialImage { return std::make_shared<GltfMaterialImageSource>(GltfMaterialImageSource{index}); });
                load_material(engine, core._rawMatDef->as_object(), core, {}, {}, {}, JsonArray(8), source_textures.as_array(),
                    document.as_object().at("samplers").as_array(), extension_fetcher, false,
                    features, extended, wrap, sampled);
                const auto& record = engine.materials.back();
                const auto wanted_input = ts::JsonValue::from_native(row.at("expected").at("selectedProps"));
                const GltfPbrValue wanted{&wanted_input};
                const auto numeric = [&](const GltfPbrValue& object, const char* key, float actual, float fallback) {
                    const auto expected = object.get(key, true);
                    assert(std::abs(actual - (expected.nullish() ? fallback : static_cast<float>(expected.number()))) < 1e-6f);
                };
                numeric(wanted, "metallicFactor", record.metallic_factor, 1);
                numeric(wanted, "roughnessFactor", record.roughness_factor, 1);
                numeric(wanted, "reflectance", record.reflectance, .04f);
                numeric(wanted, "_metallicF0Factor", record.metallic_f0_factor, 1);
                numeric(wanted, "_specularWeight", record.specular_weight, 1);
                numeric(wanted.get("_clearCoat", true), "intensity", record.clearcoat_intensity, 0);
                numeric(wanted.get("_sheen", true), "intensity", record.sheen_intensity, 1);
                numeric(wanted.get("_iridescence", true), "indexOfRefraction", record.iridescence_index_of_refraction, 1.3f);
                numeric(wanted.get("_anisotropy", true), "intensity", record.anisotropy_intensity, 1);
                const auto anisotropy = wanted.get("_anisotropy", true).get("texture", true);
                numeric(anisotropy, "uOffset", record.anisotropy_transform.u_offset, 0);
                numeric(anisotropy, "vOffset", record.anisotropy_transform.v_offset, 0);
                numeric(anisotropy, "uScale", record.anisotropy_transform.u_scale, 1);
                numeric(anisotropy, "vScale", record.anisotropy_transform.v_scale, 1);
                numeric(anisotropy, "uAng", record.anisotropy_transform.rotation, 0);
                const auto subsurface = wanted.get("_subsurface", true);
                numeric(subsurface.get("refraction", true), "intensity", record.transmission_factor, 0);
                numeric(subsurface.get("refraction", true), "dispersion", record.dispersion, 0);
                numeric(subsurface.get("thickness", true), "max", record.thickness, 0);
                assert(record.has_subsurface == subsurface.get("translucency", true).truthy());
                if (record.has_subsurface) numeric(subsurface.get("translucency", true), "intensity", record.subsurface_intensity, 1);
                assert(record.alpha_mode == MaterialAlphaMode::mask && record.alpha_cutoff == .45f);
                const auto emission = wanted.get("_emissiveColor");
                assert(std::abs(record.emissive_factor.r - static_cast<float>(emission.at(0).number())) < 1e-6f);
                assert(std::abs(record.emissive_base_factor.r * record.emissive_strength - record.emissive_factor.r) < 1e-6f);
                if (mat.get("_rawMatDef").get("pbrMetallicRoughness").truthy()) {
                    assert(record.base_color_texture.has_image());
                    assert(record.base_color_texture.sampler.max_lod == (sampled ? 0.0f : TextureData{}.sampler.max_lod));
                    assert(record.base_color_texture.sampler.max_anisotropy == (sampled ? 1.0f : ${Number(samplerDefaults.maxAnisotropy)}.0f));
                }
                if (record.metallic_reflectance_texture.has_image()) {
                    assert(record.metallic_reflectance_texture.sampler.max_lod == TextureData{}.sampler.max_lod);
                    assert(record.metallic_reflectance_texture.sampler.max_anisotropy == ${Number(samplerDefaults.maxAnisotropy)}.0f);
                }
            }
        }`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${directory}\\`, `/Fe:${executable}`, "/I", "native/include", `/external:I${join(nativeFixtureVcpkgRoot, "include")}`, "/external:W0", source]);
    execFileSync(executable, { cwd: directory, stdio: "pipe" });
});

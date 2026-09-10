import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { GltfLowerer } from "../src/lowering/gltf/loader.js";
import { lowerGltfMaterialAssembly } from "../src/lowering/gltf/material-assembly.js";
import { lowerGltfMaterialTextures } from "../src/lowering/gltf/material-textures.js";
import { lowerGltfMaterialProperties } from "../src/lowering/gltf/material-properties.js";
import { lowerGltfFactorBake } from "../src/lowering/gltf/factor-bake.js";
import { lowerGltfParserJson } from "../src/lowering/gltf/parser-json.js";
import { transpileCommonJs } from "../src/typescript-transpile.js";
import { cppFunction, cppRecord, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";
import { doctoredContext } from "./doctored-store.js";

const module = "src/loader-gltf/gltf-material.ts";
const tools = optionalNativeFixtureTools();

function execute(context: LoweringContext, reads: number[]) {
    const declarations = ["assembleMaterial", "makeImageFetcher"].map(name => context.functionDeclaration(module, name).declaration.getText());
    declarations.push(context.functionDeclaration("src/loader-gltf/gltf-parser.ts", "getTextureImageIndex").declaration.getText());
    const code = transpileCommonJs(declarations.join("\n"), module);
    const resolver = (_json: object, _bytes: DataView, index: number) => {
        reads.push(index);
        return Promise.resolve({ index });
    };
    return new Function("exports", "resolveImage", `${code}\nreturn assembleMaterial;`)({}, resolver) as
        (json: object, bytes: DataView, index: number, url: string, cache: unknown[]) => Promise<Record<string, unknown>>;
}

test("core glTF material assembly follows pinned defaults, branches, fetch order and image identity", { skip: !tools }, async () => {
    const base = new LoweringContext();
    const contexts = [base,
        doctoredContext(module, "pbr.metallicFactor ?? 1", "(pbr.metallicFactor ?? 1) * 0.25"),
        doctoredContext(module, "fetchImg(pbr.baseColorTexture)", "fetchImg(mat.normalTexture)"),
        doctoredContext(module, "if (!texInfo) {", "if (!texInfo || texInfo.index === 0) {"),
        doctoredContext(module, "pbr.baseColorFactor ?? [1, 1, 1, 1]", "pbr.baseColorFactor ?? [0.2, 0.3, 0.4, 0.5]"),
        doctoredContext(module, "mat.emissiveFactor ?? [0, 0, 0]", "mat.emissiveFactor ?? [1, 0, 0]"),
    ];
    const inputs = [
        {},
        { materials: [null, {}, { pbrMetallicRoughness: null, emissiveFactor: null, alphaMode: null, alphaCutoff: null }] },
        { materials: [{ pbrMetallicRoughness: { baseColorFactor: [.1, .2, .3, .4], metallicFactor: 0, roughnessFactor: .25 },
            emissiveFactor: [2, 3, 4], doubleSided: true, alphaMode: "MASK", alphaCutoff: 0 }] },
        { textures: [{ source: 3 }, { source: 5 }, { source: 3 }], materials: [
            { pbrMetallicRoughness: { baseColorTexture: { index: 1 }, metallicRoughnessTexture: { index: 0 } },
                normalTexture: { index: 2, scale: .75 }, occlusionTexture: { index: 0, texCoord: 1 }, emissiveTexture: { index: 1 }, alphaMode: "BLEND" },
            { normalTexture: { index: 0, scale: "default" }, occlusionTexture: { index: 1, texCoord: null } },
        ] },
    ];
    const rows: object[] = [];
    for (const input of inputs) {
        const count = "materials" in input ? input.materials.length : 0;
        const indices = [...Array.from({ length: count }, (_value, index) => index), count, 0];
        const outputs = [];
        for (const context of contexts) {
            const reads: number[] = [], run = execute(context, reads), cache: unknown[] = [];
            const materials = [];
            for (const index of indices) materials.push(await run(input, new DataView(new ArrayBuffer(0)), index, "", cache));
            outputs.push({ materials, reads });
        }
        rows.push({ input, indices, outputs });
    }
    const output = resolve("artifacts/gltf-material-assembly");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "cases.json"), JSON.stringify(rows));
    const loader = new GltfLowerer(base).lowerLoaderAdapter().source;
    const file = join(output, "check.cpp"), executable = join(output, "check.exe");
    const fields = ["_baseColorFactor", "_metallicFactor", "_roughnessFactor", "_emissiveFactor", "_normalScale",
        "_occlusionTexCoord", "_doubleSided", "_alphaMode", "_alphaCutoff"];
    const images = ["_baseColorImage", "_metallicRoughnessImage", "_normalImage", "_occlusionImage", "_emissiveImage"];
    writeFileSync(file, `#include <bblite/ts_runtime.hpp>
        #include <bblite/pal_image_canvas.hpp>
        #include <cassert>
        #include <fstream>
        #include <memory>
        #include <unordered_map>
        namespace bbl {
            using JsonObject = ts::JsonValue::Object;
            using JsonArray = ts::JsonValue::Array;
            ${cppFunction(loader, "const ts::JsonValue* optional(")}
            ${cppFunction(loader, "std::vector<double> double_array(")}
            ${lowerGltfParserJson(base)}
            ${contexts.map((context, index) => `namespace variant${index} { ${lowerGltfMaterialAssembly(context)} }`).join("\n")}
        }
        int main() {
            using namespace bbl;
            nlohmann::json cases;
            std::ifstream("cases.json") >> cases;
            for (const auto& row : cases) {
                const auto document = ts::JsonValue::from_native(row.at("input"));
                const auto& json = document.as_object();
                ${contexts.map((_context, variant) => `{
                    using namespace variant${variant};
                    GltfMaterialImageCache cache;
                    std::vector<std::size_t> reads;
                    const auto resolve_image = [&](std::size_t index) -> GltfMaterialImage {
                        reads.push_back(index);
                        return std::make_shared<GltfMaterialImageSource>(GltfMaterialImageSource{index});
                    };
                    for (std::size_t index = 0; index < row.at("indices").size(); ++index) {
                        const auto source_index = row.at("indices")[index].get<std::size_t>();
                        const auto actual = assemble_gltf_material(json, source_index, cache, resolve_image);
                        const auto& expected = row.at("outputs")[${variant}].at("materials")[index];
                        ${fields.map(field => `assert(nlohmann::json(actual.${field}) == expected.at("${field}"));`).join("\n")}
                        ${images.map(field => `if (expected.at("${field}").is_null()) assert(!actual.${field});
                            else { assert(actual.${field}); assert(actual.${field}->index == expected.at("${field}").at("index"));
                                assert(actual.${field} == cache.at(actual.${field}->index).get()); }`).join("\n")}
                        assert(actual._rawMatDef == gltf_material_at(json, source_index));
                    }
                    assert(nlohmann::json(reads) == row.at("outputs")[${variant}].at("reads"));
                }`).join("\n")}
            }
        }`);
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", `/external:I${join(nativeFixtureVcpkgRoot, "include")}`, "/external:W0", file]);
    execFileSync(executable, { cwd: output, stdio: "pipe" });
});

test("glTF material assembly refuses unrepresented return fields and image operations", () => {
    assert.throws(() => lowerGltfMaterialAssembly(doctoredContext(module,
        "_rawMatDef: rawMat,", "_rawMatDef: rawMat, unexpected: 1,")), /Unrepresented core material member/);
    assert.throws(() => lowerGltfMaterialAssembly(doctoredContext(module,
        "resolveImage(json, binChunk, imgIdx, baseUrl)", "readOtherImage(imgIdx)")), /Material image resolution/);
});

test("glTF texture builders and native material projection preserve source selection and factor baking", { skip: !tools }, async () => {
    const builderModule = "src/loader-gltf/gltf-pbr-builder.ts", extModule = "src/loader-gltf/gltf-pbr-builder-ext.ts";
    const base = new LoweringContext();
    const contexts = [base,
        doctoredContext(module, "pbr.metallicFactor ?? 1", "(pbr.metallicFactor ?? 1) * 0.25"),
        doctoredContext(module, "fetchImg(pbr.baseColorTexture)", "fetchImg(mat.normalTexture)"),
        doctoredContext(module, "if (!texInfo) {", "if (!texInfo || texInfo.index === 0) {"),
        doctoredContext(extModule, "mat._occlusionTexCoord !== 0", "mat._occlusionTexCoord === 1"),
        doctoredContext(builderModule, "clamp(roughness), clamp(metallic)", "clamp(metallic), clamp(roughness)"),
        doctoredContext(builderModule, "Math.round(Math.max(0, Math.min(1, value)) * 255)", "Math.round(Math.max(0, Math.min(1, value)) * 127)"),
        doctoredContext("src/math/color.ts", "Math.pow(c, 1 / 2.4)", "Math.pow(c, 1 / 2.2)"),
        doctoredContext("src/math/color.ts", "c <= 0.0031308 ? c * 12.92", "c <= 0.03 ? c * 10.0"),
        doctoredContext(module, "pbr.baseColorFactor ?? [1, 1, 1, 1]", "pbr.baseColorFactor ?? [0.2, 0.3, 0.4, 0.5]"),
        doctoredContext(module, "mat.emissiveFactor ?? [0, 0, 0]", "mat.emissiveFactor ?? [1, 0, 0]"),
    ];
    type Texture = { index: number | null; srgb: boolean; fallback: number[] | null; info?: { index: number } | null };
    const slots = ["baseColorTexture", "ormTexture", "normalTexture", "emissiveTexture", "occlusionTexture"];
    const rows: object[] = [];
    const materials: object[] = [{}, { pbrMetallicRoughness: { baseColorFactor: [.17, .31, .73, .42], metallicFactor: .13, roughnessFactor: .61 }, alphaMode: "MASK" },
        { pbrMetallicRoughness: { baseColorFactor: [.0031, .02, .1, .4], metallicFactor: 0, roughnessFactor: 1 } }];
    for (const mr of [-1, 0, 1]) for (const occlusion of [-1, 0, 1, 2]) for (const texCoord of [0, 1, 2]) {
        materials.push({ pbrMetallicRoughness: {
            baseColorFactor: [.17, .31, .73, .42], metallicFactor: .13, roughnessFactor: .61,
            baseColorTexture: { index: 1 }, ...(mr < 0 ? {} : { metallicRoughnessTexture: { index: mr } }),
        }, normalTexture: { index: 3, scale: .25 }, emissiveTexture: { index: 0 }, emissiveFactor: [.2, .4, .6],
        ...(occlusion < 0 ? {} : { occlusionTexture: { index: occlusion, texCoord,
            ...(occlusion === 2 ? { extensions: { KHR_texture_transform: { offset: [.25, .75], rotation: .4 } } } : {}) } }),
        doubleSided: true, alphaMode: "BLEND", alphaCutoff: .35 });
    }
    const input = { textures: [{ source: 0 }, { source: 1, sampler: 0 }, { source: 0 }, { source: 7 }],
        samplers: [{ minFilter: 9728, magFilter: 9728, wrapS: 33071, wrapT: 33648 }], materials };
    for (const [variant, context] of contexts.entries()) {
        new GltfLowerer(context).lowerLoaderAdapter();
        const declarations = [
            ...["uploadBaseColorFactorTexture", "uploadOrmFactorTexture", "buildDefaultPbrTextures"].map(name => context.functionDeclaration(builderModule, name).declaration.getText()),
            ...["wrapTexCoord", "occlusionNeedsSplit", "buildDefaultPbrTexturesExt"].map(name => context.functionDeclaration(extModule, name).declaration.getText()),
            context.functionDeclaration("src/math/color.ts", "linearToSrgbByte").declaration.getText(),
        ];
        const upload = (_engine: unknown, _image: unknown, srgb: boolean, _sampler: unknown, _mipmaps: unknown, bytes: Uint8Array): Texture =>
            ({ index: null, srgb, fallback: Array.from(bytes), info: null });
        const builders = new Function("exports", "U8", "uploadTex", "cloneTexture2D",
            `${transpileCommonJs(declarations.join("\n"), builderModule)}\nreturn [buildDefaultPbrTextures, buildDefaultPbrTexturesExt];`)(
            {}, Uint8Array, upload, (texture: Texture, extra: object) => ({ ...texture, ...extra })) as
            ((engine: object, material: object, sampler: object, mipmaps: () => void,
                cache: (image: { index: number }, srgb: boolean) => Texture,
                wrap: (texture: Texture, info: { index: number } | undefined) => Texture) => Record<string, Texture | undefined>)[];
        const run = execute(context, []), cache: unknown[] = [];
        const expected = [];
        for (let index = 0; index <= materials.length; ++index) {
            const mat = await run(input, new DataView(new ArrayBuffer(0)), index, "", cache);
            const textures = builders.map(builder => {
                const built = builder({}, mat, {}, () => {}, (image, srgb) => ({ index: image.index, srgb, fallback: null }),
                    (texture, info) => ({ ...texture, info: info ?? null }));
                return slots.map(slot => {
                    const value = built[slot];
                    return value ? { index: value.index, srgb: value.srgb, fallback: value.fallback, info: value.info?.index ?? null } : null;
                });
            });
            expected.push({ mat, textures });
        }
        rows.push({ variant, expected });
    }
    const output = resolve("artifacts/gltf-material-projection");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "cases.json"), JSON.stringify({ input, rows }));
    const loader = new GltfLowerer(base).lowerLoaderAdapter().source;
    const helpers = ["const ts::JsonValue& required(", "const ts::JsonValue* optional(", "std::size_t unsigned_value(",
        "std::size_t unsigned_or(", "std::string string_or(",
        "std::vector<double> double_array(", "const ts::JsonValue* texture_transform_value("]
        .map(signature => cppFunction(loader, signature)).join("\n");
    const file = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(file, `#include <bblite/runtime.hpp>
        #include <bblite/pal_image_canvas.hpp>
        #include <bblite/ts_runtime.hpp>
        #include <cassert>
        #include <fstream>
        namespace bbl {
            using JsonObject = ts::JsonValue::Object;
            using JsonArray = ts::JsonValue::Array;
            namespace upstream { struct ParsedGlbContainer {}; }
            ${cppRecord(loader, "struct BufferViewInfo {")}
            ${helpers}
            ${lowerGltfParserJson(base)}
            TextureData image_data(const ts::ArrayBuffer&, const upstream::ParsedGlbContainer&,
                const std::vector<BufferViewInfo>&, const JsonArray&, std::size_t index) {
                TextureData result;
                if (index == 7) { result.compressed.mips.emplace_back(); result.uv_invert_y = true; }
                else result.bytes = std::vector<std::uint8_t>{static_cast<std::uint8_t>(index + 1)};
                return result;
            }
            ${contexts.map((context, index) => `namespace variant${index} {
                ${lowerGltfFactorBake(context.sourceFile("src/math/color.ts"))}
                ${lowerGltfMaterialAssembly(context)}
                ${lowerGltfMaterialTextures(context)}
                ${lowerGltfMaterialProperties(context).source}
                ${["void gltf_pbr_number(", "void gltf_pbr_color(", "void gltf_pbr_transform("].map(signature => cppFunction(loader, signature)).join("\n")}
                ${cppFunction(loader, "MaterialHandle load_material(")}
            }`).join("\n")}
        }
        int main() {
            using namespace bbl;
            nlohmann::json cases;
            std::ifstream("cases.json") >> cases;
            const auto document = ts::JsonValue::from_native(cases.at("input"));
            const auto& json = document.as_object();
            ${contexts.map((_context, variant) => `{
                using namespace variant${variant};
                GltfMaterialImageCache cache;
                const auto resolve_image = [](std::size_t index) -> GltfMaterialImage {
                    return std::make_shared<GltfMaterialImageSource>(GltfMaterialImageSource{index});
                };
                const auto& expected = cases.at("rows")[${variant}].at("expected");
                Engine engine;
                for (std::size_t index = 0; index < expected.size(); ++index) {
                    const auto core = assemble_gltf_material(json, index, cache, resolve_image);
                    const std::array built{gltf_default_pbr_textures(core), gltf_default_pbr_textures_ext(core)};
                    for (std::size_t path = 0; path < built.size(); ++path) {
                        const auto& textures = built[path];
                        std::size_t slot = 0;
                        for (const GltfMaterialTexture* texture : {${slots.map(name => `&textures.${name}`).join(", ")}}) {
                            const auto& wanted = expected[index].at("textures")[path][slot++];
                            if (wanted.is_null()) { assert(!*texture); continue; }
                            assert(*texture && texture->srgb == wanted.at("srgb"));
                            assert(texture->image ? nlohmann::json(texture->image->index) == wanted.at("index") : wanted.at("index").is_null());
                            assert(texture->fallback ? nlohmann::json(*texture->fallback) == wanted.at("fallback") : wanted.at("fallback").is_null());
                            assert(texture->info ? required(texture->info->as_object(), "index").as_number() == wanted.at("info") : wanted.at("info").is_null());
                        }
                    }
                    const auto& tex = built[1];
                    const bool invalid = core._occlusionImage && (core._occlusionTexCoord > 1 ||
                        (core._occlusionTexCoord == 1 && core._metallicRoughnessImage && !tex.occlusionTexture));
                    const auto count = engine.materials.size();
                    try {
                        const auto handle = load_material(engine, gltf_material_object(core._rawMatDef), core, {}, {}, {}, {},
                            gltf_array_or_empty(json, "textures"), gltf_array_or_empty(json, "samplers"), GltfImageFetcher{}, false,
                            GltfPbrValue::array({}), true, true, true);
                        assert(!invalid && handle.value == count);
                    } catch (const std::runtime_error&) { assert(invalid && engine.materials.size() == count); continue; }
                    const auto& material = engine.materials.back();
                    const auto check_image = [](const TextureData& data, const GltfMaterialTexture& texture) {
                        assert(data.has_image() == static_cast<bool>(texture.image));
                        if (texture.image) {
                            if (texture.image->index == 7) assert(data.bytes.empty() && data.uv_invert_y && !data.compressed.mips.empty());
                            else assert(data.bytes.size() == 1 && data.bytes[0] == texture.image->index + 1);
                        }
                    };
                    check_image(material.base_color_texture, tex.baseColorTexture);
                    check_image(material.metallic_roughness_texture, tex.ormTexture);
                    check_image(material.normal_texture, tex.normalTexture);
                    check_image(material.emissive_texture, tex.emissiveTexture);
                    if (tex.baseColorTexture.fallback) assert(material.base_color_fallback == *tex.baseColorTexture.fallback);
                    if (tex.ormTexture.fallback) assert(material.orm_fallback == *tex.ormTexture.fallback);
                    assert(material.metallic_factor == (core._metallicRoughnessImage ? static_cast<float>(core._metallicFactor) : 1.0f));
                    assert(material.roughness_factor == (core._metallicRoughnessImage ? static_cast<float>(core._roughnessFactor) : 1.0f));
                    assert(material.base_color_factor.r == (tex.baseColorTexture.fallback ? 1.0f : static_cast<float>(core._baseColorFactor[0])));
                    assert(material.normal_texture_scale == static_cast<float>(core._normalScale));
                    assert(material.occlusion_strength == (core._occlusionImage ? 1.0f : 0.0f));
                    assert(material.has_occlusion_transform == static_cast<bool>(tex.occlusionTexture));
                    assert(material.occlusion_texture_uv2 == (core._occlusionImage && core._occlusionTexCoord == 1));
                    if (material.occlusion_texture_uv2) check_image(material.occlusion_texture, tex.occlusionTexture);
                    if (tex.occlusionTexture.info && texture_transform_value(tex.occlusionTexture.info)) {
                        assert(material.occlusion_transform.u_offset == 0.25f);
                        assert(material.occlusion_transform.v_offset == 0.75f);
                    }
                    if (tex.baseColorTexture.image && tex.baseColorTexture.info && required(tex.baseColorTexture.info->as_object(), "index").as_number() == 1) {
                        assert(material.base_color_texture.sampler.address_u == TextureAddressMode::clamp);
                        assert(material.base_color_texture.sampler.address_v == TextureAddressMode::mirror);
                        assert(material.base_color_texture.sampler.max_lod == 0);
                    }
                }
            }`).join("\n")}
        }`);
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/bigobj", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", `/external:I${join(nativeFixtureVcpkgRoot, "include")}`, "/external:W0", file]);
    execFileSync(executable, { cwd: output, stdio: "pipe" });
});

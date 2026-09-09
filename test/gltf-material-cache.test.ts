import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { GltfLowerer } from "../src/lowering/gltf/loader.js";
import { lowerGltfMaterialAssembly } from "../src/lowering/gltf/material-assembly.js";
import { lowerGltfMaterialCaches } from "../src/lowering/gltf/material-cache.js";
import { lowerGltfExtensionImages } from "../src/lowering/gltf/extension-images.js";
import { lowerGltfMaterialTextures } from "../src/lowering/gltf/material-textures.js";
import { gltfMaterialValueRuntime } from "../src/lowering/gltf/material-value-runtime.js";
import { lowerGltfTextureCache } from "../src/lowering/gltf/texture-cache.js";
import { lowerGltfParserJson } from "../src/lowering/gltf/parser-json.js";
import { transpileCommonJs } from "../src/typescript-transpile.js";
import { doctoredContext } from "./doctored-store.js";
import { cppFunction, cppRecord, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const loaderModule = "src/loader-gltf/load-gltf.ts", materialModule = "src/loader-gltf/gltf-material.ts";

test("glTF material and extension image caches retain identities, null results and rejected promises", async t => {
    const tools = optionalNativeFixtureTools();
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const contexts = [new LoweringContext(),
        doctoredContext(loaderModule, "matExts.length ? [] : null", "matExts.length > 1 ? [] : null"),
        doctoredContext(loaderModule, "if (!texInfo || !extFetchImg)", "if (!texInfo || !extFetchImg || sRGB)"),
        doctoredContext(loaderModule, "getCachedTexture(img, sRGB)", "getCachedTexture(img, !sRGB)"),
        doctoredContext(loaderModule, "const key = (matIdx ?? -1) + 1;", "const key = 0;"),
        doctoredContext(loaderModule, "if (!cached) {", "if (true) {"),
    ];
    const document = { textures: [{ source: 0 }, { source: 0 }, { source: 1 }, { source: 2 }, { source: 3 }], materials: [
        { pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 }, emissiveTexture: { index: 2 } },
        { pbrMetallicRoughness: { baseColorTexture: { index: 3 } }, normalTexture: { index: 4 } },
        { alphaMode: "BROKEN" }, {},
    ] };
    const requests = [0, 0, 1, 1, 2, 2, 3, null, null, 0];
    const infos = [null, { index: 0 }, { index: 1 }, { index: 0 }, { index: 2 }, { index: 2 },
        { index: 3 }, { index: 3 }, { index: 4 }, { index: 0 }];
    const rows = [];
    for (const context of contexts) {
        type Core = { _alphaMode: string; _baseColorImage: object | null };
        const reads: number[] = [];
        const resolveImage = (_json: object, _bin: object, index: number) => {
            reads.push(index);
            return index === 2 ? Promise.reject(new Error("image2")) : Promise.resolve(index === 1 ? null : { index });
        };
        const assemblySource = ["assembleMaterial", "makeImageFetcher"].map(name => context.functionDeclaration(materialModule, name).declaration.getText()).join("\n") +
            context.functionDeclaration("src/loader-gltf/gltf-parser.ts", "getTextureImageIndex").declaration.getText();
        const assembly = new Function("exports", "resolveImage", `${transpileCommonJs(assemblySource, materialModule)}\nreturn {assembleMaterial,makeImageFetcher};`)({}, resolveImage) as {
            assembleMaterial(...args: unknown[]): Promise<Core>; makeImageFetcher(...args: unknown[]): (info: object) => Promise<object | null>;
        };
        const variable = (owner: string, name: string) => {
            const declaration = context.functionDeclaration(loaderModule, owner).declaration;
            const found = context.findNodes(declaration, (node): node is ts.VariableDeclaration =>
                ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
            assert.equal(found.length, 1); assert.ok(found[0]!.initializer);
            return found[0]!.initializer.getText();
        };
        let assemblies = 0, builds = 0;
        const getMat = new Function("matCache", "assembleMaterial", "json", "binChunk", "baseUrl", "imageCache",
            `${transpileCommonJs(`const selected = ${variable("extractAllMeshes", "getMat")};`, loaderModule)}\nreturn selected;`)(
                [], (...args: unknown[]) => { ++assemblies; return assembly.assembleMaterial(...args); }, document, {}, "", []) as (index?: number) => Promise<Core>;
        const build = new Function("builtMaterialCache", "matExts", "_needsPbrExt", "buildSampledPbrTextures", "buildDefaultPbrTextures", "assemblePbrProps",
            "applyGltfOptInPbrFeatures", "engine", "sampler", "_generateMipmaps", "getCachedTexture",
            `${transpileCommonJs(`const selected = ${variable("uploadMeshes", "buildPbrFromGltfMat")};`, loaderModule)}\nreturn selected;`)(
                new Map(), [], false, undefined, () => ({}), (core: Core) => {
                    ++builds; if (core._alphaMode === "BROKEN") throw new Error("material"); return { serial: builds };
                }, async () => {}, {}, {}, () => {}, () => {}) as (core: Core) => Promise<{ serial: number }>;
        const identities: Core[] = [], outputs = [];
        let coreImage: object | null = null;
        for (const index of requests) {
            let identity = -1;
            try {
                const core = await getMat(index ?? undefined);
                if (!identities.includes(core)) identities.push(core);
                identity = identities.indexOf(core);
                if (index === 0) coreImage = core._baseColorImage;
                outputs.push({ identity, serial: (await build(core)).serial, error: "" });
            } catch (error) { assert.ok(error instanceof Error); outputs.push({ identity, serial: -1, error: error.message }); }
        }
        const materialReads = [...reads], extensions = [];
        const upload = context.functionDeclaration(loaderModule, "uploadMeshes").declaration.body!.statements;
        const first = upload.findIndex(statement => statement.getText().startsWith("const extImageCache"));
        assert.ok(first >= 0);
        const extensionJs = transpileCommonJs(upload.slice(first, first + 3).map(statement => statement.getText()).join("\n"), loaderModule);
        for (const count of [0, 1, 2]) {
            reads.length = 0;
            let uploads = 0, wraps = 0;
            const cache = new Map<object, Map<boolean, { image: object; srgb: boolean }>>();
            const getCached = (image: object, srgb: boolean) => {
                let entries = cache.get(image); if (!entries) { entries = new Map(); cache.set(image, entries); }
                let texture = entries.get(srgb); if (!texture) { ++uploads; texture = { image, srgb }; entries.set(srgb, texture); }
                return texture;
            };
            const ext = new Function("matExts", "makeImageFetcher", "json", "binChunk", "baseUrl", "engine", "getCachedTexture", "wrapTex",
                `${extensionJs}\nreturn extCtx;`)(Array(count).fill({}), assembly.makeImageFetcher, document, {}, "", {}, getCached,
                    (texture: { image: object; srgb: boolean }) => { ++wraps; return texture; }) as {
                        _texture(info: object | null, srgb: boolean): Promise<{ image: object; srgb: boolean } | undefined>;
                    };
            const selected = [];
            for (const [index, info] of infos.entries()) {
                try {
                    const texture = await ext._texture(info, index % 2 === 1);
                    selected.push(texture ? { state: "texture", srgb: texture.srgb, image: (texture.image as { index: number }).index,
                        sharedWithCore: texture.image === coreImage } : { state: "absent" });
                } catch (error) { assert.ok(error instanceof Error); selected.push({ state: error.message }); }
            }
            extensions.push({ count, reads: [...reads], uploads, wraps, selected });
        }
        rows.push({ outputs, assemblies, builds, reads: materialReads, extensions });
    }
    const directory = resolve("artifacts/gltf-material-cache");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "cases.json"), JSON.stringify({ document, requests, infos, rows }));
    const loader = new GltfLowerer(contexts[0]!).lowerLoaderAdapter().source;
    const file = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(file, `#include <bblite/runtime.hpp>
        #include <bblite/ts_runtime.hpp>
        #include <fstream>
        namespace bbl {
            using JsonObject = ts::JsonValue::Object;
            using JsonArray = ts::JsonValue::Array;
            ${["const ts::JsonValue* optional(", "std::vector<double> double_array("].map(signature => cppFunction(loader, signature)).join("\n")}
            ${contexts.map((context, variant) => `namespace variant${variant} {
                ${lowerGltfParserJson(context)}
                ${lowerGltfMaterialAssembly(context)}
                using GltfMaterialSampler = std::shared_ptr<const TextureSamplerState>;
                ${cppRecord(lowerGltfMaterialTextures(context), "struct GltfMaterialTexture {")}
                ${gltfMaterialValueRuntime}
                ${lowerGltfTextureCache(context)}
                ${lowerGltfMaterialCaches(context)}
                ${lowerGltfExtensionImages(context)}
                void check(const nlohmann::json& cases) {
                    const auto document = ts::JsonValue::from_native(cases.at("document"));
                    const auto& expected = cases.at("rows")[${variant}];
                    std::vector<std::size_t> reads;
                    const auto resolve_image = [&](std::size_t index) -> GltfMaterialImage {
                        reads.push_back(index);
                        if (index == 2) throw std::runtime_error("image2");
                        return index == 1 ? nullptr : std::make_shared<GltfMaterialImageSource>(GltfMaterialImageSource{index});
                    };
                    GltfMaterialImageCache image_cache;
                    GltfCoreMaterialCache core_cache;
                    GltfBuiltMaterialCache built_cache;
                    std::vector<GltfCoreMaterialRef> identities;
                    GltfMaterialImage core_image;
                    unsigned assemblies = 0, builds = 0;
                    for (std::size_t index = 0; index < cases.at("requests").size(); ++index) {
                        const auto& request = cases.at("requests")[index];
                        const auto& wanted = expected.at("outputs")[index];
                        int identity = -1;
                        try {
                            const auto core = gltf_cached_core_material(core_cache, request.is_null() ? js::Nullable<double>{} : js::Nullable<double>{request.get<double>()},
                                [&](double selected) -> GltfCoreMaterialRef { ++assemblies;
                                    return std::make_shared<GltfCoreMaterial>(assemble_gltf_material(document.as_object(), selected == -1 ? std::numeric_limits<std::size_t>::max() : gltf_checked_index(selected), image_cache, resolve_image));
                                }).get();
                            auto found = std::find(identities.begin(), identities.end(), core);
                            if (found == identities.end()) { identities.push_back(core); found = identities.end() - 1; }
                            identity = static_cast<int>(std::distance(identities.begin(), found));
                            if (request == 0) core_image = core->_baseColorImage;
                            const auto handle = gltf_cached_built_material(built_cache, core, [&](GltfCoreMaterialRef material) {
                                ++builds; if (material->_alphaMode == "BROKEN") throw std::runtime_error("material"); return MaterialHandle{builds};
                            }).get();
                            assert(wanted.at("error") == "" && handle.value == wanted.at("serial"));
                        } catch (const std::runtime_error& error) { assert(wanted.at("error") == error.what()); }
                        assert(identity == wanted.at("identity"));
                    }
                    assert(assemblies == expected.at("assemblies") && builds == expected.at("builds") && nlohmann::json(reads) == expected.at("reads"));
                    for (const auto& row : expected.at("extensions")) {
                        reads.clear(); unsigned uploads = 0, wraps = 0;
                        auto fetch = make_gltf_extension_image_fetcher(document.as_object(), row.at("count").get<double>(), resolve_image);
                        GltfTextureCache textures;
                        const auto cached = [&](GltfMaterialImage image, bool srgb) {
                            return gltf_cached_texture(textures, image, srgb, [&](GltfMaterialImage bitmap, bool encoded) {
                                ++uploads; return GltfMaterialTexture{bitmap, encoded, std::nullopt, nullptr};
                            });
                        };
                        for (std::size_t index = 0; index < cases.at("infos").size(); ++index) {
                            const auto info = ts::JsonValue::from_native(cases.at("infos")[index]);
                            const auto& wanted = row.at("selected")[index];
                            try {
                                const auto value = gltf_extension_texture(GltfPbrValue{&info}, index % 2 == 1, fetch, cached,
                                    [&](GltfMaterialTexture texture, const GltfPbrValue&) { ++wraps; return GltfPbrValue{texture}; });
                                if (value.undefined()) assert(wanted.at("state") == "absent");
                                else { assert(wanted.at("state") == "texture"); const auto& texture = value.texture();
                                    assert(texture.srgb == wanted.at("srgb") && texture.image->index == wanted.at("image"));
                                    assert((texture.image == core_image) == wanted.at("sharedWithCore")); }
                            } catch (const std::runtime_error& error) { assert(wanted.at("state") == error.what()); }
                        }
                        assert(uploads == row.at("uploads") && wraps == row.at("wraps") && nlohmann::json(reads) == row.at("reads"));
                    }
                }
            }`).join("\n")}
        }
        int main() { nlohmann::json cases; std::ifstream("cases.json") >> cases;
            ${contexts.map((_context, index) => `bbl::variant${index}::check(cases);`).join("\n")}
        }`);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/bigobj", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        "/I", "native/include", `/external:I${join(nativeFixtureVcpkgRoot, "include")}`, "/external:W0", `/Fo:${directory}/`, `/Fe:${executable}`, file]);
    execFileSync(executable, { cwd: directory, stdio: "pipe" });
});

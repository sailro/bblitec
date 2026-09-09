import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerGltfExtendedTexturePicker, lowerGltfSampledTexture, lowerGltfTextureCache } from "../src/lowering/gltf/texture-cache.js";
import { transpileCommonJs } from "../src/typescript-transpile.js";
import { doctoredContext } from "./doctored-store.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("glTF texture cache follows source keying, image identity and upload retry", t => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const original = new LoweringContext();
    const module = "src/loader-gltf/load-gltf.ts", source = original.sourceFile(module).text;
    const contexts = [original,
        doctoredContext(module, "const key = +srgb;", "const key = 0;"),
        doctoredContext(module, "if (!tex) {", "if (true) {")];
    assert.ok(source.includes("const key = +srgb;") && source.includes("if (!tex) {"));
    const requests = [[0, false], [0, true], [1, false], [0, false], [0, true], [1, true],
        [2, false], [3, false], [3, false], [3, false]] as const;
    const directory = resolve("artifacts/gltf-texture-cache");
    mkdirSync(directory, { recursive: true });
    const checks = contexts.map((context, variant) => {
        const { declaration } = context.functionDeclaration(module, "uploadMeshes");
        const selected = context.findNodes(declaration, (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "getCachedTexture")[0];
        assert.ok(selected?.initializer);
        let uploads = 0, fail = false;
        const images = [{ index: 0 }, { index: 1 }, { index: 0 }, { index: 2 }];
        const upload = (_engine: object, image: object, srgb: boolean) => {
            ++uploads;
            if (fail) throw new Error("injected upload failure");
            return { image, srgb, serial: uploads };
        };
        const selectedJs = transpileCommonJs(`const selected = ${selected.initializer.getText()};`, module);
        const cached = new Function("texCache", "engine", "sampler", "_generateMipmaps", "uploadTex", `${selectedJs}\nreturn selected;`)(
            new Map(), {}, {}, () => {}, upload) as (image: object, srgb: boolean) => { serial: number; srgb: boolean };
        const expected = requests.map(([image, srgb], index) => {
            fail = index === 7;
            try { const result = cached(images[image]!, srgb); return [result.serial, result.srgb] as const; }
            catch { assert.equal(index, 7); return [-1, false] as const; }
        });
        return `namespace variant${variant} {
            ${lowerGltfTextureCache(context)}
            void check() {
                GltfTextureCache cache;
                const std::array<GltfMaterialImage, 4> images{
                    std::make_shared<int>(0), std::make_shared<int>(1), std::make_shared<int>(0), std::make_shared<int>(2)};
                unsigned uploads = 0;
                bool fail = false;
                const auto upload = [&](GltfMaterialImage image, bool srgb) {
                    ++uploads;
                    if (fail) throw std::runtime_error("injected upload failure");
                    return GltfMaterialTexture{image, srgb, uploads};
                };
                ${requests.map(([image, srgb], index) => `{
                    fail = ${index === 7};
                    try {
                        const auto result = gltf_cached_texture(cache, images[${image}], ${srgb}, upload);
                        assert(${expected[index]![0]} >= 0);
                        assert(static_cast<int>(result.serial) == ${expected[index]![0]} && result.srgb == ${expected[index]![1]});
                        assert(result.image == images[${image}]);
                    } catch (const std::runtime_error&) { assert(${expected[index]![0]} == -1); }
                }`).join("\n")}
                assert(uploads == ${uploads}u && cache.size() == 4);
                GltfTextureCache separate;
                fail = false;
                const auto other = gltf_cached_texture(separate, images[0], false, upload);
                assert(other.serial == ${uploads + 1}u && separate.size() == 1);
            }
        }`;
    });
    const file = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(file, `#include <bblite/js_data.hpp>
        using GltfMaterialImage = std::shared_ptr<int>;
        struct GltfMaterialTexture {
            GltfMaterialImage image;
            bool srgb = false;
            unsigned serial = 0;
            explicit operator bool() const { return bool(image); }
        };
        ${checks.join("\n")}
        int main() { variant0::check(); variant1::check(); variant2::check(); }
    `);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        "/I", "native/include", `/Fo:${directory}/`, `/Fe:${executable}`, file]);
    execFileSync(executable, { stdio: "pipe" });
});

test("sampled wrappers and extension caches follow source branching, keys and upload retry", t => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const ext = "src/loader-gltf/gltf-pbr-builder-ext.ts", sampled = "src/loader-gltf/gltf-sampler-desc.ts";
    const contexts = [new LoweringContext(),
        doctoredContext(ext, "const key = id * 2 + (srgb ? 1 : 0);", "const key = 0;"),
        doctoredContext(ext, "if (!samplerFor) {", "if (true) {"),
        doctoredContext(ext, "if (!tex) {", "if (true) {"),
        doctoredContext(sampled, "if (s === defaultSampler) {", "if (false) {"),
        doctoredContext(sampled, "{ ...tex, sampler: s }", "{ ...tex, sampler: defaultSampler }"),
    ];
    const requests = [[0, false, 0], [0, false, 1], [0, true, 0], [1, false, 0], [0, false, 2],
        [0, false, 2], [0, false, 3], [0, false, 3], [2, false, 0], [2, false, 0], [2, false, 0]] as const;
    const directory = resolve("artifacts/gltf-texture-wrappers");
    mkdirSync(directory, { recursive: true });
    const checks = contexts.map((context, variant) => {
        const picker = context.functionDeclaration(ext, "buildDefaultPbrTexturesExt").declaration;
        const samplerBuilder = context.functionDeclaration(sampled, "buildSampledPbrTextures").declaration;
        const cached = context.findNodes(samplerBuilder, (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "cached")[0];
        assert.ok(cached?.initializer);
        const pickerJs = transpileCommonJs(picker.body!.statements.slice(1, 5).map(statement => statement.getText()).join("\n"), ext);
        const sampledJs = transpileCommonJs(`const cached = ${cached.initializer.getText()};`, sampled);
        const rows = [false, true, "sampled"].map(mode => {
            type Sampler = { id: number };
            type Texture = { image: object; srgb: boolean; sampler: Sampler; serial: number };
            const samplers = [{ id: 0 }, { id: 1 }], images = [{}, {}, {}], infos = [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }];
            let uploads = 0, fail = false, registered = 0;
            const samplerFor = (info: { index: number }) => info.index === 3 ? { id: 2 } : samplers[info.index === 2 ? 1 : 0]!;
            const defaultSampler = samplers[0]!;
            const upload = (_engine: object, image: object, srgb: boolean, sampler: Sampler) => {
                if (fail) throw new Error("injected upload failure");
                return { image, srgb, sampler, serial: ++uploads };
            };
            const cache = new Map<object, Map<boolean, Texture>>();
            const getCachedTex = (image: object, srgb: boolean) => {
                let textures = cache.get(image);
                if (!textures) { textures = new Map(); cache.set(image, textures); }
                let texture = textures.get(srgb);
                if (!texture) { texture = upload({}, image, srgb, defaultSampler); textures.set(srgb, texture); }
                return texture;
            };
            const build = mode === "sampled" ? new Function("samplerFor", "getCachedTex", "defaultSampler", "engine", `${sampledJs}\nreturn cached;`)(
                samplerFor, getCachedTex, defaultSampler, { _dlr: { d() { ++registered; } } }) :
                new Function("samplerFor", "getCachedTex", "engine", "generateMipmaps", "uploadTex", `${pickerJs}\nreturn pickTex;`)(
                    mode ? samplerFor : undefined, getCachedTex, {}, () => {}, upload);
            const run = build as (image: object, srgb: boolean, info: { index: number }) => Texture;
            const outputs = requests.map(([image, srgb, info], index) => {
                fail = index === 8;
                try {
                    const texture = run(images[image]!, srgb, infos[info]!);
                    return { serial: texture.serial, image: images.indexOf(texture.image), srgb: texture.srgb, sampler: texture.sampler.id };
                } catch { assert.ok(fail); return { serial: -1, image: -1, srgb: false, sampler: -1 }; }
            });
            return `{
                unsigned uploads = 0, registered = 0;
                bool fail = false;
                const auto upload = [&](GltfMaterialImage image, bool srgb, GltfMaterialSampler sampler) {
                    if (fail) throw std::runtime_error("injected upload failure");
                    return GltfMaterialTexture{image, srgb, ++uploads, sampler};
                };
                GltfTextureCache cache;
                const auto get_cached = [&](GltfMaterialImage image, bool srgb) {
                    return gltf_cached_texture(cache, image, srgb, [&](GltfMaterialImage bitmap, bool encoded) { return upload(bitmap, encoded, samplers[0]); });
                };
                ${mode === "sampled" ? `const auto run = [&](GltfMaterialImage image, bool srgb, const ts::JsonValue* info) {
                    return gltf_sampled_texture(image, srgb, info, samplers[0], sampler_for, get_cached,
                        [&](const GltfMaterialTexture&, const GltfMaterialTexture&) { ++registered; });
                };` : `auto run = gltf_extended_texture_picker(${mode ? "sampler_for" : "std::function<GltfMaterialSampler(const ts::JsonValue*)>{}"}, get_cached, upload);`}
                ${requests.map(([image, srgb, info], index) => `{
                    fail = ${index === 8};
                    try {
                        const auto texture = run(images[${image}], ${srgb}, &infos[${info}]);
                        assert(static_cast<int>(texture.serial) == ${outputs[index]!.serial});
                        assert(*texture.image == ${outputs[index]!.image} && texture.srgb == ${outputs[index]!.srgb});
                        assert(*texture.sampler == ${outputs[index]!.sampler});
                    } catch (const std::runtime_error&) { assert(${outputs[index]!.serial} == -1); }
                }`).join("\n")}
                assert(uploads == ${uploads}u && registered == ${registered}u);
            }`;
        });
        return `namespace variant${variant} {
            ${lowerGltfTextureCache(context)}
            ${lowerGltfSampledTexture(context)}
            ${lowerGltfExtendedTexturePicker(context)}
            void check() {
                const std::array<GltfMaterialImage, 3> images{std::make_shared<int>(0), std::make_shared<int>(1), std::make_shared<int>(2)};
                const std::array<GltfMaterialSampler, 2> samplers{std::make_shared<int>(0), std::make_shared<int>(1)};
                const std::array<ts::JsonValue, 4> infos{{{0}, {1}, {2}, {3}}};
                const std::function<GltfMaterialSampler(const ts::JsonValue*)> sampler_for = [&](const ts::JsonValue* info) {
                    return info->index == 3 ? std::make_shared<int>(2) : samplers[info->index == 2 ? 1 : 0];
                };
                ${rows.join("\n")}
            }
        }`;
    });
    const file = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(file, `#include <bblite/js_data.hpp>
        #include <functional>
        namespace ts { struct JsonValue { int index; }; }
        using GltfMaterialImage = std::shared_ptr<int>;
        using GltfMaterialSampler = std::shared_ptr<int>;
        struct GltfMaterialTexture {
            GltfMaterialImage image;
            bool srgb = false;
            unsigned serial = 0;
            GltfMaterialSampler sampler;
            explicit operator bool() const { return bool(image); }
        };
        ${checks.join("\n")}
        int main() { ${contexts.map((_context, index) => `variant${index}::check();`).join(" ")} }
    `);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        "/I", "native/include", `/Fo:${directory}/`, `/Fe:${executable}`, file]);
    execFileSync(executable, { stdio: "pipe" });
});

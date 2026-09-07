import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { FactoryLowerer } from "../src/lowering/factory/material-factories.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

interface SourceTexture {
    texture: object;
    view: object;
    sampler: object;
    width: number;
    height: number;
}
interface SourceMaterial {
    baseColorTexture?: SourceTexture;
    baseColorFactor?: readonly number[];
    diffuseTexture?: SourceTexture | null;
    diffuseColor?: readonly number[];
}

test("material texture reads distinguish source-family slots and omitted PBR props", () => {
    const result = compileSource(`
        import { createEngine, createPbrMaterial, createStandardMaterial, createSolidTexture2D } from "@babylonjs/lite";
        import type { Material, Texture2D } from "@babylonjs/lite";
        function albedo(mat: Material): Texture2D | undefined {
            const m = mat as { baseColorTexture?: Texture2D; diffuseTexture?: Texture2D };
            return m.baseColorTexture ?? m.diffuseTexture;
        }
        async function main() {
            const engine = await createEngine({});
            const absent = createPbrMaterial({});
            const present = createPbrMaterial({baseColorTexture: createSolidTexture2D(engine, .2, .3, .4)});
            const standard = createStandardMaterial();
            const slots = [albedo(absent), albedo(present), albedo(standard)];
            if (slots[0] || !slots[1] || slots[2]) throw new Error("source presence");
        }
    `);
    assert.match(result.cpp, /\.has_base_color_texture = false/);
    assert.match(result.cpp, /\.has_base_color_texture = true/);
    assert.match(result.cpp, /material_texture_present\([^;]+MaterialTextureSlot::base_color/);
    assert.match(result.cpp, /material_texture_present\([^;]+MaterialTextureSlot::diffuse/);
    const factory = new FactoryLowerer(new LoweringContext()).lowerPbrMaterialFactory().source;
    assert.match(factory, /material\.has_public_base_color_texture = options\.has_base_color_texture;/);
});

test("material texture fallback bytes and presence match actual pinned producers", async (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const { createPbrMaterial } = await importPinnedModule<{
        createPbrMaterial(props: SourceMaterial): SourceMaterial;
    }>("material/pbr/pbr-material.js");
    const { createStandardMaterial } = await importPinnedModule<{
        createStandardMaterial(): SourceMaterial;
    }>("material/standard/create-standard-material.js");
    const uploads: number[][] = [];
    const formats: string[] = [];
    const engine = {_device: {
        createTexture(descriptor: {format: string}) {
            formats.push(descriptor.format);
            return {createView: () => ({})};
        },
        queue: {writeTexture(_target: object, bytes: Uint8Array) {uploads.push([...bytes]);}},
    }};
    const { uploadBaseColorFactorTexture, assemblePbrProps } = await importPinnedModule<{
        uploadBaseColorFactorTexture(engine: object, factor: readonly number[], sampler: object, mipmaps: () => void): SourceTexture;
        assemblePbrProps(mat: object, base: SourceTexture, orm: SourceTexture, normal: undefined,
            emissive: undefined, extensions: object): SourceMaterial;
    }>("loader-gltf/gltf-pbr-builder.js");
    const factor = [.12, .34, .56, .78];
    const sampler = {};
    const baked = uploadBaseColorFactorTexture(engine, factor, sampler, () => {});
    const loaded = assemblePbrProps({_baseColorFactor: factor, _baseColorImage: null,
        _normalScale: 1, _doubleSided: false, _alphaMode: "OPAQUE"}, baked, baked, undefined, undefined, {});
    const absent = createPbrMaterial({});
    const explicit = createPbrMaterial({baseColorTexture: baked});
    const standard = createStandardMaterial();
    assert.equal(loaded.baseColorTexture, baked);
    assert.equal(loaded.baseColorFactor, undefined);
    assert.equal(loaded.diffuseTexture, undefined);
    assert.equal(absent.baseColorTexture, undefined);
    assert.equal(explicit.baseColorTexture, baked);
    assert.equal(standard.baseColorTexture, undefined);
    assert.equal(standard.diffuseTexture, null);
    assert.equal(baked.sampler, sampler);
    assert.equal(baked.width, 1);
    assert.equal(baked.height, 1);
    assert.deepEqual(formats, ["rgba8unorm-srgb"]);
    assert.equal(uploads.length, 1);

    const directory = resolve("artifacts/test-material-source-reads");
    mkdirSync(directory, {recursive: true});
    const source = resolve(directory, "check.cpp");
    const executable = resolve(directory, "check.exe");
    writeFileSync(source, `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
int main() {
    using namespace bbl;
    Engine engine;
    engine.materials.resize(5);
    const MaterialHandle absent{0}, baked{1}, standard{2}, image{3}, standard_image{4};
    auto& loaded = engine.materials[baked.value];
    loaded.has_public_base_color_texture = true;
    loaded.base_color_srgb = true;
    loaded.base_color_fallback = {${uploads[0]!.join(",")}};
    engine.materials[standard.value].standard_material = true;
    auto& textured = engine.materials[image.value];
    textured.has_public_base_color_texture = true;
    textured.base_color_texture.bytes = std::vector<std::uint8_t>{1,2,3,4};
    textured.base_color_texture.rgba_width = 1;
    textured.base_color_texture.rgba_height = 1;
    textured.base_color_texture.uv_transform.u_offset = .125;
    textured.base_color_texture.invert_y = true;
    engine.materials[standard_image.value] = textured;
    engine.materials[standard_image.value].standard_material = true;
    assert(!material_texture_present(engine, absent, MaterialTextureSlot::base_color));
    assert(material_texture_present(engine, baked, MaterialTextureSlot::base_color));
    assert(!material_texture_present(engine, baked, MaterialTextureSlot::diffuse));
    assert(!material_texture_present(engine, standard, MaterialTextureSlot::base_color));
    assert(!material_texture_present(engine, standard, MaterialTextureSlot::diffuse));
    assert(!material_texture_present(engine, standard_image, MaterialTextureSlot::base_color));
    assert(material_texture_present(engine, standard_image, MaterialTextureSlot::diffuse));
    const auto diffuse = material_texture(engine, standard_image, MaterialTextureSlot::diffuse);
    assert(!diffuse.srgb && diffuse.data.bytes.size() == 4);
    const auto a = material_texture(engine, baked, MaterialTextureSlot::base_color);
    const auto b = material_texture(engine, baked, MaterialTextureSlot::base_color);
    assert(a.identity == b.identity && a.width == 1 && a.height == 1 && a.srgb);
    const std::vector<std::uint8_t> expected{${uploads[0]!.join(",")}};
    assert(std::equal(a.data.bytes.begin(), a.data.bytes.end(), expected.begin(), expected.end()));
    const auto c = material_texture(engine, image, MaterialTextureSlot::base_color);
    assert(c.identity != a.identity && c.width == 1 && c.height == 1);
    assert(c.data.uv_transform.u_offset == .125 && c.data.invert_y);
    const auto retained = c;
    engine.materials.clear();
    assert(retained.data.bytes.size() == 4 && retained.data.bytes[2] == 3);
}
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/EHsc", "/W4", "/WX", "/Od",
        `/I${resolve("native/include")}`, source, `/Fe:${executable}`, `/Fo:${resolve(directory, "check.obj")}`]);
    execFileSync(executable, [], {stdio: "pipe"});
});

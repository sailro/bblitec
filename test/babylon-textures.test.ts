import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { BabylonLowerer } from "../src/lowering/babylon-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { FactoryLowerer } from "../src/lowering/factory/material-factories.js";
import { lowerBabylonTextureSlots } from "../src/lowering/babylon-textures.js";
import { importPinnedModuleFetching } from "../src/pinned-shader-composer.js";
import { pinnedBabylonMaterials } from "../src/pinned-babylon-materials.js";
import { doctoredContext } from "./doctored-store.js";
import { cppFunction, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("unknown texture descriptor and side effects refuse at their source", () => {
    assert.throws(() => lowerBabylonTextureSlots(doctoredContext("src/loader-babylon/load-babylon.ts",
        'level: "bumpLevel",', 'level: "unknownLevel",')), /Unsupported Babylon texture property 'unknownLevel'/);
    assert.throws(() => lowerBabylonTextureSlots(doctoredContext("src/loader-babylon/load-babylon.ts",
        "m.opacityFromRGB = true;", "m.unknownProperty = true;")), /Unsupported Babylon texture property 'unknownProperty'/);
});

test("Babylon texture slots preserve pinned defaults, guards, assignments and factory calls", async t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const populated = {
        id: "populated",
        diffuseTexture: { name: "diffuse.png", level: .17, uScale: 2.25, vScale: -.37, coordinatesIndex: 1, hasAlpha: true },
        bumpTexture: { name: "bump.png", level: .27 },
        specularTexture: { name: "specular.png", coordinatesIndex: 1 },
        ambientTexture: { name: "ambient.png", level: .47, coordinatesIndex: 1 },
        lightmapTexture: { name: "lightmap.png", level: .57, coordinatesIndex: 0 },
        opacityTexture: { name: "opacity.png", level: .67, getAlphaFromRGB: true },
        reflectionTexture: { name: "reflection.png", level: .77, coordinatesMode: 2 },
    };
    const materials = [populated, {
        id: "null-properties", diffuseTexture: { name: "default-diffuse.png", uScale: null, vScale: null, hasAlpha: false, coordinatesIndex: 2 },
        bumpTexture: { name: "default-bump.png", level: null },
        specularTexture: { name: "default-specular.png", coordinatesIndex: null },
        ambientTexture: { name: "default-ambient.png", level: null, coordinatesIndex: 0 },
        lightmapTexture: { name: "default-lightmap.png", level: null, coordinatesIndex: null },
        opacityTexture: { name: "default-opacity.png", level: null, getAlphaFromRGB: false },
        reflectionTexture: { name: "default-reflection.png", level: null, coordinatesMode: null },
    }, { id: "absent" }, { id: "null-slots", diffuseTexture: null, bumpTexture: null, specularTexture: null,
        ambientTexture: null, lightmapTexture: null, opacityTexture: null, reflectionTexture: null },
        { id: "cube", reflectionTexture: { name: "cube", isCube: true, level: .87 } },
        { id: "repeated-url", diffuseTexture: { name: "diffuse.png", wrapU: 0, wrapV: 2 } }];
    const document = { materials, meshes: materials.map(material => ({
        id: material.id, name: material.id, materialId: material.id,
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2],
    })) };
    type PinMaterial = Record<string, unknown> & { uvScale: number[] };
    const properties = ["diffuseCoordIndex", "specularCoordIndex", "ambientCoordIndex", "lightmapCoordIndex", "bumpLevel",
        "ambientTexLevel", "lightmapLevel", "opacityLevel", "reflectionLevel", "reflectionCoordMode", "opacityFromRGB", "alphaCutOff"];
    const textures = ["diffuseTexture", "_bumpTexture", "_specularTexture", "_ambientTexture", "_lightmapTexture", "_opacityTexture", "_reflectionTexture", "_reflectionCubeTexture"];
    const imported = await importPinnedModuleFetching<{
        loadBabylon(engine: object, url: string): Promise<{ entities: Array<{ material: PinMaterial }> }>;
    }>("loader-babylon/load-babylon.js", () => Buffer.from(JSON.stringify(document)));
    const bitmapProperty = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
    Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: async () => ({ width: 1, height: 1, close() {} }) });
    const fetch = t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array([1])));
    let expected: number[][];
    try {
        const engine = { _device: {
            createBuffer({ size }: { size: number }) { const bytes = new ArrayBuffer(size); return { getMappedRange: () => bytes, unmap() {} }; },
            createTexture() { return { mipLevelCount: 1, createView() { return {}; } }; }, createSampler() { return {}; },
            createCommandEncoder() { return { finish() { return {}; } }; },
            queue: { copyExternalImageToTexture() {}, submit() {} },
        } };
        const loaded = await imported.module.loadBabylon(engine, "https://fixture/textures.babylon");
        expected = loaded.entities.map(({ material }) => [
            ...properties.map(name => Number(material[name])), ...material.uvScale,
            ...textures.map(name => material[name] ? 1 : 0),
        ]);
        assert.equal(expected.length, materials.length);
        assert.deepEqual(expected[0]!.slice(14, 21), [1, 1, 1, 1, 1, 1, 1]);
        assert.equal(loaded.entities[0]!.material.diffuseTexture, loaded.entities[5]!.material.diffuseTexture);
    } finally {
        imported.release(); fetch.mock.restore();
        if (bitmapProperty) Object.defineProperty(globalThis, "createImageBitmap", bitmapProperty);
        else Reflect.deleteProperty(globalThis, "createImageBitmap");
    }
    const composed = await pinnedBabylonMaterials(materials);
    assert.deepEqual(composed.map(material => [
        ...properties.map(name => Number(material[name])), ...(material.uvScale as number[]),
        ...textures.map(name => material[name] ? 1 : 0),
    ]), expected);
    const context = new LoweringContext();
    const loader = new BabylonLowerer(context).lowerLoaderAdapter().source;
    const fileTexture = cppFunction(new FactoryLowerer(context).lowerFileTextureFactory().source, "FileTexture load_file_texture(");
    const helpers = [
        "void apply_babylon_material_properties(", "template <typename LoadTexture>", "template <typename LoadCube>", "MaterialHandle load_material(" ]
        .map(signature => cppFunction(loader, signature)).join("\n");
    const changed = lowerBabylonTextureSlots(doctoredContext("src/loader-babylon/load-babylon.ts",
        "if (t.hasAlpha) {\n                m.alphaCutOff = 0.4;", "if (!t.hasAlpha) {\n                m.alphaCutOff = 0.6;"))
        .replace("apply_babylon_texture_slots(", "changed_texture_slots(");
    const directory = resolve("artifacts/test-babylon-textures");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "source.json"), JSON.stringify(document));
    writeFileSync(join(directory, "expected.json"), JSON.stringify(expected));
    const source = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(source, `#include <bblite/runtime.hpp>
#include <bblite/pal_image.hpp>
#include <nlohmann/json.hpp>
#include <cassert>
#include <fstream>
#include <cstdio>
namespace bbl {
using Json = nlohmann::json;
namespace pal {
std::vector<std::string> loaded;
bool fail_read=false;
std::vector<std::uint8_t> read_binary_file(const std::string& path) {
    loaded.push_back(path);
    if(fail_read) { fail_read=false; throw std::runtime_error("fixture read failure"); }
    return {1};
}
DecodedImage decode_image(const js::ArrayBuffer&) { return {1,1,{1,2,3,4}}; }
std::string join_path(const std::string& a, const std::string& b) { return a+b; }
}
${fileTexture}
${helpers}
${changed}
}
int main() {
    using namespace bbl;
    Json document, expected;
    std::ifstream("source.json") >> document;
    std::ifstream("expected.json") >> expected;
    Engine engine;
    std::unordered_map<std::string,std::uint32_t> cubes;
    for(std::size_t row=0;row<document.at("materials").size();++row) {
        const auto handle=load_material(engine,document.at("materials")[row],"fixture/",{0,0,0},cubes,true);
        const auto& m=engine.materials.at(handle.value);
        const std::array<double,22> actual{double(m.diffuse_coord_index),double(m.specular_coord_index),double(m.ambient_coord_index),
            m.lightmap_coord_index,m.bump_scale,m.ambient_level,m.lightmap_level,m.opacity_level,m.reflection_level,m.reflection_coord_mode,
            m.opacity_from_rgb?1.0:0.0,m.alpha_cutoff,m.diffuse_u_scale,m.diffuse_v_scale,
            m.base_color_texture.has_image()?1.0:0.0,m.bump_texture.has_image()?1.0:0.0,m.specular_texture.has_image()?1.0:0.0,
            m.ambient_texture.has_image()?1.0:0.0,m.lightmap_texture.has_image()?1.0:0.0,m.opacity_texture.has_image()?1.0:0.0,
            m.reflection_texture.has_image()?1.0:0.0,m.reflection_cube!=std::numeric_limits<std::uint32_t>::max()?1.0:0.0};
        for(std::size_t lane=0;lane<actual.size();++lane) {
            const auto wanted=expected[row][lane].get<double>();
            if(std::abs(actual[lane]-wanted)>=1e-6) std::fprintf(stderr,"row %zu lane %zu %.9g != %.9g\\n",row,lane,actual[lane],wanted);
            assert(std::abs(actual[lane]-wanted)<1e-6);
        }
        assert(m.diffuse_level==1);
    }
    assert(pal::loaded.size()==20);
    assert(pal::loaded.front()=="fixture/diffuse.png");
    assert(pal::loaded[4]=="fixture/lightmap.png");
    const auto first=std::get<FileTexture>(material_source_texture(engine,MaterialHandle{0},MaterialTextureSlot::diffuse));
    const auto repeated=std::get<FileTexture>(material_source_texture(engine,MaterialHandle{5},MaterialTextureSlot::diffuse));
    assert(first==repeated);
    assert(repeated.data.sampler.address_u==TextureAddressMode::repeat && repeated.data.sampler.address_v==TextureAddressMode::repeat);
    const auto other_options=load_file_texture(engine,"fixture/diffuse.png",first.data.sampler,false,false);
    assert(!(first==other_options) && pal::loaded.size()==21);
    assert(load_file_texture(engine,"fixture/diffuse.png",first.data.sampler,false,false)==other_options);
    assert(pal::loaded.size()==21);
    pal::fail_read=true;
    bool refused=false;
    try { static_cast<void>(load_file_texture(engine,"retry.png",first.data.sampler,true,false)); }
    catch(const std::runtime_error&) { refused=true; }
    assert(refused);
    const auto retry=load_file_texture(engine,"retry.png",first.data.sampler,true,false);
    assert(retry.data.has_image() && pal::loaded.size()==23);
    assert(load_file_texture(engine,"retry.png",first.data.sampler,true,false)==retry && pal::loaded.size()==23);
    MaterialRecord changed;
    int loads=0;
    auto load=[&](const char*,const std::string&) { ++loads; return FileTexture{}; };
    changed_texture_slots(changed,Json{{"diffuseTexture",{{"name","x"},{"hasAlpha",false}}}},"",load);
    assert(changed.alpha_cutoff==.6f && loads==1);
    changed.alpha_cutoff=0;
    changed_texture_slots(changed,Json{{"diffuseTexture",{{"name","x"},{"hasAlpha",true}}}},"",load);
    assert(changed.alpha_cutoff==0 && loads==2);
    apply_babylon_texture_slots(changed,document.at("materials")[0],"",load,false);
    assert(changed.alpha_cutoff==0 && loads==2);
}`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2", `/Fo:${directory}/`, `/Fe:${executable}`,
        "/I", "native/include", "/I", join(nativeFixtureVcpkgRoot, "include"), source]);
    execFileSync(executable, [], { cwd: directory, stdio: "pipe" });
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { BabylonLowerer } from "../src/lowering/babylon-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { importPinnedModuleFetching } from "../src/pinned-shader-composer.js";
import { cppFunction, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("Babylon material hydration copies pinned RGB, defaults and retained aliases before registration", async (t) => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    // HillValley exports four channels; only the first three become diffuseColor.
    const shared = [.123456789012345, .4, .75, 0];
    const materials = [
        { id: "rgba", diffuse: shared }, { id: "same-values", diffuse: shared },
        { id: "rgb", diffuse: [.2, .3, .4] }, { id: "unused-tail", diffuse: [.3, .4, .5, "ignored"] },
        { id: "white", diffuse: [1, 1, 1, 0] }, { id: "absent" }, { id: "null", diffuse: null },
    ];
    const document = { materials, meshes: materials.map(material => ({
        id: material.id, name: material.id, materialId: material.id,
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2],
    })) };
    interface PinMaterial { diffuseColor: number[] }
    interface PinAsset { entities: Array<{ material: PinMaterial }> }
    const imported = await importPinnedModuleFetching<{
        loadBabylon(engine: object, url: string, options: object): Promise<PinAsset>;
    }>("loader-babylon/load-babylon.js", () => Buffer.from(JSON.stringify(document)));
    let colors: number[][];
    try {
        // Only GPU byte allocation is replaced; the loader and mesh/material factories execute unchanged.
        const engine = { _device: { createBuffer({ size }: { size: number }) {
            const bytes = new ArrayBuffer(size);
            return { getMappedRange: () => bytes, unmap() {} };
        } } };
        const loaded = await imported.module.loadBabylon(engine, "https://fixture/colors.babylon", { loadTextures: false });
        const rows = loaded.entities.map(mesh => mesh.material);
        colors = rows.map(material => [...material.diffuseColor]);
        assert.deepEqual(colors, [shared.slice(0, 3), shared.slice(0, 3), [.2, .3, .4], [.3, .4, .5], [1, 1, 1], [1, 1, 1], [1, 1, 1]]);
        const alias = rows[0]!.diffuseColor;
        assert.equal(alias, rows[0]!.diffuseColor);
        assert.notEqual(alias, rows[1]!.diffuseColor);
        alias[0] = .875;
        assert.equal(rows[0]!.diffuseColor[0], .875);
        assert.equal(rows[1]!.diffuseColor[0], shared[0]);
        assert.equal(shared.length, 4);
    } finally { imported.release(); }

    const context = new LoweringContext();
    const loader = new BabylonLowerer(context).lowerLoaderAdapter().source;
    const helpers = ["float number_at(", "double double_at(", "Vec3 vec3_or(",
        "Color3 color3_or(", "TextureAddressMode address_mode(", "TextureData texture_data(",
        "MaterialHandle load_material(", "MaterialHandle default_material("].map(signature => cppFunction(loader, signature)).join("\n");
    const scene = new SceneLowerer(context).lowerCore().source;
    const registration = ["void require_scene_engine(", "std::uint32_t material_family_bit(", "std::uint32_t scene_material_families(",
        "void drain_scene_deferred_builders(", "void register_scene("].map(signature => cppFunction(scene, signature)).join("\n");
    const directory = resolve("artifacts/test-babylon-material-colors");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "source.json"), JSON.stringify(document));
    writeFileSync(join(directory, "expected.json"), JSON.stringify(colors));
    const source = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(source, `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <nlohmann/json.hpp>
#include <cassert>
#include <fstream>
#include <cstdio>
namespace bbl {
using Json = nlohmann::json;
namespace pal {
std::vector<std::uint8_t> read_binary_file(const std::string&) { throw std::runtime_error("unexpected texture read"); }
std::string join_path(const std::string& a,const std::string& b) { return a+"/"+b; }
}
${helpers}
${registration}
}
int main() {
    using namespace bbl;
    Json document, expected;
    std::ifstream("source.json") >> document;
    std::ifstream("expected.json") >> expected;
    Engine engine;
    Scene scene;scene.engine=&engine;
    std::unordered_map<std::string,std::uint32_t> reflections;
    std::vector<MaterialHandle> materials;
    for (const auto& row : document.at("materials")) {
        const auto material=load_material(engine,row,"",Color3{},reflections);
        materials.push_back(material);
        const auto color=*material_color(engine,material,MaterialColorSlot::diffuse_color);
        assert(color.size()==3);
        for(std::size_t channel=0;channel<3;++channel) assert(color[channel]==expected[materials.size()-1][channel].get<double>());
        engine.meshes.emplace_back();engine.meshes.back().material=material;
        scene.meshes.push_back(MeshHandle{static_cast<std::uint32_t>(engine.meshes.size()-1)});
    }
    auto alias=*material_color(engine,materials[0],MaterialColorSlot::diffuse_color);
    assert(alias==*material_color(engine,materials[0],MaterialColorSlot::diffuse_color));
    assert(alias!=*material_color(engine,materials[1],MaterialColorSlot::diffuse_color));
    document["materials"][0]["diffuse"][0]=.5;
    assert(alias[0]==expected[0][0].get<double>());
    alias[0]=.875;
    assert((*material_color(engine,materials[1],MaterialColorSlot::diffuse_color))[0]==expected[1][0].get<double>());
    const auto fallback=default_material(engine);
    const auto fallback_color=*material_color(engine,fallback,MaterialColorSlot::diffuse_color);
    assert(fallback_color.size()==3 && fallback_color[0]==1 && fallback_color[1]==1 && fallback_color[2]==1);
    assert(fallback_color!=*material_color(engine,materials[5],MaterialColorSlot::diffuse_color));
    register_scene(scene);
    assert(engine.registered_scenes.size()==1);
    for(std::size_t i=0;i<materials.size();++i) {
        const auto& color=engine.materials[materials[i].value].diffuse_color;
        assert(color.r==static_cast<float>(i==0?.875:expected[i][0].get<double>()));
        assert(color.g==expected[i][1].get<float>() && color.b==expected[i][2].get<float>());
    }
    for(const char* malformed : {R"({"diffuse":[1,2]})",R"({"diffuse":[1,null,3]})"}) {
        const auto count=engine.materials.size();
        bool refused=false;
        try {load_material(engine,Json::parse(malformed),"",Color3{},reflections);} catch(const std::runtime_error&) {refused=true;}
        assert(refused && engine.materials.size()==count);
    }
    engine.materials.clear();assert(alias[0]==.875 && alias.size()==3);
    std::puts("babylon-material-colors: ok");
}
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2", `/Fo:${directory}/`, `/Fe:${executable}`,
        "/I", "native/include", "/I", join(nativeFixtureVcpkgRoot, "include"), source]);
    assert.match(execFileSync(executable, { cwd: directory, encoding: "utf8" }), /babylon-material-colors: ok/);
});

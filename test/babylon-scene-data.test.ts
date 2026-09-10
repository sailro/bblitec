import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { BabylonLowerer } from "../src/lowering/babylon-lowerer.js";
import { CameraLowerer } from "../src/lowering/camera-lowerer.js";
import { FactoryLowerer } from "../src/lowering/factory/material-factories.js";
import { LightLowerer } from "../src/lowering/light-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedWorldTransformHeader } from "../src/lowering/pinned-world-transform.js";
import { importPinnedModuleFetching } from "../src/pinned-shader-composer.js";
import { pinnedBabylonMaterials } from "../src/pinned-babylon-materials.js";
import { cppFunction, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("Babylon scene data preserves material map replacement, light guards and loader options", async t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const mesh = (id: string, materialId: string, subMeshes?: object[]) => ({ id, name: id, materialId, subMeshes,
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] });
    const document = {
        clearColor: [.1, .2, .3], ambientColor: [.4, .5, .6], activeCameraID: "",
        cameras: [{ id: "first", position: [1, 2, 3] }, { id: "", position: [4, 5, 6] }],
        materials: [{ id: "shared", alpha: .25 }, { id: "shared", alpha: .5, ambient: [.2, .3, .4], diffuseTexture: { name: "unreachable.png" } },
            { id: "", alpha: .75 }, { id: "base", alpha: .8 }, { id: "other", alpha: .9 }],
        multiMaterials: [{ id: "multi", materials: ["base"] }, { id: "multi", materials: ["shared", "missing"] }],
        meshes: [mesh("a", "shared"), mesh("split", "multi", [0, 1].map(materialIndex => ({ materialIndex, indexStart: 0, indexCount: 3 }))),
            mesh("c", "missing"), mesh("d", "")],
        lights: [
            { type: 0, position: [1, 2, 3], intensity: .5, range: 8, diffuse: [.2, .3, .4], specular: [.5, .6, .7], includedOnlyMeshesIds: ["split", "split", "missing"] },
            { type: 0, position: [0, -1, 0], intensity: null, range: null, excludedMeshesIds: ["a"] },
            { type: 0 }, { type: 1, position: [0, 0, 0] },
        ],
    };
    interface PinNode {
        _gpu?: object; material: { alpha: number; ambientColor: number[] };
        lightType?: string; position: { x: number; y: number; z: number }; intensity: number; range: number; diffuse: number[]; specular: number[];
    }
    const imported = await importPinnedModuleFetching<{
        loadBabylon(engine: object, url: string, options: object): Promise<{ entities: PinNode[]; clearColor: object; camera?: { position: { x: number; y: number; z: number } } }>;
    }>("loader-babylon/load-babylon.js", () => Buffer.from(JSON.stringify(document)));
    let expected: object;
    try {
        const loaded = await imported.module.loadBabylon({ _device: { createBuffer({ size }: { size: number }) {
            const bytes = new ArrayBuffer(size); return { getMappedRange: () => bytes, unmap() {} };
        } } }, "https://fixture/scene.babylon", { loadTextures: false });
        const meshes = loaded.entities.filter(node => node._gpu);
        const lights = loaded.entities.filter(node => node.lightType !== undefined);
        assert.equal(meshes.length, 5);
        assert.equal(lights.length, 2);
        assert.deepEqual(loaded.camera && [loaded.camera.position.x, loaded.camera.position.y, loaded.camera.position.z], [1, 2, 3]);
        expected = {
            alpha: meshes.map(mesh => mesh.material.alpha), ambient: meshes.map(mesh => mesh.material.ambientColor),
            shared: meshes.map(left => meshes.map(right => left.material === right.material)), clearColor: loaded.clearColor,
            lights: lights.map(light => [light.position.x, light.position.y, light.position.z, light.intensity,
                Math.min(light.range, 3.4028234663852886e38), ...light.diffuse, ...light.specular]),
        };
    } finally { imported.release(); }
    const untextured = await pinnedBabylonMaterials(document.materials, false);
    assert.equal(untextured.length, document.materials.length);
    assert.ok(untextured.every(material => !material.diffuseTexture));
    const context = new LoweringContext();
    const directory = resolve("artifacts/test-babylon-scene-data"), include = join(directory, "include");
    mkdirSync(join(include, "bblite/upstream"), { recursive: true });
    writeFileSync(join(include, "bblite/upstream/pinned_world_transform.hpp"), pinnedWorldTransformHeader(context));
    writeFileSync(join(directory, "source.json"), JSON.stringify(document));
    writeFileSync(join(directory, "expected.json"), JSON.stringify(expected));
    const source = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(source, `#include <bblite/pal_image.hpp>
#include <fstream>
#include <cassert>
${new LightLowerer(context).lowerPointFactory().source}
${new BabylonLowerer(context).lowerLoaderAdapter(true).source}
namespace bbl {
namespace pal {
std::vector<std::uint8_t> read_binary_file(const std::string& path) {
    if(path!="source.json") throw std::runtime_error("Unexpected texture read: "+path);
    std::ifstream file(path,std::ios::binary);
    return {std::istreambuf_iterator<char>(file),std::istreambuf_iterator<char>()};
}
std::string parent_path(const std::string&) { return ""; }
std::string join_path(const std::string& a,const std::string& b) { return a+b; }
DecodedImage decode_image(const js::ArrayBuffer&) { throw std::runtime_error("Unexpected texture decode."); }
}
${cppFunction(new CameraLowerer(context).lowerFreeFactory().source, "CameraHandle create_free_camera(")}
${cppFunction(new FactoryLowerer(context).lowerFileTextureFactory().source, "FileTexture load_file_texture(")}
}
int main() {
    using namespace bbl;
    Json expected,document;
    std::ifstream("expected.json")>>expected;
    std::ifstream("source.json")>>document;
    Engine engine;
    const auto handle=load_babylon(engine,"source.json",true,false);
    const auto& asset=engine.assets.at(handle.value);
    assert(asset.meshes.size()==5 && engine.materials.size()==8);
    assert(asset.has_camera && engine.cameras.size()==1);
    const auto& camera=engine.cameras.at(asset.camera.value);
    assert(camera.position.x==1 && camera.position.y==2 && camera.position.z==3);
    assert(asset.has_clear_color && asset.clear_color.a==expected.at("clearColor").at("a").get<float>());
    const std::array<float,3> clear{asset.clear_color.r,asset.clear_color.g,asset.clear_color.b};
    for(std::size_t lane=0;lane<3;++lane) assert(clear[lane]==document.at("clearColor")[lane].get<float>());
    for(std::size_t i=0;i<asset.meshes.size();++i) {
        const auto material=engine.meshes.at(asset.meshes[i].value).material;
        const auto& value=engine.materials.at(material.value);
        assert(std::abs(value.alpha-expected.at("alpha")[i].get<float>())<1e-7f);
        const std::array<float,3> ambient{value.ambient_color.r,value.ambient_color.g,value.ambient_color.b};
        for(std::size_t lane=0;lane<3;++lane) assert(std::abs(ambient[lane]-expected.at("ambient")[i][lane].get<float>())<1e-7f);
        for(std::size_t j=0;j<asset.meshes.size();++j)
            assert((material==engine.meshes.at(asset.meshes[j].value).material)==expected.at("shared")[i][j].get<bool>());
    }
    assert(asset.lights.size()==2);
    for(std::size_t i=0;i<asset.lights.size();++i) {
        const auto& light=engine.lights.at(asset.lights[i].value);
        const std::array<double,11> actual{light.position.x,light.position.y,light.position.z,light.intensity,light.range,
            light.diffuse_color.r,light.diffuse_color.g,light.diffuse_color.b,light.specular_color.r,light.specular_color.g,light.specular_color.b};
        for(std::size_t lane=0;lane<actual.size();++lane)
            assert(std::abs(actual[lane]-expected.at("lights")[i][lane].get<double>())<=1e-6*std::max(1.0,std::abs(actual[lane])));
        assert(light.local_matrix[12]==light.position.x && light.local_matrix[13]==light.position.y && light.local_matrix[14]==light.position.z);
    }
    assert(engine.lights.at(asset.lights[0].value).included_meshes==std::vector<std::uint32_t>({asset.meshes[1].value,asset.meshes[2].value}));
    assert(engine.lights.at(asset.lights[1].value).excluded_meshes==std::vector<std::uint32_t>({asset.meshes[0].value}));
    const auto disabled=load_babylon(engine,"source.json",false,false);
    assert(!engine.assets.at(disabled.value).has_camera && engine.cameras.size()==1);
    document["activeCameraID"]="missing";
    assert(engine.cameras.at(select_babylon_camera(engine,document,true)->value).position.x==1);
    document["cameras"][1]["id"]="second";
    document["activeCameraID"]="second";
    assert(engine.cameras.at(select_babylon_camera(engine,document,true)->value).position.x==4);
    document["cameras"]=Json::array();
    assert(!select_babylon_camera(engine,document,true));
    assert(!babylon_clear_color(Json::object()));
}`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2", `/Fo:${directory}/`, `/Fe:${executable}`,
        "/I", include, "/I", "native/include", "/I", join(nativeFixtureVcpkgRoot, "include"), source]);
    execFileSync(executable, [], { cwd: directory, stdio: "pipe" });
});

test("Babylon compiler calls retain camera and texture options", () => {
    const output = compileSource(`import { createEngine, loadBabylon } from "@babylonjs/lite";
        async function main() { const engine = await createEngine({});
            await loadBabylon(engine, "data:application/json;base64,e30=", { loadCamera: false, loadTextures: false }); }
        void main();`);
    assert.match(output.cpp, /bbl::load_babylon\([^;]*, false, false\)/);
    assert.deepEqual(output.manifest.assets[0]?.babylonTextureModes, [false]);
    const mixed = compileSource(`import { createEngine, loadBabylon } from "@babylonjs/lite";
        async function main() { const engine = await createEngine({});
            await loadBabylon(engine, "data:application/json;base64,e30=", { loadTextures: false });
            await loadBabylon(engine, "data:application/json;base64,e30="); }
        void main();`);
    assert.equal(mixed.manifest.assets.length, 1);
    assert.deepEqual(mixed.manifest.assets[0]?.babylonTextureModes, [false, true]);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { BabylonLowerer } from "../src/lowering/babylon-lowerer.js";
import { FactoryLowerer } from "../src/lowering/factory/material-factories.js";
import { pinnedWorldTransformHeader } from "../src/lowering/pinned-world-transform.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerBabylonMeshConstruction } from "../src/lowering/babylon-mesh-construction.js";
import { LightLowerer } from "../src/lowering/light-lowerer.js";
import { importPinnedModuleFetching } from "../src/pinned-shader-composer.js";
import { babylonRenderableCount } from "../src/pinned-standard-variants.js";
import { packageBabylonMeshWalks } from "../src/babylon-mesh-walks.js";
import { GLTF_MESH_WALKS, type JsonObject } from "../src/gltf-document.js";
import { cppFunction, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";
import { doctoredContext } from "./doctored-store.js";

test("the complete Babylon loader preserves parent chains, split meshes and root traversal", async t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const geometry = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2, 0, 2, 1] };
    const mesh = (id: string, properties: object = {}) => ({ id, name: id, ...geometry, ...properties });
    const document = { meshes: [
        mesh("leaf", { parentId: "mid", position: [1, 2, 3], rotation: [.1, -.2, .3] }),
        mesh("split", { position: [-2, 0, 0], subMeshes: [0, 1].map(materialIndex => ({ materialIndex, indexStart: materialIndex * 3, indexCount: 3 })) }),
        mesh("split-child", { parentId: "split", position: [0, 4, 0] }),
        { id: "mid", name: "mid", parentId: "root", rotation: [.2, .3, .4], scaling: [-1, 2, .5] },
        mesh("root", { position: [2, 3, 4], localMatrix: [2, 0, 0, 0, 0, -3, 0, 0, 0, 0, .5, 0, 4, 5, 6, 1] }),
        mesh("orphan", { parentId: "missing", position: [0, 0, 7], isVisible: null }),
        mesh("hidden", { isVisible: false }),
        mesh("visible-child", { parentId: "hidden" }),
        { id: "container-root", name: "container-root", position: [9, 0, 0] },
        mesh("nested", { parentId: "container-root", position: [0, 5, 0] }),
        { id: "empty-container", name: "empty-container" },
        mesh("empty-submeshes", { subMeshes: [] }),
        mesh("empty-parent-child", { parentId: "empty-submeshes" }),
    ] };
    interface PinNode { name: string; worldMatrix: Float32Array; children: PinNode[]; _gpu?: object; _cpuPositions?: Float32Array; _cpuNormals?: Float32Array }
    const imported = await importPinnedModuleFetching<{
        loadBabylon(engine: object, url: string, options: object): Promise<{ entities: PinNode[] }>;
    }>("loader-babylon/load-babylon.js", () => Buffer.from(JSON.stringify(document)));
    const expected: Array<{ name: string; world: number[]; positions: number[]; normals: number[] }> = [];
    try {
        const loaded = await imported.module.loadBabylon({ _device: { createBuffer({ size }: { size: number }) {
            const bytes = new ArrayBuffer(size); return { getMappedRange: () => bytes, unmap() {} };
        } } }, "https://fixture/hierarchy.babylon", { loadTextures: false });
        const walk = (node: PinNode): void => {
            if (node._gpu) expected.push({ name: node.name, world: [...node.worldMatrix], positions: [...node._cpuPositions!], normals: [...node._cpuNormals!] });
            for (const child of node.children) walk(child);
        };
        loaded.entities.forEach(walk);
        assert.deepEqual(expected.map(mesh => mesh.name), ["split_sub0", "split-child", "split_sub1", "root", "leaf", "orphan", "visible-child", "empty-parent-child", "nested"]);
        assert.equal(babylonRenderableCount(JSON.stringify(document)), expected.length);
    } finally { imported.release(); }
    const packed: JsonObject = structuredClone(document);
    await packageBabylonMeshWalks(packed, [
        { kind: "preorder" },
        { kind: "source", parameter: "container", body: `{
            const pending = [...container.entities], meshes = [];
            while (pending.length) {
                const node = pending.shift();
                if (node._gpu) meshes.push(node);
                if (node.children) pending.push(...node.children);
            }
            return meshes;
        }` },
        { kind: "source", parameter: "container", body: `{
            const pending = [...container.entities], meshes = [];
            while (pending.length) {
                const node = pending.pop();
                if (node._gpu) meshes.push(node);
                if (node.children) pending.push(...node.children);
            }
            return meshes;
        }` },
    ]);
    const walks = packed[GLTF_MESH_WALKS] as number[][];
    assert.deepEqual(walks[0], expected.map((_mesh, index) => index));
    assert.notDeepEqual(walks[0], walks[1]);
    assert.notDeepEqual(walks[1], walks[2]);
    const context = new LoweringContext();
    const directory = resolve("artifacts/test-babylon-hierarchy");
    const include = join(directory, "include");
    mkdirSync(join(include, "bblite/upstream"), { recursive: true });
    writeFileSync(join(include, "bblite/upstream/pinned_world_transform.hpp"), pinnedWorldTransformHeader(context));
    writeFileSync(join(directory, "source.json"), JSON.stringify(packed));
    writeFileSync(join(directory, "expected.json"), JSON.stringify(expected));
    writeFileSync(join(directory, "containers.json"), JSON.stringify({ meshes: [{ id: "container", name: "container" }] }));
    const source = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    const fileTexture = cppFunction(new FactoryLowerer(context).lowerFileTextureFactory().source, "FileTexture load_file_texture(");
    const changedName = lowerBabylonMeshConstruction(doctoredContext("src/loader-babylon/load-babylon.ts",
        "subMeshes.length > 1", "subMeshes.length > 0")).replace("construct_babylon_meshes(", "construct_changed_names(");
    const changedVisibility = lowerBabylonMeshConstruction(doctoredContext("src/loader-babylon/load-babylon.ts",
        "md.isVisible === false", "md.isVisible === true")).replace("construct_babylon_meshes(", "construct_changed_visibility(");
    writeFileSync(source, `#include <bblite/pal_image.hpp>
#include <fstream>
#include <cassert>
${new LightLowerer(context).lowerPointFactory().source}
${new BabylonLowerer(context).lowerLoaderAdapter().source}
namespace bbl {
${changedName}
${changedVisibility}
namespace pal {
std::vector<std::uint8_t> read_binary_file(const std::string& path) {
    std::ifstream file(path,std::ios::binary);
    if(!file) throw std::runtime_error("Unexpected fixture path: "+path);
    return {std::istreambuf_iterator<char>(file),std::istreambuf_iterator<char>()};
}
std::string parent_path(const std::string&) { return ""; }
std::string join_path(const std::string& a,const std::string& b) { return a+b; }
DecodedImage decode_image(const js::ArrayBuffer&) { throw std::runtime_error("Unexpected fixture texture."); }
}
CameraHandle create_free_camera(Engine&,Vec3d,Vec3d) { throw std::runtime_error("Unexpected fixture camera."); }
${fileTexture}
}
int main() {
    using namespace bbl;
    nlohmann::json expected;
    std::ifstream("expected.json") >> expected;
    Engine engine;
    const auto loaded=load_babylon(engine,"source.json");
    const auto& asset=engine.assets.at(loaded.value);
    assert(asset.meshes.size()==expected.size() && engine.meshes.size()==expected.size());
    for(std::size_t index=0;index<asset.meshes.size();++index) {
        const auto& mesh=engine.meshes.at(asset.meshes[index].value);
        const auto& wanted=expected[index];
        assert(mesh.name==wanted.at("name").get<std::string>());
        for(std::size_t cell=0;cell<16;++cell)
            assert(std::abs(double(mesh.instance_parent_matrix[cell])-wanted.at("world")[cell].get<double>())<2e-6);
        const auto& geometry=engine.geometries.at(mesh.geometry);
        assert(mesh.primitive==PrimitiveKind::babylon);
        assert(engine.materials.at(mesh.material.value).standard_material);
        assert(!mesh.receives_shadows);
        assert(geometry.vertices.size()*3==wanted.at("positions").size());
        for(std::size_t vertex=0;vertex<geometry.vertices.size();++vertex) {
            const auto& normal=geometry.local_normals[vertex];
            const std::array<float,3> normal_lanes{normal.x,normal.y,normal.z};
            for(std::size_t lane=0;lane<3;++lane)
                assert(normal_lanes[lane]==wanted.at("normals")[vertex*3+lane].get<float>());
            const auto& position=geometry.vertices[vertex].position;
            const std::array<double,3> actual{position.x,position.y,position.z};
            for(std::size_t lane=0;lane<3;++lane) {
                double target=wanted.at("world")[12+lane].get<double>();
                for(std::size_t component=0;component<3;++component)
                    target+=wanted.at("positions")[vertex*3+component].get<double>()*wanted.at("world")[component*4+lane].get<double>();
                assert(std::abs(actual[lane]-target)<2e-6);
            }
        }
    }
    const auto walks=nlohmann::json::parse(R"(${JSON.stringify(walks)})");
    for(std::size_t index=0;index<walks.size();++index) {
        const auto collected=asset_mesh_walk(engine,loaded,index);
        for(std::size_t mesh=0;mesh<collected.size();++mesh)
            assert(collected[mesh]==asset.meshes.at(walks[index][mesh].get<std::size_t>()));
    }
    const auto containers=load_babylon(engine,"containers.json");
    assert(engine.assets.at(containers.value).meshes.empty());
    Json input;
    std::ifstream("source.json")>>input;
    for(const bool visibility:{false,true}) {
        Engine changed;
        std::vector<BabylonHierarchyNode> nodes;
        BabylonNodeMap node_map;
        std::unordered_map<std::string,std::vector<std::size_t>> meshes_by_id;
        std::vector<std::size_t> all_meshes;
        (visibility?construct_changed_visibility:construct_changed_names)(changed,input.at("meshes"),{},{},nodes,node_map,meshes_by_id,all_meshes);
        if(visibility) {
            assert(changed.meshes.size()==expected.size()+1);
            assert(std::any_of(changed.meshes.begin(),changed.meshes.end(),[](const auto& mesh){return mesh.name=="hidden";}));
        } else {
            assert(changed.meshes.size()==expected.size());
            assert(std::all_of(changed.meshes.begin(),changed.meshes.end(),[](const auto& mesh){return mesh.name.find("_sub")!=std::string::npos;}));
        }
    }
}`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2", `/Fo:${directory}/`, `/Fe:${executable}`,
        "/I", include, "/I", "native/include", "/I", join(nativeFixtureVcpkgRoot, "include"), source]);
    execFileSync(executable, [], { cwd: directory, stdio: "pipe" });
});

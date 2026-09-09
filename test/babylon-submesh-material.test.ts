import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { BabylonLowerer } from "../src/lowering/babylon-lowerer.js";
import { lowerBabylonSubmeshMaterial } from "../src/lowering/babylon-submesh-material.js";
import { lowerBabylonSubmeshIndices } from "../src/lowering/babylon-submesh-indices.js";
import { LoweringContext } from "../src/lowering/context.js";
import { importPinnedModuleFetching } from "../src/pinned-shader-composer.js";
import { doctoredContext } from "./doctored-store.js";
import { cppFunction, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("Babylon submeshes select pinned materials and allocate independent fallback records", async t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const cases = [
        ["one", [0, 5]], ["many", [0, 1, 2]], ["single", [5]], ["missing", [0, 1]],
        ["", [0, 0]], ["unknown", [0, 0]], ["empty", [0]],
    ] as const;
    const document = {
        materials: [{ id: "one", alpha: .25 }, { id: "two", alpha: .5 }, { id: "many", alpha: .75 }],
        multiMaterials: [{ id: "many", materials: ["one", "two"] }, { id: "single", materials: ["two"] },
            { id: "missing", materials: ["unknown"] }, { id: "empty", materials: [] }],
        meshes: cases.map(([materialId, indices], index) => ({
            id: String(index), name: String(index), materialId,
            positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2],
            subMeshes: indices.map(materialIndex => ({ materialIndex, verticesStart: 0, verticesCount: 3, indexStart: 0, indexCount: 3 })),
        })),
    };
    const imported = await importPinnedModuleFetching<{
        loadBabylon(engine: object, url: string, options: object): Promise<{ entities: Array<{ material: { alpha: number } }> }>;
    }>("loader-babylon/load-babylon.js", () => Buffer.from(JSON.stringify(document)));
    let expected: { alpha: number[]; equal: boolean[][] };
    try {
        const loaded = await imported.module.loadBabylon({ _device: { createBuffer({ size }: { size: number }) {
            const bytes = new ArrayBuffer(size); return { getMappedRange: () => bytes, unmap() {} };
        } } }, "https://fixture/submeshes.babylon", { loadTextures: false });
        const materials = loaded.entities.map(mesh => mesh.material);
        expected = { alpha: materials.map(material => material.alpha), equal: materials.map(left => materials.map(right => left === right)) };
        assert.equal(materials.length, 13);
    } finally { imported.release(); }
    const loader = new BabylonLowerer(new LoweringContext()).lowerLoaderAdapter().source;
    const helpers = ["std::string string_or(", "void apply_babylon_material_properties(", "MaterialHandle default_material("]
        .map(signature => cppFunction(loader, signature)).join("\n") + "\n" + lowerBabylonSubmeshMaterial(new LoweringContext());
    const changed = lowerBabylonSubmeshMaterial(doctoredContext("src/loader-babylon/load-babylon.ts",
        "else if (matIds && matIds.length === 1)", "else if (matIds && matIds.length === 2)"))
        .replace("select_babylon_submesh_material(", "select_changed_material(");
    const directory = resolve("artifacts/test-babylon-submesh-material");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "source.json"), JSON.stringify(document));
    writeFileSync(join(directory, "expected.json"), JSON.stringify(expected));
    const source = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(source, `#include <bblite/runtime.hpp>
#include <nlohmann/json.hpp>
#include <cassert>
#include <fstream>
namespace bbl {
using Json=nlohmann::json;
${helpers}
${changed}
}
int main() {
    using namespace bbl;
    Json document, expected;
    std::ifstream("source.json") >> document;
    std::ifstream("expected.json") >> expected;
    Engine engine;
    std::unordered_map<std::string,MaterialHandle> materials;
    std::unordered_map<std::string,std::vector<std::string>> multi;
    for(const auto& row:document.at("materials")) {
        const auto handle=default_material(engine);
        apply_babylon_material_properties(engine.materials.at(handle.value),row,{0,0,0});
        materials.emplace(row.at("id").get<std::string>(),handle);
    }
    for(const auto& row:document.at("multiMaterials")) multi.emplace(row.at("id").get<std::string>(),row.at("materials").get<std::vector<std::string>>());
    std::vector<MaterialHandle> selected;
    for(const auto& mesh:document.at("meshes")) for(const auto& sub:mesh.at("subMeshes"))
        selected.push_back(select_babylon_submesh_material(engine,mesh,sub.at("materialIndex").get<std::size_t>(),materials,multi));
    assert(selected.size()==expected.at("alpha").size());
    for(std::size_t a=0;a<selected.size();++a) {
        assert(engine.materials.at(selected[a].value).alpha==expected.at("alpha")[a].get<float>());
        for(std::size_t b=0;b<selected.size();++b) assert((selected[a]==selected[b])==expected.at("equal")[a][b].get<bool>());
    }
    assert(engine.materials.size()==11);
    const auto changed=select_changed_material(engine,document.at("meshes")[1],5,materials,multi);
    assert(changed==materials.at("one"));
}`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2", `/Fo:${directory}/`, `/Fe:${executable}`,
        "/I", "native/include", "/I", join(nativeFixtureVcpkgRoot, "include"), source]);
    execFileSync(executable, [], { cwd: directory, stdio: "pipe" });
});

test("Babylon submesh defaults and index slices follow the pinned loader", async t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const ranges = [undefined, null, [], ...[[0, 0], [3, 99], [-3, 3], [-3, 99], [1.9, 2.9], [9, 3]].map(([indexStart, indexCount]) =>
        [{ materialIndex: 0, verticesStart: 0, verticesCount: 4, indexStart, indexCount }])];
    const document = { meshes: ranges.map((subMeshes, index) => ({
        id: String(index), name: String(index), subMeshes,
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2, 0, 2, 3],
    })) };
    const imported = await importPinnedModuleFetching<{
        loadBabylon(engine: object, url: string, options: object): Promise<{ entities: Array<{ _cpuIndices: Uint32Array }> }>;
    }>("loader-babylon/load-babylon.js", () => Buffer.from(JSON.stringify(document)));
    let expected: number[][];
    try {
        const loaded = await imported.module.loadBabylon({ _device: { createBuffer({ size }: { size: number }) {
            const bytes = new ArrayBuffer(size); return { getMappedRange: () => bytes, unmap() {} };
        } } }, "https://fixture/indices.babylon", { loadTextures: false });
        expected = loaded.entities.map(mesh => [...mesh._cpuIndices]);
        assert.equal(expected.length, 7);
    } finally { imported.release(); }
    const helpers = lowerBabylonSubmeshIndices(new LoweringContext());
    const changed = cppFunction(lowerBabylonSubmeshIndices(doctoredContext("src/loader-babylon/load-babylon.ts",
        "indexStart: 0,", "indexStart: 3,")), "Json babylon_submeshes(").replace("babylon_submeshes(", "changed_submeshes(");
    const directory = resolve("artifacts/test-babylon-submesh-indices");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "source.json"), JSON.stringify(document));
    writeFileSync(join(directory, "expected.json"), JSON.stringify(expected));
    const source = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(source, `#include <bblite/js_data.hpp>
#include <nlohmann/json.hpp>
#include <cassert>
#include <fstream>
namespace bbl {
using Json=nlohmann::json;
${helpers}
${changed}
}
int main() {
    using namespace bbl;
    Json document, expected;
    std::ifstream("source.json") >> document;
    std::ifstream("expected.json") >> expected;
    Json actual=Json::array();
    for(const auto& mesh:document.at("meshes")) {
        const auto indices=mesh.at("indices").get<std::vector<std::uint32_t>>();
        const auto submeshes=babylon_submeshes(mesh,mesh.at("positions").size(),indices.size());
        for(const auto& sub:submeshes) {
            const auto count=sub.at("indexCount").get<double>();
            if(keep_babylon_submesh(count)) actual.push_back(babylon_submesh_indices(indices,sub.at("indexStart").get<double>(),count));
        }
    }
    assert(actual==expected);
    const auto changed=changed_submeshes(Json::object(),12,6);
    assert(changed[0].at("indexStart")==3 && changed[0].at("verticesCount")==4);
}`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2", `/Fo:${directory}/`, `/Fe:${executable}`,
        "/I", "native/include", "/I", join(nativeFixtureVcpkgRoot, "include"), source]);
    execFileSync(executable, [], { cwd: directory, stdio: "pipe" });
});

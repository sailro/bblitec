import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {LoweringContext} from "../src/lowering/context.js";
import {lowerMeshMaterialSetter} from "../src/lowering/mesh-material-setter.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const module = "src/scene/mesh-scene-registry.ts";
function sourceResult(context: LoweringContext): object {
    const declarations = ["enqueueMaterialSwap", "installMaterialSetter", "registerMeshScene", "unregisterMeshScene"]
        .map(name => context.functionDeclaration(module, name).declaration.getText().replace("export ", "")).join("\n");
    const code = transpileCommonJs(`let _meshScenes = null; ${declarations}
        return {add: registerMeshScene, remove: unregisterMeshScene};`, module);
    type Mesh = {material: object};
    type Scene = {_materialSwapQueue: Mesh[]};
    const execute = new Function(code)() as {add(scene: Scene, mesh: Mesh): void; remove(scene: Scene, mesh: Mesh): boolean};
    const materials = [{}, {}, {}], mesh: Mesh = {material: materials[0]!};
    const scenes: Scene[] = [{_materialSwapQueue: []}, {_materialSwapQueue: []}];
    const states: object[] = [];
    const write = (index: number) => {
        mesh.material = materials[index]!;
        states.push({material: materials.indexOf(mesh.material), queues: scenes.map(scene => scene._materialSwapQueue.length)});
        for (const scene of scenes) scene._materialSwapQueue.length = 0;
    };
    execute.add(scenes[0]!, mesh); execute.add(scenes[0]!, mesh); execute.add(scenes[1]!, mesh);
    write(0); write(1); write(1);
    const removals = [execute.remove(scenes[0]!, mesh)]; write(2);
    removals.push(execute.remove(scenes[1]!, mesh)); write(0);
    execute.add(scenes[0]!, mesh); write(1);
    return {states, removals};
}

test("material reassignment follows source identity guards and multi-scene subscriptions", t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const contexts = [new LoweringContext(), doctoredContext(module, "v !== _mat", "true"),
        doctoredContext(module, "scenes.delete(scene);", "")];
    const expected = contexts.map(sourceResult);
    const directory = resolve("artifacts/test-mesh-material-setter"); mkdirSync(directory, {recursive: true});
    writeFileSync(resolve(directory, "cases.json"), JSON.stringify(expected));
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(file, `#include <bblite/runtime.hpp>
#include <nlohmann/json.hpp>
#include <cassert>
#include <fstream>
#include <iostream>
namespace bbl {
${contexts.map((context, index) => `namespace variant_${index} { ${lowerMeshMaterialSetter(context)} }`).join("\n")}
void enqueue(Scene& scene, MeshHandle mesh) {
    auto& queue = scene.state->pbr_material_swap_queue;
    if (std::find(queue.begin(), queue.end(), mesh) == queue.end()) queue.push_back(mesh);
}
void check(std::size_t variant, const nlohmann::json& expected) {
    Engine engine; engine.materials.resize(3); engine.meshes.emplace_back().material = MaterialHandle{0};
    std::array<Scene, 2> scenes;
    for (auto& scene : scenes) { scene.engine = &engine; scene.state->enqueue_material_group = enqueue; }
    const std::array add{${contexts.map((_, i) => `variant_${i}::register_mesh_material_scene`).join(", ")}};
    const std::array remove{${contexts.map((_, i) => `variant_${i}::unregister_mesh_material_scene`).join(", ")}};
    const std::array assign{${contexts.map((_, i) => `variant_${i}::set_mesh_material`).join(", ")}};
    nlohmann::json states = nlohmann::json::array();
    const auto write = [&](std::uint32_t material) {
        assign.at(variant)(engine, MeshHandle{0}, MaterialHandle{material});
        states.push_back({{"material", engine.meshes[0].material.value}, {"queues", {scenes[0].state->pbr_material_swap_queue.size(), scenes[1].state->pbr_material_swap_queue.size()}}});
        for (auto& scene : scenes) scene.state->pbr_material_swap_queue.clear();
    };
    add.at(variant)(scenes[0], MeshHandle{0}); add.at(variant)(scenes[0], MeshHandle{0}); add.at(variant)(scenes[1], MeshHandle{0});
    write(0); write(1); write(1);
    std::vector<bool> removals{remove.at(variant)(scenes[0], MeshHandle{0})}; write(2);
    removals.push_back(remove.at(variant)(scenes[1], MeshHandle{0})); write(0);
    add.at(variant)(scenes[0], MeshHandle{0}); write(1);
    const nlohmann::json actual{{"states", states}, {"removals", removals}};
    if (actual != expected) std::cerr << actual.dump() << " expected=" << expected.dump() << '\\n';
    assert(actual == expected);
}
}
int main() { nlohmann::json expected; std::ifstream("cases.json") >> expected;
    for (std::size_t i = 0; i < expected.size(); ++i) bbl::check(i, expected.at(i));
}
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", "/I", resolve(nativeFixtureVcpkgRoot, "include"), file]);
    assert.equal(execFileSync(executable, {cwd: directory, encoding: "utf8"}), "");
});

test("material subscriber lowering refuses unrepresented source operations", () => {
    assert.throws(() => lowerMeshMaterialSetter(doctoredContext(module,
        "enqueueMaterialSwap(scene, mesh);", "enqueueMaterialSwap(scene, otherMesh);")), /Unsupported|supported/);
    assert.throws(() => lowerMeshMaterialSetter(doctoredContext(module,
        "const scenes = _meshScenes?.get(mesh);", "const scenes = _meshScenes?.get(otherMesh);")), /lookup/);
});

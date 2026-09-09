import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { cppFunction, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

test("mesh clone demand retains local glTF geometry", () => {
    const result = compileSource(`import {createEngine, loadGltf, getContainerMeshes, cloneTransformNode} from "@babylonjs/lite";
        const engine = await createEngine({});
        const asset = await loadGltf(engine, "asset.glb");
        cloneTransformNode(getContainerMeshes(asset)[0]!);`);
    assert(result.manifest.features.includes("mesh:clone"));
});

test("detached mesh clones preserve pinned parent, local geometry and shared ownership", {skip: !tools}, async () => {
    interface Node { parent: Node | null; children: Node[] }
    interface Mesh extends Node { _gpu: object }
    const transform = await importPinnedModule<{
        createTransformNode(name: string): Node;
        cloneTransformNode(mesh: Mesh): Mesh;
    }>("scene/transform-node.js");
    const {initMeshTransform} = await importPinnedModule<{
        initMeshTransform(mesh: {_gpu: object; name: string}): Mesh;
    }>("mesh/mesh.js");
    const source = initMeshTransform({_gpu: {}, name: "source"});
    source.parent = transform.createTransformNode("parent");
    const clone = transform.cloneTransformNode(source);
    assert.equal(clone.parent, null);
    assert.equal(clone._gpu, source._gpu);

    const output = resolve("artifacts/mesh-clone-local-check");
    mkdirSync(output, {recursive: true});
    const file = join(output, "check.cpp"), executable = join(output, "check.exe");
    const lowerer = new SceneLowerer(new LoweringContext()).lowerCore().source;
    writeFileSync(file, `#include <bblite/runtime.hpp>
#include <cassert>
namespace bbl { ${cppFunction(lowerer, "MeshHandle clone_mesh_node(")} }
int main() {
    bbl::Engine engine;
    bbl::ModelGeometry geometry;
    geometry.vertex_space = bbl::VertexSpace::world;
    bbl::ModelVertex vertex;
    vertex.position = {100,200,300}; vertex.local_position = {1,2,3};
    geometry.vertices.push_back(vertex);
    vertex.position = {-1,2,3}; vertex.normal = {-1,0,0}; vertex.tangent = {-1,0,0,-1};
    geometry.bind_vertices.push_back(vertex);
    engine.geometries.push_back(std::move(geometry));
    bbl::MeshRecord mesh; mesh.primitive = bbl::PrimitiveKind::gltf; mesh.geometry = 0;
    mesh.name = "source"; mesh.parent = bbl::MeshHandle{12}; mesh.transform_parent = bbl::TransformNodeHandle{13};
    mesh.outer_position = {4,5,6}; mesh.outer_rotation = {1,2,3};
    engine.meshes.push_back(mesh);
    const auto cloned = bbl::clone_mesh_node(engine, bbl::MeshHandle{0});
    const auto second = bbl::clone_mesh_node(engine, cloned);
    const auto& result = engine.meshes.at(second.value);
    assert(result.parent.value == bbl::invalid_handle && result.transform_parent.value == bbl::invalid_handle);
    assert(result.detached_imported_mesh && result.outer_position.x == 0 && result.outer_rotation.y == 0);
    assert(result.geometry == 0 && engine.geometries[0].owners == 3);
    assert(!engine.meshes[0].detached_imported_mesh && engine.meshes[0].parent.value == 12);
    assert(engine.geometries[0].vertices[0].position.x == 100);
    const auto local = bbl::detached_imported_vertex(result, engine.geometries[0], 0);
    assert(local.position.x == 1 && local.position.y == 2 && local.position.z == 3);
    assert(local.normal.x == 1 && local.tangent.x == 1 && local.tangent.w == 1);
    bbl::Vec3 low{}, high{};
    bbl::apply_mesh_bound_overrides(result, low, high);
    assert(low.x == 1 && high.z == 3);
    bbl::MeshRecord babylon;
    babylon.primitive = bbl::PrimitiveKind::babylon;
    babylon.geometry = 0;
    babylon.imported_clone_trs = bbl::ImportedMeshTrs{{9,8,7}, {0,.5f,0}, {2,3,4}};
    const bbl::MeshHandle babylon_source{static_cast<std::uint32_t>(engine.meshes.size())};
    engine.meshes.push_back(babylon);
    const auto babylon_clone = bbl::clone_mesh_node(engine, babylon_source);
    auto& cloned_babylon = engine.meshes.at(babylon_clone.value);
    assert(cloned_babylon.position.x == 9 && cloned_babylon.rotation.y == .5f && cloned_babylon.scaling.z == 4);
    assert(bbl::detached_imported_vertex(cloned_babylon, engine.geometries[0], 0).normal.x == -1);
    cloned_babylon.position = {1,1,1};
    cloned_babylon.transform_version = 1;
    const auto recloned_babylon = bbl::clone_mesh_node(engine, babylon_clone);
    assert(engine.meshes.at(recloned_babylon.value).position.x == 1);
    engine.meshes.at(babylon_source.value).transform_version = 1;
    bool refused = false;
    try { bbl::clone_mesh_node(engine, babylon_source); }
    catch (const std::runtime_error& error) {
        refused = std::string(error.what()).find("source transform ownership") != std::string::npos;
    }
    assert(refused);
    std::puts("mesh-clone-local: ok");
}
`);
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", file]);
    assert.match(execFileSync(executable, {encoding: "utf8"}), /mesh-clone-local: ok/);
});

test("removing shared meshes retires each owner once and releases the final geometry allocation", {skip: !tools}, () => {
    const output = resolve("artifacts/mesh-retirement-check");
    mkdirSync(output, {recursive: true});
    const file = join(output, "check.cpp"), executable = join(output, "check.exe");
    const lowerer = new SceneLowerer(new LoweringContext()).lowerCore().source;
    const functions = [
        "void require_scene_engine(", "std::uint32_t material_family_bit(", "MeshHandle clone_mesh_node(",
        "void add_to_scene(Scene& scene, MeshHandle", "void reclaim_unshared_geometry(",
        "void remove_from_scene(Scene& scene, MeshHandle",
    ].map(signature => cppFunction(lowerer, signature)).join("\n");
    writeFileSync(file, `#include <bblite/runtime.hpp>
#include <cassert>
#include <tuple>
namespace bbl { ${functions} }
int main() {
    bbl::Engine engine;
    bbl::Scene scene;
    scene.engine = &engine;
    engine.geometries.resize(1);
    auto& geometry = engine.geometries[0];
    auto arrays = std::tie(geometry.vertices, geometry.bind_vertices, geometry.local_normals,
        geometry.morph_positions, geometry.morph_bounds, geometry.morph_normals,
        geometry.morph_tangents, geometry.indices);
    std::apply([](auto&... values) { (values.resize(4), ...); }, arrays);
    geometry.bounds_min = {-1,-2,-3}; geometry.position_version = 17;
    geometry.source_indices_reversed = true;
    bbl::MeshRecord source;
    source.geometry = 0;
    engine.meshes.push_back(source);
    const bbl::MeshHandle first{0};
    const auto second = bbl::clone_mesh_node(engine, first);
    const auto third = bbl::clone_mesh_node(engine, second);
    assert(geometry.owners == 3);
    for (auto mesh : {first, second, third}) bbl::add_to_scene(scene, mesh);
    const auto version = scene.render_topology_version;
    bbl::remove_from_scene(scene, second);
    assert(geometry.owners == 2 && engine.meshes[second.value].retired);
    assert(!engine.meshes[first.value].retired && !engine.meshes[third.value].retired);
    assert(scene.render_topology_version == version + 1 && scene.meshes.size() == 2);
    std::apply([](auto&... values) { assert(((values.size() == 4) && ...)); }, arrays);
    bbl::remove_from_scene(scene, second);
    assert(geometry.owners == 2 && scene.render_topology_version == version + 1);
    bool refused = false;
    try { bbl::add_to_scene(scene, second); } catch (const std::runtime_error&) { refused = true; }
    assert(refused && geometry.owners == 2 && scene.meshes.size() == 2);
    bbl::remove_from_scene(scene, first);
    assert(geometry.owners == 1);
    std::apply([](auto&... values) { assert(((values.size() == 4) && ...)); }, arrays);
    bbl::remove_from_scene(scene, third);
    std::apply([](auto&... values) { assert(((values.empty() && values.capacity() == 0) && ...)); }, arrays);
    assert(!geometry.source_indices_reversed && geometry.position_version == 17);
    assert(geometry.bounds_min.x == -1 && geometry.bounds_min.z == -3);
    assert(scene.meshes.empty() && scene.render_topology_version == version + 3);
    bbl::remove_from_scene(scene, third);
    assert(scene.render_topology_version == version + 3);
    engine.meshes.push_back(bbl::MeshRecord{});
    const bbl::MeshHandle empty{3};
    bbl::add_to_scene(scene, empty);
    bbl::remove_from_scene(scene, empty);
    assert(scene.meshes.empty());
}
`);
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", file]);
    assert.equal(execFileSync(executable, {encoding: "utf8"}), "");
});

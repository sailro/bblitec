import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { lowerMeshMaterialSetter } from "../src/lowering/mesh-material-setter.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

test("cloneTransformNode over a loaded mesh reaches the mesh clone", () => {
    const result =
        compileSource(`import {createEngine, loadGltf, getContainerMeshes, cloneTransformNode} from "@babylonjs/lite";
        const engine = await createEngine({});
        const asset = await loadGltf(engine, "asset.glb");
        cloneTransformNode(getContainerMeshes(asset)[0]!);`);
    assert(result.manifest.features.includes("mesh:clone"));
});

test(
    "detached mesh clones keep their TRS, leave the loaded hierarchy and share their geometry",
    { skip: !tools },
    async () => {
        interface Node {
            parent: Node | null;
            children: Node[];
        }
        interface Mesh extends Node {
            _gpu: object;
        }
        const transform = await importPinnedModule<{
            createTransformNode(this: void, name: string): Node;
            cloneTransformNode(this: void, mesh: Mesh): Mesh;
        }>("scene/transform-node.js");
        const { initMeshTransform } = await importPinnedModule<{
            initMeshTransform(
                this: void,
                mesh: { _gpu: object; name: string },
            ): Mesh;
        }>("mesh/mesh.js");
        const source = initMeshTransform({ _gpu: {}, name: "source" });
        source.parent = transform.createTransformNode("parent");
        const clone = transform.cloneTransformNode(source);
        assert.equal(clone.parent, null);
        assert.equal(clone._gpu, source._gpu);

        const output = resolve("artifacts/mesh-clone-local-check");
        mkdirSync(output, { recursive: true });
        const file = join(output, "check.cpp"),
            executable = join(output, "check.exe");
        const lowerer = new SceneLowerer(new LoweringContext()).lowerCore()
            .source;
        writeFileSync(
            file,
            `#include <bblite/runtime.hpp>
#include <cassert>
namespace bbl { ${cppFunction(lowerer, "MeshHandle clone_mesh_node(")} }
int main() {
    bbl::Engine engine;
    bbl::ModelGeometry geometry;
    bbl::ModelVertex vertex;
    vertex.position = {1,2,3}; vertex.normal = {-1,0,0};
    geometry.vertices.push_back(vertex);
    engine.geometries.push_back(std::move(geometry));
    // A loaded primitive: its node's world, root mirror included, is its
    // parent world, and its winding was reconciled against that mirror.
    bbl::MeshRecord mesh; mesh.geometry = 0;
    mesh.name = "source"; mesh.parent = bbl::MeshHandle{12}; mesh.transform_parent = bbl::TransformNodeHandle{13};
    mesh.outer_position = {4,5,6}; mesh.outer_rotation = {1,2,3};
    mesh.position = {7,8,9};
    mesh.parent_world = std::array<float, 16>{-1,0,0,0, 0,1,0,0, 0,0,1,0, 10,20,30,1};
    mesh.clockwise_front_face = true; mesh.authored_clockwise_front_face = true;
    engine.meshes.push_back(mesh);
    const auto cloned = bbl::clone_mesh_node(engine, bbl::MeshHandle{0});
    const auto second = bbl::clone_mesh_node(engine, cloned);
    const auto& result = engine.meshes.at(second.value);
    // The pin's clone keeps its own TRS and its local lanes, and leaves the
    // node hierarchy: no parent, no loaded parent world, no root edit.
    assert(result.parent.value == bbl::invalid_handle && result.transform_parent.value == bbl::invalid_handle);
    assert(result.detached_imported_mesh && result.outer_position.x == 0 && result.outer_rotation.y == 0);
    assert(!result.parent_world && !result.clockwise_front_face && !result.authored_clockwise_front_face);
    assert(result.position.x == 7 && result.position.y == 8 && result.position.z == 9);
    assert(result.geometry == 0 && engine.geometries[0].owners == 3);
    assert(!engine.meshes[0].detached_imported_mesh && engine.meshes[0].parent.value == 12);
    assert(engine.meshes[0].parent_world && engine.meshes[0].clockwise_front_face);
    assert(engine.geometries[0].vertices[0].position.x == 1 && engine.geometries[0].vertices[0].normal.x == -1);
    // A .babylon mesh keeps its own TRS on the record; its clone drops the
    // parent node's world in the same way.
    bbl::MeshRecord babylon;
    babylon.geometry = 0;
    babylon.position = {9,8,7}; babylon.rotation = {0,.5f,0}; babylon.scaling = {2,3,4};
    babylon.parent_world = std::array<float, 16>{2,0,0,0, 0,2,0,0, 0,0,2,0, 1,1,1,1};
    const bbl::MeshHandle babylon_source{static_cast<std::uint32_t>(engine.meshes.size())};
    engine.meshes.push_back(babylon);
    const auto babylon_clone = bbl::clone_mesh_node(engine, babylon_source);
    auto& cloned_babylon = engine.meshes.at(babylon_clone.value);
    assert(cloned_babylon.position.x == 9 && cloned_babylon.rotation.y == .5f && cloned_babylon.scaling.z == 4);
    assert(!cloned_babylon.parent_world && cloned_babylon.detached_imported_mesh);
    cloned_babylon.position = {1,1,1};
    const auto recloned_babylon = bbl::clone_mesh_node(engine, babylon_clone);
    assert(engine.meshes.at(recloned_babylon.value).position.x == 1);
    std::puts("mesh-clone-local: ok");
}
`,
        );
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            "/O2",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/include",
            file,
        ]);
        assert.match(
            execFileSync(executable, { encoding: "utf8" }),
            /mesh-clone-local: ok/,
        );
    },
);

test(
    "removing shared meshes retires each owner once and releases the final geometry allocation",
    { skip: !tools },
    () => {
        const output = resolve("artifacts/mesh-retirement-check");
        mkdirSync(output, { recursive: true });
        const file = join(output, "check.cpp"),
            executable = join(output, "check.exe");
        const lowerer = new SceneLowerer(new LoweringContext()).lowerCore()
            .source;
        const functions = [
            "void require_scene_engine(",
            "std::uint32_t material_family_bit(",
            "MeshHandle clone_mesh_node(",
            "void add_to_scene(Scene& scene, MeshHandle",
            "void mark_mesh_dirty(",
            "void erase_first_mesh(",
            "void clear_mesh_parent(",
            "void remove_from_scene(Scene& scene, MeshHandle",
        ]
            .map((signature) => cppFunction(lowerer, signature))
            .join("\n");
        writeFileSync(
            file,
            `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
#include <tuple>
namespace bbl { ${lowerMeshMaterialSetter(new LoweringContext())} ${functions} }
int main() {
    bbl::Engine engine;
    bbl::Scene scene;
    scene.engine = &engine;
    engine.geometries.resize(1);
    auto& geometry = engine.geometries[0];
    auto arrays = std::tie(geometry.vertices,
        geometry.morph_positions, geometry.morph_bounds, geometry.morph_normals,
        geometry.morph_tangents, geometry.indices);
    std::apply([](auto&... values) { (values.resize(4), ...); }, arrays);
    geometry.bounds_min = {-1,-2,-3}; geometry.position_version = 17;
    geometry.source_indices_reversed = true;
    // A factory mesh: createMeshFromData's record over its own packed streams.
    geometry.owned_packed_geometry = true;
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
    // Retired records dropped their geometry link, and the unowned
    // geometry's slot is offered at once. Every retired record's slot is
    // offered too, so the next record takes the last one under the next
    // generation; the retired handle then names nothing.
    assert(engine.meshes[third.value].geometry == bbl::invalid_handle);
    assert(engine.free_geometry_slots.size() == 1 && engine.free_geometry_slots[0] == 0);
    assert(engine.free_mesh_slots.size() == 4);
    const auto reused = bbl::store_mesh_record(engine, bbl::MeshRecord{});
    assert(reused.value == empty.value && reused.generation == 1 && engine.meshes.size() == 4);
    assert(!bbl::mesh_handle_current(engine, empty) && bbl::mesh_handle_current(engine, reused));
    bool stale_refused = false;
    try { bbl::add_to_scene(scene, empty); } catch (const std::runtime_error&) { stale_refused = true; }
    assert(stale_refused && scene.meshes.empty());
    bbl::remove_from_scene(scene, empty);
    std::ignore = bbl::store_mesh_record(engine, bbl::MeshRecord{});
    std::ignore = bbl::store_mesh_record(engine, bbl::MeshRecord{});
    std::ignore = bbl::store_mesh_record(engine, bbl::MeshRecord{});
    assert(engine.meshes.size() == 4 && engine.free_mesh_slots.empty());
    assert(bbl::store_geometry_record(engine, bbl::ModelGeometry{}) == 0 && engine.geometries.size() == 1);
}
`,
        );
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            "/O2",
            // The morph-shadow range cache is one of the arrays a released
            // geometry frees, in the scenes that carry it.
            "/DBBLITE_SHADOW_MORPH_BOUNDS=1",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/include",
            file,
        ]);
        assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
    },
);

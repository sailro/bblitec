import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerMeshMaterialSetter } from "../src/lowering/mesh-material-setter.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

function runCheck(name: string, source: string): void {
    const output = resolve(`artifacts/${name}`);
    mkdirSync(output, { recursive: true });
    const file = join(output, "check.cpp"),
        executable = join(output, "check.exe");
    writeFileSync(file, source);
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
        new RegExp(`^${name}: ok\\r?\\n$`),
    );
}

test(
    "a transform node's record lives as long as a handle to it, cycles included",
    { skip: !tools },
    () => {
        const core = new SceneLowerer(new LoweringContext()).lowerCore({
            transformNodes: true,
        }).source;
        const functions = [
            "void mark_mesh_dirty(",
            "void mark_transform_node_dirty(",
            "TransformNodeHandle create_transform_node(",
            "void require_acyclic_transform_node_parent(",
            "void set_transform_node_parent(",
            "void push_transform_node_child( Engine& engine, TransformNodeHandle node, TransformNodeHandle",
        ];
        runCheck(
            "transform-node-reclamation",
            `#include <bblite/runtime.hpp>
#include <cassert>
#include <cstdio>
namespace bbl {
${functions.map((signature) => cppFunction(core, signature)).join("\n")}
}
int main() {
    bbl::Engine engine;
    const auto create = [&](const char* name) {
        return bbl::create_transform_node(engine, name, {}, {0, 0, 0, 1}, {1, 1, 1});
    };
    std::uint32_t dropped_slot = 0;
    {
        const auto dropped = create("dropped");
        dropped_slot = dropped.value;
    }
    // The lease ended with the last handle; the next node reclaims the
    // record and takes its slot under the next generation.
    const auto kept = create("kept");
    assert(kept.value == dropped_slot && kept.generation == 1);
    assert(engine.transform_nodes.size() == 1 && engine.transform_nodes[0].name == "kept");
    // A live mesh composing under a node keeps it.
    engine.meshes.emplace_back();
    {
        const auto parent = create("parent");
        engine.meshes[0].transform_parent = parent;
    }
    static_cast<void>(create("probe"));
    assert(engine.transform_nodes.size() == 3 && !engine.transform_nodes[1].retired);
    engine.meshes[0].transform_parent = bbl::TransformNodeHandle{};
    // A parent and child that name only each other are a cycle JavaScript
    // frees; the collector ends both leases.
    {
        const auto parent = create("cycle-parent");
        const auto child = create("cycle-child");
        bbl::set_transform_node_parent(engine, child, parent);
        bbl::push_transform_node_child(engine, parent, child);
    }
    bbl::js::collect_cycles();
    bbl::reclaim_transform_nodes(engine);
    // "parent" (its mesh let go) and "probe" were reclaimed when the cycle
    // was created, which took their slots; the cycle's two records are
    // reclaimed now.
    std::size_t retired = 0;
    for (const auto& record : engine.transform_nodes) retired += record.retired ? 1u : 0u;
    assert(engine.transform_nodes.size() == 3 && !engine.transform_nodes[0].retired);
    assert(retired == 2 && engine.free_transform_node_slots.size() == 2);
    bool refused = false;
    const auto reused = create("reused");
    assert(reused.generation == 2);
    try { static_cast<void>(bbl::handle_at(engine.transform_nodes, bbl::TransformNodeHandle{reused.value, reused.generation - 1})); }
    catch (const std::out_of_range&) { refused = true; }
    assert(refused);
    std::puts("transform-node-reclamation: ok");
}
`,
        );
    },
);

test(
    "removal prunes what the pin prunes and a retired parent keeps its slot for its children",
    { skip: !tools },
    () => {
        const core = new SceneLowerer(new LoweringContext()).lowerCore().source;
        const functions = [
            "void require_scene_engine(",
            "std::uint32_t material_family_bit(",
            "void add_to_scene(Scene& scene, MeshHandle",
            "void mark_mesh_dirty(",
            "void erase_first_mesh(",
            "void clear_mesh_parent(",
            "void remove_from_scene(Scene& scene, MeshHandle",
        ];
        runCheck(
            "mesh-removal-pruning",
            `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
#include <cstdio>
namespace bbl { ${lowerMeshMaterialSetter(new LoweringContext())}
${functions.map((signature) => cppFunction(core, signature)).join("\n")} }
int main() {
    bbl::Engine engine;
    bbl::Scene scene;
    scene.engine = &engine;
    const auto stored = [&] {
        bbl::MeshRecord record;
        record.geometry = bbl::store_geometry_record(engine, bbl::ModelGeometry{});
        return bbl::store_mesh_record(engine, std::move(record));
    };
    const auto parent = stored(), child = stored(), follower = stored();
    // child is parent's traversal entry and composes under it; follower
    // only composes under it (the parent setter without the push).
    for (const auto mesh : {child, follower}) {
        auto& record = bbl::handle_at(engine.meshes, mesh);
        record.parent = parent;
        bbl::handle_at(engine.meshes, parent).parented_meshes.push_back(mesh);
    }
    bbl::handle_at(engine.meshes, parent).children.push_back(child);
    for (const auto mesh : {parent, child, follower}) bbl::add_to_scene(scene, mesh);
    engine.frame_tasks.emplace_back();
    engine.frame_tasks[0].render_meshes = {bbl::RenderTaskMesh{parent, {}}, bbl::RenderTaskMesh{follower, {}}};
    scene.tasks.push_back(bbl::TaskHandle{0});
    auto group = std::make_shared<bbl::SourceMaterialGroupState>();
    group->meshes = {parent, child, follower};
    scene.state->source_material_groups = std::make_shared<bbl::SourceMaterialGroups>();
    scene.state->source_material_groups->set(1, group);
    scene.state->pbr_material_swap_queue = {parent};
    bbl::remove_from_scene(scene, parent);
    // The task entries, the group entries and the swap queue drop the
    // removed mesh; removeChildren took its traversal child with it.
    assert(engine.frame_tasks[0].render_meshes.size() == 1 && engine.frame_tasks[0].render_meshes[0].mesh == follower);
    assert(group->meshes.size() == 1 && group->meshes[0] == follower);
    assert(scene.state->pbr_material_swap_queue.empty());
    assert(scene.meshes.size() == 1 && scene.meshes[0] == follower);
    assert(bbl::handle_at(engine.meshes, child).retired);
    assert(bbl::handle_at(engine.meshes, child).parent.value == bbl::invalid_handle);
    // The follower still composes under the disposed parent, which keeps
    // its record, and so its slot, until the follower lets go.
    assert(bbl::handle_at(engine.meshes, parent).retired);
    assert(bbl::handle_at(engine.meshes, follower).parent == parent);
    assert(engine.free_mesh_slots.size() == 1 && engine.free_mesh_slots[0] == child.value);
    bbl::remove_from_scene(scene, follower);
    assert(engine.free_mesh_slots.size() == 3);
    std::puts("mesh-removal-pruning: ok");
}
`,
        );
    },
);

test(
    "a removed mesh a reading table names keeps its record and bounds until the last name ends",
    { skip: !tools },
    () => {
        runCheck(
            "mesh-name-reclamation",
            `#include <bblite/runtime.hpp>
#include <cassert>
#include <cstdio>
int main() {
    bbl::Engine engine;
    const auto stored = [&](float extent) {
        bbl::ModelGeometry geometry;
        geometry.vertices.resize(1);
        geometry.bounds_min = {-extent, -extent, -extent};
        geometry.bounds_max = {extent, extent, extent};
        bbl::MeshRecord record;
        record.geometry = bbl::store_geometry_record(engine, std::move(geometry));
        return bbl::store_mesh_record(engine, std::move(record));
    };
    const auto caster = stored(2.0f), plain = stored(1.0f);
    bbl::MeshName name = bbl::name_mesh(engine, caster);
    // Every table shares one lease per record.
    assert(bbl::name_mesh(engine, caster) == name);
    bbl::retire_mesh_record(engine, caster);
    bbl::retire_mesh_record(engine, plain);
    // The unnamed mesh gives its slot up; the named one keeps its record,
    // and the bounds its released geometry gave it.
    assert(engine.free_mesh_slots.size() == 1 && engine.free_mesh_slots[0] == plain.value);
    const auto& kept = bbl::handle_at(engine.meshes, caster);
    assert(kept.retired && kept.geometry == bbl::invalid_handle);
    assert(kept.has_bounds_min_override && kept.bounds_min_override.x == -2.0f);
    assert(kept.has_bounds_max_override && kept.bounds_max_override.x == 2.0f);
    // Naming a retired mesh again takes its offered slot back.
    bbl::MeshName late = bbl::name_mesh(engine, plain);
    assert(engine.free_mesh_slots.empty());
    const auto next = stored(3.0f);
    assert(next.value == 2 && next.generation == 0);
    // Once the last names end, the next meshes take both slots under the
    // next generation.
    name.reset();
    late.reset();
    const auto first = stored(4.0f), second = stored(5.0f);
    assert(engine.meshes.size() == 3 && first.generation == 1 && second.generation == 1);
    // A kept handle whose slot a later mesh took cannot be named.
    bool refused = false;
    try { static_cast<void>(bbl::name_mesh(engine, caster)); }
    catch (const std::out_of_range&) { refused = true; }
    assert(refused);
    // A clone copies its source's record, not the names on it.
    const bbl::MeshName source_name = bbl::name_mesh(engine, first);
    const auto clone = bbl::store_mesh_record(engine, bbl::handle_at(engine.meshes, first));
    assert(bbl::handle_at(engine.meshes, clone).names.expired() && source_name);
    std::puts("mesh-name-reclamation: ok");
}
`,
        );
    },
);

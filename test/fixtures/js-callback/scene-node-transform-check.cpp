#include <bblite/runtime.hpp>
#include <cassert>
#include <iostream>

namespace bbl {
static int mesh_dirty = 0, mesh_live = 0, node_dirty = 0, node_live = 0, asset_writes = 0;
static AssetRecord asset_root;
static AssetRecord& asset_record(Engine&, std::uint32_t) { return asset_root; }
void mark_mesh_dirty(Engine&, MeshHandle) { ++mesh_dirty; }
void mark_mesh_runtime_transform(Engine&, MeshHandle) { ++mesh_live; }
void set_mesh_rotation_quaternion(Engine& e, MeshHandle h, Vec4 q, bool live) {
    e.meshes[h.value].rotation_quaternion = q;
    e.meshes[h.value].has_rotation_quaternion = true;
    if (live) ++mesh_live; else ++mesh_dirty;
}
void set_transform_node_position(Engine& e, TransformNodeHandle h, Vec3d p, bool live) {
    e.transform_nodes[h.value].position = p;
    if (live) ++node_live; else ++node_dirty;
}
void set_transform_node_rotation(Engine& e, TransformNodeHandle h, Vec3 p, bool live) {
    e.transform_nodes[h.value].rotation = p;
    if (live) ++node_live; else ++node_dirty;
}
void set_transform_node_scaling(Engine& e, TransformNodeHandle h, Vec3 p, bool live) {
    e.transform_nodes[h.value].scaling = p;
    if (live) ++node_live; else ++node_dirty;
}
void set_transform_node_rotation_quaternion(Engine& e, TransformNodeHandle h, Vec4 p, bool live) {
    e.transform_nodes[h.value].rotation_quaternion = p;
    if (live) ++node_live; else ++node_dirty;
}
static float& axis(Vec3& p, std::size_t n) {
    return n == 0 ? p.x : n == 1 ? p.y : p.z;
}
void set_asset_root_position_component(Engine&, AssetHandle, std::size_t n, float v) {
    axis(asset_root.root_position, n) = v; ++asset_writes;
}
void set_asset_root_rotation_component(Engine&, AssetHandle, std::size_t n, float v) {
    axis(asset_root.root_rotation, n) = v; ++asset_writes;
}
void set_asset_root_position(Engine&, AssetHandle, Vec3 p) {
    asset_root.root_position = p; ++asset_writes;
}
void set_asset_root_rotation(Engine&, AssetHandle, Vec3 p) {
    asset_root.root_rotation = p; ++asset_writes;
}
void reset_asset_root_scaling(Engine&, AssetHandle) { asset_root.root_scaling_reset = true; }
}

#include "scene-node-transforms.hpp"

int main() {
    using namespace bbl;
    Engine engine;
    engine.meshes.emplace_back();
    engine.transform_nodes.emplace_back();
    const SceneNodeHandle mesh = MeshHandle{0}, node = TransformNodeHandle{0}, asset = AssetHandle{0};
    assert(mesh == mesh && mesh != node && asset == asset);
    for (const auto& handle : {mesh, node}) {
        set_scene_node_position(engine, handle, {10000000000.25, 2, 3}, false);
        assert(scene_node_position(engine, handle).x == 10000000000.25);
        set_scene_node_rotation(engine, handle, {1, 2, 3}, true);
        assert(scene_node_rotation(engine, handle).y == 2);
        set_scene_node_scaling(engine, handle, {2, 3, 4}, false);
        assert(scene_node_scaling(engine, handle).z == 4);
        set_scene_node_rotation_quaternion(engine, handle, {0, 1, 0, 0}, true);
        assert(scene_node_rotation_quaternion(engine, handle).y == 1);
    }
    assert(mesh_dirty == 2 && mesh_live == 2 && node_dirty == 2 && node_live == 2);
    for (const auto& handle : {mesh, node}) {
        set_scene_node_position_component(engine, handle, 1, 7, true);
        assert(scene_node_position(engine, handle).x == 10000000000.25);
        assert(scene_node_position(engine, handle).y == 7);
        set_scene_node_rotation_component(engine, handle, 2, 8, false);
        assert(scene_node_rotation(engine, handle).x == 1);
        assert(scene_node_rotation(engine, handle).z == 8);
        set_scene_node_scaling_component(engine, handle, 0, 9, true);
        assert(scene_node_scaling(engine, handle).x == 9);
        assert(scene_node_scaling(engine, handle).y == 3);
        set_scene_node_rotation_quaternion_component(engine, handle, 3, 1, false);
        assert(scene_node_rotation_quaternion(engine, handle).y == 1);
        assert(scene_node_rotation_quaternion(engine, handle).w == 1);
    }
    assert(mesh_dirty == 4 && mesh_live == 4 && node_dirty == 4 && node_live == 4);
    set_scene_node_position(engine, asset, {4, 5, 6}, false);
    set_scene_node_rotation(engine, asset, {1, 2, 3}, true);
    assert(asset_writes == 2 && scene_node_position(engine, asset).y == 5);
    assert(scene_node_rotation(engine, asset).z == 3);
    set_scene_node_position_component(engine, asset, 0, 12, false);
    assert(scene_node_position(engine, asset).x == 12);
    assert(scene_node_position(engine, asset).y == 5 && asset_writes == 3);
    assert(scene_node_scaling(engine, asset).x == -1);
    set_scene_node_scaling(engine, asset, {1, 1, 1}, false);
    assert(scene_node_scaling(engine, asset).x == 1);
    set_scene_node_rotation_quaternion(engine, asset, {0, 0, 0, 1}, false);
    bool refused = false;
    try { set_scene_node_scaling(engine, asset, {2, 1, 1}, false); }
    catch (const std::runtime_error&) { refused = true; }
    assert(refused);
    std::cout << "scene-node-transform-check: ok\n";
}

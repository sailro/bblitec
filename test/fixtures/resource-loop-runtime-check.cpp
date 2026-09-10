#define main generated_grid_main
#include "grid.hpp"
#undef main
#include "mesh-material-setter.hpp"
#include <cassert>
#include <cstdio>

namespace {
std::vector<bbl::BoxOptions> constructions;
std::size_t registrations = 0;
std::size_t dirty_writes = 0;
}

// Record the resource seam; loops, handles, stores and scene ownership execute
// as emitted, without requiring a GPU for this compiler regression.
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
Scene create_scene_context(Engine& engine) {
    Scene scene;
    scene.engine = &engine;
    return scene;
}
MaterialHandle create_standard_material(Engine& engine) {
    const auto index = static_cast<std::uint32_t>(engine.materials.size());
    engine.materials.emplace_back();
    return {index};
}
MeshHandle create_box(Engine& engine, BoxOptions options) {
    const auto index = static_cast<std::uint32_t>(engine.meshes.size());
    engine.meshes.emplace_back();
    constructions.push_back(options);
    return {index};
}
void mark_mesh_dirty(Engine& engine, MeshHandle mesh) {
    assert(mesh.value < engine.meshes.size());
    ++dirty_writes;
}
void add_to_scene(Scene& scene, MeshHandle mesh) {
    assert(scene.engine && mesh.value == registrations);
    const auto& record = scene.engine->meshes[mesh.value];
    const auto& options = constructions[mesh.value];
    const double x = static_cast<double>(registrations / 64);
    const double y = static_cast<double>(registrations % 64);
    assert(record.position.x == x && record.position.y == y);
    assert(record.material.value == 0);
    assert(options.width == static_cast<float>(x + 1));
    assert(options.height == options.width && options.depth == options.width);
    scene.meshes.push_back(mesh);
    ++registrations;
}
}

int main() {
    const auto initial = bbl::js::managed_node_count();
    assert(generated_grid_main() == 0);
    assert(constructions.size() == 4096 && registrations == 4096);
    assert(dirty_writes == 8192);
    bbl::js::collect_cycles();
    assert(bbl::js::managed_node_count() == initial);
    std::puts("resource-loop-runtime-check: ok");
}

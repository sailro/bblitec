#include <bblite/runtime.hpp>
#include <algorithm>
#include <cassert>
#include <utility>

namespace bbl::upstream {
enum class RenderMaterialKind { standard, shader };
struct RenderItem { MeshHandle mesh; std::size_t geometry; MaterialHandle material; RenderMaterialKind material_kind = RenderMaterialKind::standard; };
struct RenderPlan { std::vector<RenderItem> items; unsigned draw_lists = 0; };
RenderPlan next_plan;
unsigned plans = 0, lists = 0;
RenderPlan build_render_plan(const Scene&, const Engine&) { ++plans; return next_plan; }
unsigned build_render_draw_lists(const std::vector<RenderItem>&, const Engine&) { return ++lists; }
}
namespace bbl::pal {
unsigned uploads = 0, releases = 0, prunes = 0;
struct GpuMesh {
    unsigned lease;
    explicit GpuMesh(unsigned value) : lease(value) {}
    GpuMesh(GpuMesh&& source) noexcept : lease(std::exchange(source.lease, 0u)) {}
    GpuMesh& operator=(GpuMesh&& source) noexcept { assert(lease == 0); lease = std::exchange(source.lease, 0u); return *this; }
    void reset() { assert(lease); lease = 0; ++releases; }
};
using DawnMesh = GpuMesh;
struct State {
    std::vector<GpuMesh> meshes;
    std::vector<int> shader_pipelines{1}, shared_shader_geometries, shared_shader_material_textures;
    int grid_pipeline = 1;
    void prune_shared_shader_geometries() { ++prunes; }
    void prune_shared_shader_material_textures() { ++prunes; }
    void prune_shared_composed_material_textures() { ++prunes; }
};
constexpr unsigned material_family_shader = 1, material_family_grid = 2;
void reject_uncomposed_family_growth(unsigned added) { assert(added == 0); }
void validate_render_plan_items(const upstream::RenderPlan&) {}
void release_gpu_mesh(State&, GpuMesh& mesh) { mesh.reset(); }
GpuMesh upload_dawn_scene_mesh(State&, Engine&, const upstream::RenderItem&) { return GpuMesh{++uploads + 100}; }
GpuMesh upload_sdl_scene_mesh(State& state, Engine& engine, const upstream::RenderItem& item, int*) { return upload_dawn_scene_mesh(state, engine, item); }
void prune_shared_shader_geometries(State& state) { state.prune_shared_shader_geometries(); }
void prune_shared_shader_material_textures(State& state) { state.prune_shared_shader_material_textures(); }
void prune_shared_composed_material_textures(State& state) { state.prune_shared_composed_material_textures(); }
void trace_scene_topology(const Scene&, const Engine&, std::size_t, std::size_t, std::size_t, std::size_t, std::size_t, unsigned) {}
#include "rematch.hpp"
struct Driver {
    Scene scene; Engine engine; State state;
    upstream::RenderPlan render_plan;
    std::uint64_t synced_render_topology_version = 0, synced_draw_list_epoch = 0;
    unsigned synced_material_family_mask = 0, frame = 0, tasks = 0;
    int frame_buffer_uploads = 0;
    bool topology_updated = false;
    void rebuild_task_draw_lists() { ++tasks; }
};
struct Sdl : Driver {
#include "SdlSync.hpp"
};
struct Dawn : Driver {
#include "DawnSync.hpp"
};
template<class Backend> void check() {
    uploads = releases = prunes = upstream::plans = upstream::lists = 0;
    Backend driver;
    driver.engine.draw_list_epoch = driver.synced_draw_list_epoch = 0;
    driver.render_plan.items = {{MeshHandle{1}, 1, MaterialHandle{1}}, {MeshHandle{2}, 2, MaterialHandle{2}}, {MeshHandle{3}, 3, MaterialHandle{3}}};
    for (unsigned id : {1u, 2u, 3u}) driver.state.meshes.emplace_back(id);
    driver.synchronize();
    assert(uploads == 0 && releases == 0 && driver.tasks == 0);
    // Remove the middle row and append a new row. Existing leases survive.
    upstream::next_plan.items = {driver.render_plan.items[0], driver.render_plan.items[2], {MeshHandle{4}, 4, MaterialHandle{4}}};
    ++driver.scene.render_topology_version;
    driver.synchronize();
    assert(uploads == 1 && releases == 1 && prunes == 3 && upstream::plans == 1 && driver.tasks == 1);
    assert(driver.state.meshes[0].lease == 1 && driver.state.meshes[1].lease == 3 && driver.state.meshes[2].lease == 101);
    driver.topology_updated = false;
    ++driver.engine.draw_list_epoch;
    driver.synchronize();
    assert(upstream::lists == 1 && driver.tasks == 2 && uploads == 1 && releases == 1);
    assert(driver.synced_draw_list_epoch == driver.engine.draw_list_epoch);
    driver.synchronize();
    assert(driver.tasks == 2 && upstream::lists == 1);
    // A material change replaces only its row, even with the same mesh handle.
    upstream::next_plan.items[0].material = MaterialHandle{9};
    ++driver.scene.render_topology_version;
    driver.synchronize();
    assert(uploads == 2 && releases == 2 && driver.state.meshes[1].lease == 3 && driver.state.meshes[2].lease == 101);
    // Clear the scene while earlier submitted leases may still be in flight.
    upstream::next_plan.items.clear(); ++driver.scene.render_topology_version;
    driver.synchronize();
    assert(driver.state.meshes.empty() && uploads == 2 && releases == 5);
    bool refused = false;
    try { std::vector<GpuMesh> empty; rematch_render_meshes(std::vector<upstream::RenderItem>{{MeshHandle{0}, 0, MaterialHandle{0}}}, {}, empty,
        [](GpuMesh& mesh) { mesh.reset(); }, [](const auto&) { return GpuMesh{1}; }); }
    catch (const std::runtime_error&) { refused = true; }
    assert(refused);
}
}
int main() { bbl::pal::check<bbl::pal::Sdl>(); bbl::pal::check<bbl::pal::Dawn>(); }

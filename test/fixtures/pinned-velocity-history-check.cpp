#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <stdexcept>
#include <vector>

namespace bbl {
struct MeshHandle {
    std::uint32_t value = 0xffffffffu;
    std::uint32_t generation = 0;
    [[nodiscard]] bool operator==(const MeshHandle&) const = default;
};
struct Scene {
    std::uint64_t render_topology_version = 0;
};
struct Engine {
    std::vector<std::array<float, 16>> meshes;
};
const auto& handle_at(const auto& meshes, MeshHandle mesh) { return meshes.at(mesh.value); }
namespace upstream {
enum class RenderMaterialKind { standard, pbr };
struct RenderItem {
    MeshHandle mesh;
    int material = 0;
    RenderMaterialKind material_kind = RenderMaterialKind::standard;
};
RenderItem bind_render_item(RenderItem item, const Engine&, int) { return item; }
// The Standard geometry output's mesh block: the world, then the velocity
// tail its `~geometry-params` fragment appends.
struct MeshUniforms {
    std::array<float, 16> world{};
#if FIXTURE_VELOCITY
    std::array<float, 16> previousWorld{};
    float velocityEnabled = -1.0f;
#endif
};
} // namespace upstream
namespace pal {
int world_compositions = 0;
std::array<float, 16> mesh_block_world(const Scene&, const Engine&,
                                       const std::array<float, 16>& world) {
    ++world_compositions;
    return world;
}
#include "velocity.hpp"
} // namespace pal
} // namespace bbl

namespace {
void check(bool condition, const char* what) {
    if (!condition) {
        std::printf("pinned-velocity-history-check: %s\n", what);
        std::exit(1);
    }
}

std::array<float, 16> world_at(float x) {
    std::array<float, 16> world{};
    world[0] = world[5] = world[10] = world[15] = 1.0f;
    world[12] = x;
    return world;
}

bbl::upstream::MeshUniforms draw(const bbl::pal::PinnedVelocityHistory& history,
                                 bbl::MeshHandle mesh) {
    bbl::upstream::MeshUniforms block;
    bbl::pal::write_pinned_velocity_tail(history, mesh, block);
    return block;
}
} // namespace

int main() {
    using namespace bbl;
    using namespace bbl::pal;
    Scene scene;
    PinnedVelocityHistory history;
    const MeshHandle mesh{2, 1};
    Engine engine;
    engine.meshes.resize(3);
    engine.meshes[2] = world_at(1.0f);
    const std::vector<upstream::RenderItem> items{{mesh}, {mesh}};
    update_pinned_velocity_frame(history, scene, engine, items);
#if !FIXTURE_VELOCITY
    check(history.frame == 0 && history.renderables.empty() && world_compositions == 0,
          "a block without a velocity tail never builds history or composes worlds");
    (void)draw(history, mesh);
#else
    check(world_compositions == 1, "duplicate draws compose the world once per frame");
    check(draw(history, mesh).world == world_at(1.0f), "draw uses the frame's composed world");
    history = {};

    // The renderable's first frame: built with this world, velocity off.
    begin_pinned_velocity_frame(history, scene);
    update_pinned_velocity(history, mesh, world_at(1.0f));
    upstream::MeshUniforms block = draw(history, mesh);
    check(block.velocityEnabled == 0.0f, "a first frame writes velocity disabled");
    check(block.previousWorld == world_at(1.0f), "a renderable is built with its world");
    // A second draw of the mesh in the frame binds the same block.
    update_pinned_velocity(history, mesh, world_at(9.0f));
    block = draw(history, mesh);
    check(block.world == world_at(1.0f), "repeated draws retain the first world in the frame");
    check(block.velocityEnabled == 0.0f && block.previousWorld == world_at(1.0f),
          "one update per frame");

    // Later frames: the previous frame's world, velocity on.
    begin_pinned_velocity_frame(history, scene);
    update_pinned_velocity(history, mesh, world_at(2.0f));
    block = draw(history, mesh);
    check(block.velocityEnabled == 1.0f, "a later frame enables velocity");
    check(block.previousWorld == world_at(1.0f), "the previous frame's world");
    begin_pinned_velocity_frame(history, scene);
    update_pinned_velocity(history, mesh, world_at(3.0f));
    check(draw(history, mesh).previousWorld == world_at(2.0f), "the snapshot advances");

    // A moved renderable version rebuilds every renderable.
    scene.render_topology_version = 1;
    begin_pinned_velocity_frame(history, scene);
    update_pinned_velocity(history, mesh, world_at(4.0f));
    block = draw(history, mesh);
    check(block.velocityEnabled == 0.0f && block.previousWorld == world_at(4.0f),
          "a rebuilt renderable starts over");

    // A slot a new mesh reuses is a new renderable.
    const MeshHandle reused{2, 2};
    begin_pinned_velocity_frame(history, scene);
    update_pinned_velocity(history, reused, world_at(5.0f));
    block = draw(history, reused);
    check(block.velocityEnabled == 0.0f && block.previousWorld == world_at(5.0f),
          "a reused slot starts over");

    // A draw the frame's update did not reach refuses.
    begin_pinned_velocity_frame(history, scene);
    bool refused = false;
    try {
        (void)draw(history, reused);
    } catch (const std::logic_error&) {
        refused = true;
    }
    check(refused, "an unreached draw refuses");
#endif
    std::puts("pinned-velocity-history-check: ok");
    return 0;
}

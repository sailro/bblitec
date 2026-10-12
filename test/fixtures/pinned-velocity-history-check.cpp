#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <stdexcept>
#include <vector>

#include "pal_gpu_velocity.hpp"

namespace bbl::pal {
int world_compositions = 0;
std::array<float, 16> mesh_block_world(const Scene&, const Engine&, const MeshRecord& mesh) {
    ++world_compositions;
    std::array<float, 16> world{};
    world[0] = world[5] = world[10] = world[15] = 1.0f;
    world[12] = static_cast<float>(mesh.position.x);
    return world;
}
} // namespace bbl::pal

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
    engine.meshes[2].position.x = 1.0;
    engine.meshes[2].generation = mesh.generation;
    std::vector<upstream::RenderItem> items{{mesh}, {mesh}};
    for (auto& item : items)
        item.source_identity = 7;
    update_pinned_velocity_frame(history, scene, engine, items, nullptr);
#if !FIXTURE_VELOCITY
    check(history.frame == 0 && history.renderables.empty() && world_compositions == 0,
          "a block without a velocity tail never builds history or composes worlds");
    (void)draw(history, mesh);
#else
    check(world_compositions == 1, "duplicate draws compose the world once per frame");
    check(draw(history, mesh).world == world_at(1.0f), "draw uses the frame's composed world");
    history = {};

    const CameraRecord first_camera{}, second_camera{};
    const PinnedVelocityHistory::Stamp stamp{0, &first_camera};
    // The renderable's first frame: built with this world, velocity off.
    begin_pinned_velocity_frame(history, scene, stamp);
    update_pinned_velocity(history, mesh, 7, world_at(1.0f));
    upstream::MeshUniforms block = draw(history, mesh);
    check(block.velocityEnabled == 0.0f, "a first frame writes velocity disabled");
    check(block.previousWorld == world_at(1.0f), "a renderable is built with its world");
    // A second draw of the mesh in the frame binds the same block.
    update_pinned_velocity(history, mesh, 7, world_at(9.0f));
    block = draw(history, mesh);
    check(block.world == world_at(1.0f), "repeated draws retain the first world in the frame");
    check(block.velocityEnabled == 0.0f && block.previousWorld == world_at(1.0f),
          "one update per frame");

    // Later frames: the previous frame's world, velocity on.
    begin_pinned_velocity_frame(history, scene, stamp);
    update_pinned_velocity(history, mesh, 7, world_at(2.0f));
    block = draw(history, mesh);
    check(block.velocityEnabled == 1.0f, "a later frame enables velocity");
    check(block.previousWorld == world_at(1.0f), "the previous frame's world");
    begin_pinned_velocity_frame(history, scene, stamp);
    update_pinned_velocity(history, mesh, 7, world_at(3.0f));
    check(draw(history, mesh).previousWorld == world_at(2.0f), "the snapshot advances");

    // A sync, at a version move or a record(), carries an entry still drawn
    // through the same forward renderable.
    scene.render_topology_version = 1;
    begin_pinned_velocity_frame(history, scene, stamp);
    update_pinned_velocity(history, mesh, 7, world_at(4.0f));
    block = draw(history, mesh);
    check(block.velocityEnabled == 1.0f && block.previousWorld == world_at(3.0f),
          "a carried renderable keeps its history across a version sync");
    record_pinned_velocity(history);
    begin_pinned_velocity_frame(history, scene, stamp);
    update_pinned_velocity(history, mesh, 7, world_at(5.0f));
    block = draw(history, mesh);
    check(block.velocityEnabled == 1.0f && block.previousWorld == world_at(4.0f),
          "a carried renderable keeps its history across a record");

    // A rebuilt forward renderable, an unpublished item and a changed stamp
    // each start over at a sync, whichever triggered it.
    const auto starts_over = [&](std::uint64_t identity, const PinnedVelocityHistory::Stamp& next,
                                 bool record, float x, const char* what) {
        if (record)
            record_pinned_velocity(history);
        else
            ++scene.render_topology_version;
        begin_pinned_velocity_frame(history, scene, next);
        update_pinned_velocity(history, mesh, identity, world_at(x));
        const auto rebuilt = draw(history, mesh);
        check(rebuilt.velocityEnabled == 0.0f && rebuilt.previousWorld == world_at(x), what);
        begin_pinned_velocity_frame(history, scene, next);
        update_pinned_velocity(history, mesh, identity, world_at(x + 1.0f));
        check(draw(history, mesh).velocityEnabled == 1.0f, what);
    };
    starts_over(8, stamp, false, 6.0f, "a rebuilt forward renderable starts over");
    starts_over(0, stamp, false, 8.0f, "an unpublished item starts over");
    starts_over(0, stamp, true, 10.0f, "an unpublished item starts over at a record");
    starts_over(8, {0, &second_camera}, false, 12.0f, "another pass camera starts over");
    starts_over(8, {0, &first_camera}, true, 14.0f, "another pass camera starts over at a record");
    starts_over(8, {1, &first_camera}, false, 16.0f, "another device starts over");

    // A slot a new mesh reuses is a new renderable.
    const MeshHandle reused{2, 2};
    const PinnedVelocityHistory::Stamp last{1, &first_camera};
    begin_pinned_velocity_frame(history, scene, last);
    update_pinned_velocity(history, reused, 8, world_at(5.0f));
    block = draw(history, reused);
    check(block.velocityEnabled == 0.0f && block.previousWorld == world_at(5.0f),
          "a reused slot starts over");

    // A draw the frame's update did not reach refuses.
    begin_pinned_velocity_frame(history, scene, last);
    bool refused = false;
    try {
        (void)draw(history, reused);
    } catch (const std::logic_error&) {
        refused = true;
    }
    check(refused, "an unreached draw refuses");

    // A floating origin's frame drawn with another camera than the stamped
    // one clears the stamp, so the next sync carries nothing, even back on
    // the stamped camera.
    history = {};
    const PinnedVelocityHistory::Stamp second{0, &second_camera};
    for (int frame = 0; frame < 2; ++frame) {
        begin_pinned_velocity_frame(history, scene, stamp);
        clear_pinned_velocity_stamp(history, &first_camera);
        update_pinned_velocity(history, mesh, 7, world_at(1.0f));
    }
    begin_pinned_velocity_frame(history, scene, second);
    clear_pinned_velocity_stamp(history, &second_camera);
    update_pinned_velocity(history, mesh, 7, world_at(1.0f));
    check(draw(history, mesh).velocityEnabled == 1.0f, "another camera alone is no sync");
    record_pinned_velocity(history);
    begin_pinned_velocity_frame(history, scene, stamp);
    update_pinned_velocity(history, mesh, 7, world_at(1.0f));
    check(draw(history, mesh).velocityEnabled == 0.0f,
          "a floating origin's camera switch clears the stamp");
#endif
    std::puts("pinned-velocity-history-check: ok");
    return 0;
}

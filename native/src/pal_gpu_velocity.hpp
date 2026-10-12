// Per-geometry-task Standard mesh velocity snapshots, shared by both renderers.
#pragma once

#include <bblite/runtime.hpp>
#include <bblite/upstream/render_capabilities.hpp>
#include <array>
#include <cstdint>
#include <stdexcept>
#include <vector>
#if BBLITE_PINNED_MATERIALS && BBLITE_PINNED_MATERIAL_VARIANTS
#include <bblite/upstream/renderer_plan.hpp>
#include "pal_gpu_surface.hpp"
#include "pal_gpu_variants.hpp"
#endif

namespace bbl::pal {

/**
 * A geometry task's Standard renderables' velocity state
 * (`standard-geometry-renderable.ts`), one per mesh slot.
 *
 * The pin builds one renderable per bound mesh. It packs the mesh's world
 * as `previousWorld` when built and starts with `velocityReady` false; each
 * frame's update writes the mesh block from that snapshot and flag, then
 * snapshots the current world and sets the flag, so a renderable's first
 * frame writes `velocityEnabled` 0 and the composed vertex's previous clip
 * falls back to the current one. The task rebuilds every renderable when
 * the scene's renderable version moves (`rebuildBoundMeshes`), which here is
 * the scene's `render_topology_version`, and a slot a new mesh reuses is a
 * new renderable. The composed velocity arm and its block tail belong to the
 * Standard geometry output alone, so the history is written for nothing
 * else. Unguarded because the geometry encode names it in both backends
 * whatever the variant count.
 */
struct PinnedVelocityHistory {
    struct Renderable {
        MeshHandle mesh{};
        /** The pin's `previousWorld` snapshot and `velocityReady`. */
        std::array<float, 16> previous_world{};
        bool velocity_ready = false;
        /**
         * The history frame this renderable last updated in and what that
         * update wrote: the pin updates each bound renderable once a frame,
         * before any draw, so every draw of the mesh in the frame binds the
         * same block.
         */
        std::uint64_t updated_frame = 0;
        std::array<float, 16> written_previous_world{};
        float written_velocity_enabled = 0.0f;
    };
    std::uint64_t frame = 0;
    std::uint64_t topology_version = 0;
    std::vector<Renderable> renderables;
};

template <typename Block>
concept PinnedVelocityBlock = requires(Block block) {
    block.previousWorld;
    block.velocityEnabled;
};

inline void begin_pinned_velocity_frame(PinnedVelocityHistory& history, const Scene& scene) {
    if (history.frame == 0 || history.topology_version != scene.render_topology_version) {
        history.renderables.clear();
        history.topology_version = scene.render_topology_version;
    }
    ++history.frame;
}

inline const PinnedVelocityHistory::Renderable&
update_pinned_velocity(PinnedVelocityHistory& history, MeshHandle mesh,
                       const std::array<float, 16>& world) {
    if (history.renderables.size() <= mesh.value) {
        history.renderables.resize(static_cast<std::size_t>(mesh.value) + 1u);
    }
    PinnedVelocityHistory::Renderable& renderable = history.renderables[mesh.value];
    if (!(renderable.mesh == mesh)) {
        renderable = {};
        renderable.mesh = mesh;
        renderable.previous_world = world;
    }
    if (renderable.updated_frame != history.frame) {
        renderable.written_previous_world = renderable.previous_world;
        renderable.written_velocity_enabled = renderable.velocity_ready ? 1.0f : 0.0f;
        renderable.previous_world = world;
        renderable.velocity_ready = true;
        renderable.updated_frame = history.frame;
    }
    return renderable;
}

#if BBLITE_PINNED_MATERIALS && BBLITE_PINNED_MATERIAL_VARIANTS
inline void update_pinned_velocity_frame(PinnedVelocityHistory& history, const Scene& scene,
                                         const Engine& engine,
                                         std::span<const upstream::RenderItem> items) {
    if constexpr (!PinnedVelocityBlock<upstream::MeshUniforms>) {
        return;
    }
    begin_pinned_velocity_frame(history, scene);
    for (const upstream::RenderItem& source : items) {
        const upstream::RenderItem item =
            upstream::bind_render_item(source, engine, source.material);
        if (item.material_kind != upstream::RenderMaterialKind::standard) {
            continue;
        }
        if (item.mesh.value < history.renderables.size()) {
            const auto& renderable = history.renderables[item.mesh.value];
            if (renderable.mesh == item.mesh && renderable.updated_frame == history.frame)
                continue;
        }
        update_pinned_velocity(
            history, item.mesh,
            mesh_block_world(scene, engine, handle_at(engine.meshes, item.mesh)));
    }
}

inline void write_pinned_velocity_tail(const PinnedVelocityHistory& history, MeshHandle mesh,
                                       upstream::MeshUniforms& block) {
    [&]<typename Block>(Block& dependent) {
        if constexpr (PinnedVelocityBlock<Block>) {
            if (mesh.value >= history.renderables.size() ||
                !(history.renderables[mesh.value].mesh == mesh) ||
                history.renderables[mesh.value].updated_frame != history.frame) {
                throw std::logic_error("A geometry task drew a Standard mesh its frame's "
                                       "velocity update did not reach.");
            }
            const PinnedVelocityHistory::Renderable& renderable = history.renderables[mesh.value];
            dependent.world = renderable.previous_world;
            dependent.previousWorld = renderable.written_previous_world;
            dependent.velocityEnabled = renderable.written_velocity_enabled;
        }
    }(block);
}
#endif

} // namespace bbl::pal

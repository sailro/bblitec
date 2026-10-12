// Per-geometry-task Standard mesh velocity snapshots, shared by both renderers.
#pragma once

#include <bblite/runtime.hpp>
#include <bblite/upstream/render_capabilities.hpp>
#include <array>
#include <cstdint>
#include <optional>
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
 * falls back to the current one. The task re-syncs (`rebuildBoundMeshes`)
 * at every `record()` and whenever the scene's renderable version (here
 * `render_topology_version`) moves: an entry whose mesh still draws the same
 * source material through the forward renderable it was built alongside (the
 * published `SourceMaterialDraw`) is carried with its history, and a new or
 * changed one is a new renderable, as is a slot a new mesh reuses. A sync whose
 * stamp (`_cfg`) differs from the last one carries nothing. The composed
 * velocity arm and its block tail belong to the Standard geometry output
 * alone, so the history is written for nothing else. Unguarded because the
 * geometry encode names it in both backends whatever the variant count.
 */
struct PinnedVelocityHistory {
    struct Renderable {
        MeshHandle mesh{};
        /**
         * The forward renderable it was built alongside, which names its
         * source material; 0 when no source output publishes the item.
         */
        std::uint64_t source_identity = 0;
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
    /**
     * The pin's `_cfg` stamp, published with each sync: the device and the
     * camera the pass draws with. A native geometry task takes no camera of
     * its own, so the stamp's override element is always null.
     */
    struct Stamp {
        std::uint64_t device = 0;
        const CameraRecord* camera = nullptr;
        bool operator==(const Stamp&) const = default;
    };
    std::uint64_t frame = 0;
    /**
     * The frame the last sync ran in: an entry not updated since is carried
     * or rebuilt at its next update.
     */
    std::uint64_t synced_frame = 0;
    /** The scene version the last sync reflects, the pin's `_boundVer`. */
    std::uint64_t topology_version = 0;
    /** A `record()` since the last sync: the next frame syncs. */
    bool recorded = true;
    std::optional<Stamp> stamp;
    std::vector<Renderable> renderables;
};

template <typename Block>
concept PinnedVelocityBlock = requires(Block block) {
    block.previousWorld;
    block.velocityEnabled;
};

/**
 * `recordTask`'s closing `rebuildBoundMeshes`: the frame graph rebuilt the
 * task's attachments (its build, a resize). The sync runs at the task's next
 * frame, against the camera that frame draws with.
 */
inline void record_pinned_velocity(PinnedVelocityHistory& history) { history.recorded = true; }

inline void begin_pinned_velocity_frame(PinnedVelocityHistory& history, const Scene& scene,
                                        const PinnedVelocityHistory::Stamp& stamp) {
    ++history.frame;
    if (history.recorded || history.topology_version != scene.render_topology_version) {
        // A sync: carry nothing across a changed stamp. Otherwise each entry
        // is carried or rebuilt as its update finds it (`update_pinned_velocity`).
        if (history.stamp != stamp)
            history.renderables.clear();
        history.stamp = stamp;
        history.topology_version = scene.render_topology_version;
        history.recorded = false;
        history.synced_frame = history.frame;
    }
}

/**
 * `executeTask`'s floating-origin arm: a frame drawn with another camera
 * than the stamped one clears the stamp, so the next sync carries nothing.
 */
inline void clear_pinned_velocity_stamp(PinnedVelocityHistory& history,
                                        const CameraRecord* camera) {
    if (history.stamp && history.stamp->camera != camera)
        history.stamp.reset();
}

inline const PinnedVelocityHistory::Renderable&
update_pinned_velocity(PinnedVelocityHistory& history, MeshHandle mesh,
                       std::uint64_t source_identity, const std::array<float, 16>& world) {
    if (history.renderables.size() <= mesh.value) {
        history.renderables.resize(static_cast<std::size_t>(mesh.value) + 1u);
    }
    PinnedVelocityHistory::Renderable& renderable = history.renderables[mesh.value];
    // An item no source output publishes has no forward renderable to carry
    // through, so it is rebuilt at every sync, as the pin rebuilds a mesh
    // without one of its own.
    const bool synced = renderable.updated_frame < history.synced_frame;
    const bool carried = source_identity != 0 && renderable.source_identity == source_identity;
    if (!(renderable.mesh == mesh) || (synced && !carried)) {
        renderable = {};
        renderable.mesh = mesh;
        renderable.source_identity = source_identity;
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
                                         std::span<const upstream::RenderItem> items,
                                         const CameraRecord* camera) {
    if constexpr (!PinnedVelocityBlock<upstream::MeshUniforms>) {
        return;
    }
    begin_pinned_velocity_frame(history, scene, {engine.device_generation, camera});
#if BBLITE_FLOATING_ORIGIN
    clear_pinned_velocity_stamp(history, camera);
#endif
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
            history, item.mesh, item.source_identity,
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

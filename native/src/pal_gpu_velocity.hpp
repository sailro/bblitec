// Per-geometry-task mesh velocity snapshots, shared by both renderers.
#pragma once

#include <bblite/features/geometry_velocity.hpp>
#include <bblite/runtime.hpp>
#include <bblite/upstream/render_capabilities.hpp>
#include <algorithm>
#include <array>
#include <cstdint>
#include <optional>
#include <span>
#include <stdexcept>
#include <vector>
#if BBLITE_PINNED_MATERIALS && BBLITE_PINNED_MATERIAL_VARIANTS
#include <bblite/upstream/renderer_plan.hpp>
#include "pal_gpu_surface.hpp"
#include "pal_gpu_variants.hpp"
#endif
#if BBLITE_GEOMETRY_VELOCITY
#include <bblite/upstream/geometry_velocity.hpp>
#include "pal_gpu_vertex.hpp"
#endif

namespace bbl::pal {

/**
 * A geometry task's renderables' velocity state, one per mesh slot: a
 * Standard renderable's (`standard-geometry-renderable.ts`) and a PBR one's
 * (`createPbrGeometryVelocity`), and either's deformation previous pose
 * (`createGeometryDeformationVelocity`). The pin keeps the two families'
 * world histories apart -- Standard writes its previous world into the mesh
 * block, PBR its previous-from-current product into its own `gm` block --
 * and shares the deformation.
 *
 * The pin builds one renderable per bound mesh. A Standard one packs the
 * mesh's world as `previousWorld` when built and starts with `velocityReady`
 * false; each frame's update writes the mesh block from that snapshot and
 * `velocityReady && tracked`, then snapshots the current world and sets the
 * flag to `tracked`, so a renderable's first frame writes `velocityEnabled` 0
 * and the composed vertex's previous clip falls back to the current one. The
 * task re-syncs (`rebuildBoundMeshes`)
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
#if BBLITE_GEOMETRY_VELOCITY
        /**
         * A PBR renderable's `createPbrGeometryVelocity` state, made with
         * the renderable, and either family's deformation previous pose
         * when the mesh deforms. `packed_world` is the world a PBR mesh block
         * last packed: the update's `worldChanged` is a change of it.
         */
        std::optional<upstream::PbrGeometryVelocity> pbr;
        std::optional<upstream::GeometryDeformationVelocity> deformation;
        std::array<float, 16> packed_world{};
        /** The mesh's morph weights, read each frame into reused storage. */
        std::vector<float> morph_weights;
#endif
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
#if BBLITE_GEOMETRY_VELOCITY
    /** The families the task's preloads bridged (`_preload`), from its registration's. */
    std::optional<std::uint32_t> preloaded_families;
#endif
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
        if (history.stamp != stamp) {
            history.renderables.clear();
        }
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

/**
 * The renderable a mesh's frame update reaches: carried, or rebuilt (reset
 * to a new renderable of `mesh`, which `rebuilt` reports).
 */
inline PinnedVelocityHistory::Renderable& sync_pinned_velocity(PinnedVelocityHistory& history,
                                                               MeshHandle mesh,
                                                               std::uint64_t source_identity,
                                                               bool& rebuilt) {
    if (history.renderables.size() <= mesh.value) {
        history.renderables.resize(static_cast<std::size_t>(mesh.value) + 1u);
    }
    PinnedVelocityHistory::Renderable& renderable = history.renderables[mesh.value];
    // An item no source output publishes has no forward renderable to carry
    // through, so it is rebuilt at every sync, as the pin rebuilds a mesh
    // without one of its own.
    const bool synced = renderable.updated_frame < history.synced_frame;
    const bool carried = source_identity != 0 && renderable.source_identity == source_identity;
    rebuilt = !(renderable.mesh == mesh) || (synced && !carried);
    if (rebuilt) {
        renderable = {};
        renderable.mesh = mesh;
        renderable.source_identity = source_identity;
    }
    return renderable;
}

/** The update of a renderable whose velocity view composes no previous pose. */
struct NoVelocityDeformation {
    void operator()(PinnedVelocityHistory::Renderable&, bool, bool) const {}
};

/**
 * One Standard renderable's frame (`_baseUpdate`): `tracked` is
 * `mesh.visible !== false` (no reached program excludes a mesh from
 * velocity). `deformation(renderable, rebuilt, neutral)` runs where the pin's
 * `deformationVelocity?._update(!velocityEnabled)` does, between the block's
 * write and the world snapshot.
 */
template <typename Deformation = NoVelocityDeformation>
inline const PinnedVelocityHistory::Renderable&
update_pinned_velocity(PinnedVelocityHistory& history, MeshHandle mesh,
                       std::uint64_t source_identity, const std::array<float, 16>& world,
                       bool tracked = true, Deformation&& deformation = {}) {
    bool rebuilt = false;
    PinnedVelocityHistory::Renderable& renderable =
        sync_pinned_velocity(history, mesh, source_identity, rebuilt);
    if (rebuilt)
        renderable.previous_world = world;
    if (renderable.updated_frame != history.frame) {
        const bool velocity_enabled = renderable.velocity_ready && tracked;
        renderable.written_previous_world = renderable.previous_world;
        renderable.written_velocity_enabled = velocity_enabled ? 1.0f : 0.0f;
        deformation(renderable, rebuilt, !velocity_enabled);
        renderable.previous_world = world;
        renderable.velocity_ready = tracked;
        renderable.updated_frame = history.frame;
    }
    return renderable;
}

#if BBLITE_GEOMETRY_VELOCITY
/** A task's per-mesh velocity resources, grown to reach `mesh`. */
template <typename Resources>
Resources& mesh_velocity_resources(std::vector<Resources>& slots, MeshHandle mesh) {
    if (slots.size() <= mesh.value)
        slots.resize(static_cast<std::size_t>(mesh.value) + 1u);
    return slots[mesh.value];
}
#endif

#if BBLITE_PINNED_MATERIALS && BBLITE_PINNED_MATERIAL_VARIANTS
/**
 * What a backend uploads for a geometry task's velocity renderables: a PBR
 * one's `gm` block (`createPbrGeometryVelocity`) when made and at each
 * `write()`, and either family's deformation previous bones and morph
 * weights.
 */
template <typename Sink>
concept VelocitySink = requires(Sink sink, MeshHandle mesh, std::span<const float> floats) {
    sink.block(mesh, floats);
    sink.bones(mesh, floats);
    sink.morph(mesh, floats);
};

/** The sink of a program without `enableGeometryVelocity`, which uploads nothing. */
struct NoVelocitySink {
    void block(MeshHandle, std::span<const float>) const {}
    void bones(MeshHandle, std::span<const float>) const {}
    void morph(MeshHandle, std::span<const float>) const {}
};

#if BBLITE_GEOMETRY_VELOCITY
/**
 * The live pose a deformation snapshots: the mesh's bone palette, and its
 * morph weights, read into the renderable's reused storage.
 */
inline std::span<const float> velocity_pose(PinnedVelocityHistory::Renderable& renderable,
                                            [[maybe_unused]] const Engine& engine,
                                            const MeshRecord& record) {
    std::vector<float>& weights = renderable.morph_weights;
    weights.clear();
#if BBLITE_GPU_MORPH_STORAGE
    // The pin's `mesh.morphTargets`, set by the loader or a scene attachment.
    if ((record.morph_targets_attached || record.scene_morph_targets) &&
        record.geometry < engine.geometries.size())
        morph_weight_values(engine.geometries[record.geometry], record, weights);
#endif
    return record.bone_matrices.empty()
               ? std::span<const float>{}
               : std::span<const float>(record.bone_matrices.data()->data(),
                                        record.bone_matrices.size() * 16u);
}

/**
 * `createGeometryDeformationVelocity`, made with the renderable of a mesh
 * neither instanced nor baked that carries a skeleton or a morph set: PBR's
 * `needsDeformation`, and Standard's `_hasDeformationVelocity` once the
 * enabler installed the feature (a Standard skeleton is `HAS_SKELETON`
 * exactly for such a mesh).
 */
inline void make_velocity_deformation(PinnedVelocityHistory::Renderable& renderable,
                                      const MeshRecord& record, std::span<const float> bones) {
    if (!record.thin_instances && !record.has_vat &&
        (!bones.empty() || !renderable.morph_weights.empty()))
        renderable.deformation =
            upstream::create_geometry_deformation_velocity(bones, renderable.morph_weights);
}

/** The deformation's `_update(neutral)`, uploading its snapshots through `sink`. */
template <VelocitySink Sink>
inline void advance_velocity_deformation(PinnedVelocityHistory::Renderable& renderable,
                                         bool neutral, std::span<const float> bones,
                                         MeshHandle mesh, Sink& sink) {
    if (!renderable.deformation)
        return;
    upstream::update_geometry_deformation_velocity(
        *renderable.deformation, neutral, bones, renderable.morph_weights,
        [&](std::span<const float> snapshot) { sink.bones(mesh, snapshot); },
        [&](std::span<const float> snapshot) { sink.morph(mesh, snapshot); });
}

/**
 * One PBR renderable's frame (`pbr-geometry-renderable.ts` update): the
 * velocity state is made with the renderable from the world its mesh block
 * packs, and `_update(worldChanged)` runs after the block repacks a changed
 * world. `tracked` is `mesh.visible !== false`: no reached program excludes
 * a mesh from velocity.
 */
template <VelocitySink Sink>
inline void update_pbr_geometry_velocity(PinnedVelocityHistory& history, const Scene& scene,
                                         const Engine& engine, const upstream::RenderItem& item,
                                         Sink& sink) {
    const MeshRecord& record = handle_at(engine.meshes, item.mesh);
    const std::array<float, 16> world = mesh_block_world(scene, engine, record);
    const bool tracked = !(record.visible == false);
    bool rebuilt = false;
    PinnedVelocityHistory::Renderable& renderable =
        sync_pinned_velocity(history, item.mesh, item.source_identity, rebuilt);
    const std::span<const float> bones = velocity_pose(renderable, engine, record);
    if (rebuilt || !renderable.pbr) {
        renderable.pbr = upstream::create_pbr_geometry_velocity(world, tracked);
        renderable.packed_world = world;
        make_velocity_deformation(renderable, record, bones);
        sink.block(item.mesh, renderable.pbr->data);
    }
    const bool world_changed = renderable.packed_world != world;
    if (world_changed)
        renderable.packed_world = world;
    upstream::update_pbr_geometry_velocity(
        *renderable.pbr, renderable.packed_world, world_changed, tracked,
        [&](bool neutral) {
            advance_velocity_deformation(renderable, neutral, bones, item.mesh, sink);
        },
        [&] { sink.block(item.mesh, renderable.pbr->data); });
    renderable.updated_frame = history.frame;
}
#endif

/**
 * A geometry task's renderables, updated once a frame before any draw: the
 * Standard ones' history, with their previous pose once the program reaches
 * `enableGeometryVelocity` (whose installed feature every Standard velocity
 * view composes from) or a task preload loaded the deformation feature, and
 * in a task the enabler reached (`task.geometry.velocity_previous_depth`) the PBR
 * ones' material-point velocity.
 */
template <VelocitySink Sink = NoVelocitySink>
inline void update_pinned_velocity_frame(PinnedVelocityHistory& history, const Scene& scene,
                                         const Engine& engine,
                                         std::span<const upstream::RenderItem> items,
                                         const CameraRecord* camera,
                                         [[maybe_unused]] const FrameTaskRecord& task,
                                         [[maybe_unused]] Sink&& sink = {}) {
    constexpr bool standard = PinnedVelocityBlock<upstream::MeshUniforms>;
#if BBLITE_GEOMETRY_VELOCITY
    const bool pbr = task.geometry.velocity_previous_depth.has_value();
    // `_hasDeformationVelocity` reads the view's `_needsVelocity`.
    const bool standard_deformation = std::ranges::any_of(
        task.geometry.attachments, [](const GeometryTextureDescription& attachment) {
            return attachment.type == GeometryTextureType::linear_velocity;
        });
#else
    constexpr bool pbr = false;
#endif
    if (!standard && !pbr) {
        return;
    }
    begin_pinned_velocity_frame(history, scene, {engine.device_generation, camera});
#if BBLITE_FLOATING_ORIGIN
    clear_pinned_velocity_stamp(history, camera);
#endif
#if BBLITE_GEOMETRY_VELOCITY && BBLITE_STANDARD_VARIANTS > 0
    // `_lateLoad`: a family first listed after the task's preloads re-runs
    // `_preload` over the current list. The pin binds that family's meshes
    // only once the reload lands, so a late Standard family's renderables
    // compose under what it loads; the renderables of families already
    // bridged are built in the sync that starts it, before it lands.
    const bool synced = history.synced_frame == history.frame;
    if (!history.preloaded_families)
        history.preloaded_families = task.geometry_preloaded_families.value_or(0u);
    const std::uint32_t listed =
        synced ? upstream::geometry_task_families(engine, scene.meshes) : 0u;
    const bool late = (listed & ~*history.preloaded_families) != 0;
    const auto late_load = [&] {
        history.preloaded_families = *history.preloaded_families |
                                     upstream::preload_geometry_task(engine, scene, task.geometry);
    };
    const bool late_standard =
        late && (listed & ~*history.preloaded_families & upstream::geometry_family_standard) != 0;
    if (late_standard)
        late_load();
#endif
    for (const upstream::RenderItem& source : items) {
        const upstream::RenderItem item =
            upstream::bind_render_item(source, engine, source.material);
        const bool standard_item =
            standard && item.material_kind == upstream::RenderMaterialKind::standard;
        const bool pbr_item = pbr && item.material_kind == upstream::RenderMaterialKind::pbr;
        if (!standard_item && !pbr_item) {
            continue;
        }
        if (item.mesh.value < history.renderables.size()) {
            const auto& renderable = history.renderables[item.mesh.value];
            if (renderable.mesh == item.mesh && renderable.updated_frame == history.frame)
                continue;
        }
#if BBLITE_GEOMETRY_VELOCITY
        if (pbr_item) {
            update_pbr_geometry_velocity(history, scene, engine, item, sink);
            continue;
        }
#endif
        const MeshRecord& record = handle_at(engine.meshes, item.mesh);
#if BBLITE_GEOMETRY_VELOCITY
        const auto deformation = [&](PinnedVelocityHistory::Renderable& renderable, bool rebuilt,
                                     bool neutral) {
            if (!standard_deformation)
                return;
            const std::span<const float> bones = velocity_pose(renderable, engine, record);
            if (rebuilt) {
                make_velocity_deformation(renderable, record, bones);
#if BBLITE_STANDARD_VARIANTS > 0
                if (renderable.deformation)
                    upstream::require_standard_deformation_velocity(
                        !renderable.morph_weights.empty());
#endif
            }
            advance_velocity_deformation(renderable, neutral, bones, item.mesh, sink);
        };
#else
        const NoVelocityDeformation deformation;
#endif
        update_pinned_velocity(history, item.mesh, item.source_identity,
                               mesh_block_world(scene, engine, record), !(record.visible == false),
                               deformation);
    }
#if BBLITE_GEOMETRY_VELOCITY && BBLITE_STANDARD_VARIANTS > 0
    if (late && !late_standard)
        late_load();
#endif
}

#if BBLITE_GEOMETRY_VELOCITY
/** The velocity state of the PBR renderable a geometry draw binds, updated this frame. */
inline const upstream::PbrGeometryVelocity& pbr_velocity_state(const PinnedVelocityHistory& history,
                                                               MeshHandle mesh) {
    const PinnedVelocityHistory::Renderable* renderable =
        mesh.value < history.renderables.size() ? &history.renderables[mesh.value] : nullptr;
    if (!renderable || !(renderable->mesh == mesh) || renderable->updated_frame != history.frame ||
        !renderable->pbr) {
        throw std::logic_error("A geometry task drew a PBR mesh its frame's velocity update "
                               "did not reach.");
    }
    return *renderable->pbr;
}
#endif

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

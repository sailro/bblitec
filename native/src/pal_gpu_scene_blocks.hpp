// The pin's per-pass and per-mesh blocks, built once for both backends:
// the scene block, the billboard group, the lights array, the mesh blocks
// and the geometry task's parameters and velocity history.
#pragma once
#include <bblite/features/has_billboards.hpp>
#include "pal_gpu_shadows.hpp"

namespace bbl::pal {

/**
 * The pin's `gpUniforms` block, declared by a geometry-output variant whose
 * attachments include NORMALIZED_VIEW_DEPTH or LINEAR_VELOCITY
 * (`pbr-geometry-output-shader.ts` createPbrGeometryParamsFragment):
 * the task's previous-frame view-projection and the camera's near/far.
 * Unguarded because the geometry encode names it in both backends whatever
 * the variant count.
 */
struct PinnedGeometryParams {
    std::array<float, 16> previousViewProjection{};
    std::array<float, 4> cameraNearFar{};
};

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

/** Opens a task frame; a moved renderable version rebuilds every renderable. */
void begin_pinned_velocity_frame(PinnedVelocityHistory& history, const Scene& scene);

/**
 * The renderable's update for this frame, run once however many draws the
 * mesh has: builds the renderable on its first frame, then writes the
 * snapshot and flag and snapshots `world`.
 */
const PinnedVelocityHistory::Renderable& update_pinned_velocity(PinnedVelocityHistory& history,
                                                                MeshHandle mesh,
                                                                const std::array<float, 16>& world);

#if BBLITE_PINNED_MATERIALS || BBLITE_HAS_BILLBOARDS
/**
 * The pin's per-pass scene block.
 *
 * Every member is the one the pin's own declaration names; the fragment reads
 * its view direction from `vEyePosition` and its reflection path from `view`,
 * both from the camera the pass renders with. Shared, because the block is the
 * pin's rather than either backend's: Dawn uploads it to a buffer and SDL_GPU
 * pushes it at a uniform slot, and neither should decide what is in it.
 */
upstream::SceneUniforms pinned_scene_block(const Scene& scene, const Engine& engine,
                                           const CameraRecord& camera,
                                           const std::array<float, 16>& view_projection);
#endif

#if BBLITE_HAS_BILLBOARDS
/**
 * The scene block a billboard program binds at its group 0: the pin's
 * block for the pass, over the view projection and view the pass draws
 * billboards with. A pass without a camera writes none and keeps what its
 * block last held (`pal::write_billboard_scene_block`).
 */
upstream::SceneUniforms billboard_scene_block(const Scene& scene, const Engine& engine,
                                              const CameraRecord& camera,
                                              const std::array<float, 16>& view_projection,
                                              const std::array<float, 16>& view);
#endif

#if BBLITE_PINNED_MATERIALS
/**
 * The pin's per-pass lights block: a u32 count, three words of padding, then
 * MAX_LIGHTS entries.
 *
 * `fillLightsData` writes that count through a Float32Array view of the same
 * buffer, so it lands in the first four bytes. Returned as bytes because that is
 * what both a buffer upload and a uniform push take.
 */
std::vector<std::uint8_t> pinned_lights_block(const Scene& scene, const Engine& engine);

// The pin's per-draw mesh block.
//
// `writeMeshLightSelection` decides its shape: the world matrix, the count of
// lights affecting this mesh, then their indices. Which lights those are comes
// from the generated `light_affects_mesh`, lowered from the pin's own
// `affectsMesh`, so this walks exactly the set the Standard slot writer walks.
/**
 * The pin's own per-mesh light selection (`writeMeshLightSelection`).
 *
 * Shared because the mesh block is not one struct: the material families
 * declare `MeshUniforms` and a node graph declares its own `MeshU` with a
 * shadow lane between the world matrix and the count. What they agree on is
 * this walk, so it is written once over whichever block's lanes.
 */
template <typename Block>
inline void pinned_mesh_light_selection(const Scene& scene, const Engine& engine, MeshHandle mesh,
                                        Block& block) {
    if constexpr (requires {
                      block.li;
                      block.lc;
                  }) {
        std::uint32_t count = 0;
        std::uint32_t light_index = 0;
        for (const LightHandle handle : scene.lights) {
            if (light_index >= upstream::pinned_max_lights)
                break;
            if (handle.value >= engine.lights.size())
                continue;
            if (upstream::light_affects_mesh(handle_at(engine.lights, handle), mesh)) {
                block.li[count / 4][count % 4] = light_index;
                ++count;
            }
            ++light_index;
        }
        block.lc = count;
    }
}

#if BBLITE_PINNED_MATERIAL_VARIANTS
/** The pin's `MeshUniforms` for one mesh: its world and its light selection. */
upstream::MeshUniforms pinned_mesh_block(const Scene& scene, const Engine& engine, MeshHandle mesh);

/**
 * A geometry task's pre-draw update (`geometry-renderer-task.ts` executes
 * every bound renderable's `update` before its first draw): each Standard
 * mesh of the layer's plan, the hidden ones included, because the pin
 * reads visibility only at the draw.
 */
void update_pinned_velocity_frame(PinnedVelocityHistory& history, const Scene& scene,
                                  const Engine& engine,
                                  const std::vector<upstream::RenderItem>& items);

/**
 * The Standard geometry output's block tail (`standard-geometry-renderable.ts`
 * `_baseUpdate`): what this frame's update wrote for the mesh. The generic
 * lambda makes the access dependent: outside a template both `if constexpr`
 * branches must compile, and most scenes' mirrored MeshUniforms carries no
 * velocity tail.
 */
void write_pinned_velocity_tail(const PinnedVelocityHistory& history, MeshHandle mesh,
                                upstream::MeshUniforms& block);
#endif

#if BBLITE_NODE_VARIANTS > 0
/**
 * A node graph's per-draw mesh block (`node-renderable.ts`).
 *
 * The pin packs the mesh's world matrix, `receiveShadows ? 1 : 0` in the
 * shadow lane, and the same light selection every family uses.
 *
 * The shadow lane is a VALUE here where it is a composition key for the
 * other two families: `node-shadow.ts` mixes each light's factor by it
 * (`mix(1.0, _sf[i], meshU.receivesShadow.x)`), so one composed module
 * draws a receiving mesh and a non-receiving one alike.
 */
upstream::NodeMeshUniforms node_mesh_block(const Scene& scene, const Engine& engine,
                                           MeshHandle mesh);
#endif
#endif

} // namespace bbl::pal

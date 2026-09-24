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
inline void begin_pinned_velocity_frame(PinnedVelocityHistory& history, const Scene& scene) {
    if (history.frame == 0 || history.topology_version != scene.render_topology_version) {
        history.renderables.clear();
        history.topology_version = scene.render_topology_version;
    }
    ++history.frame;
}

/**
 * The renderable's update for this frame, run once however many draws the
 * mesh has: builds the renderable on its first frame, then writes the
 * snapshot and flag and snapshots `world`.
 */
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
inline upstream::SceneUniforms pinned_scene_block(const Scene& scene, const Engine& engine,
                                                  const CameraRecord& camera,
                                                  const std::array<float, 16>& view_projection) {
    upstream::SceneUniforms scene_block{};
    scene_block.viewProjection = view_projection;
    // The pin's fragment reads the view direction from `vEyePosition`, and its
    // reflection path from `view`. Both come from the camera the pass renders
    // with, the same one `build_pbr_uniforms` reads.
    const std::array<upstream::CameraMatrixScalar, 16> camera_world =
        upstream::camera_world_matrix(camera);
#if BBLITE_FLOATING_ORIGIN
    const Vec3d fo_offset = floating_origin_offset(scene, engine);
    const Vec3d fo_camera_eye = upstream::arc_rotate_eye_position(camera);
#endif
    scene_block.vEyePosition = {
#if BBLITE_FLOATING_ORIGIN
        // `writePassSceneUBO` writes `cameraWorld - offset` under floating
        // origin, and the offset IS this camera's world position -- so the
        // eye sits at the origin of the same frame the mesh worlds and the
        // view translation were put in. Written as the difference rather
        // than as zero because a render task drawing through a second
        // camera is relative to the scene camera, not to itself.
        // Both sides are the camera's own F64 world translation, so the
        // steady-state eye is exactly zero -- reading the left side off the
        // narrowed float world instead would leave half an ULP of the
        // large coordinate behind.
        static_cast<float>(fo_camera_eye.x - fo_offset.x),
        static_cast<float>(fo_camera_eye.y - fo_offset.y),
        static_cast<float>(fo_camera_eye.z - fo_offset.z),
#else
        static_cast<float>(camera_world[12]),
        static_cast<float>(camera_world[13]),
        static_cast<float>(camera_world[14]),
#endif
        1.0f,
    };
    scene_block.view = upstream::build_view_matrix(camera_world);
    scene_block.envRotationY = scene.environment.rotation_y;
    // `vImageInfos` is documented in the pin's own declaration as
    // exposureLinear, contrast, lodGenerationScale, toneMappingEnabled.
    scene_block.vImageInfos = {
        scene.environment.exposure,
        scene.environment.contrast,
        scene.environment.lod_generation_scale,
        // The pin's executeRenderTaskLinear stamps its negative flag over
        // toneMappingEnabled while a transmission scene's retargeted linear
        // passes run; every composed fragment and background arm then skips
        // its processing tail (`if(scene.vImageInfos.w>=0.0)`) and the
        // trailing image-processing pass applies it once. The captured
        // browser block carries the same -1 (scene30 buffer#1).
        scene.transmission_enabled               ? upstream::pinned_linear_tone_mapping
        : scene.environment.tone_mapping_enabled ? 1.0f
                                                 : 0.0f,
    };
    scene_block.vFogInfos = {
        scene.fog_mode,
        scene.fog_start,
        scene.fog_end,
        scene.fog_density,
    };
    // `_packSceneUniforms` writes the canvas size into the block's two spare
    // lanes -- `vFogColor.w` and `_envPad0` -- for every scene, and a node
    // graph's ScreenSizeBlock is what reads them back. The size is the
    // engine's configured one, which is what `eng.canvas` reports.
    scene_block.vFogColor = {
        scene.fog_color.r,
        scene.fog_color.g,
        scene.fog_color.b,
        static_cast<float>(engine.options.width),
    };
    scene_block._envPad0 = static_cast<float>(engine.options.height);
    // `writeClipPlaneUbo`, the scene-UBO contributor `setClipPlane`
    // registers. A scene that never clips carries the zero vector, which
    // is the same distance the pin's unwritten lanes produce.
    scene_block.clipPlane = {
        scene.clip_plane.x,
        scene.clip_plane.y,
        scene.clip_plane.z,
        scene.clip_plane.w,
    };
    const std::array<std::array<float, 4>*, 9> harmonics{
        &scene_block.vSphericalL00, &scene_block.vSphericalL1_1, &scene_block.vSphericalL10,
        &scene_block.vSphericalL11, &scene_block.vSphericalL2_2, &scene_block.vSphericalL2_1,
        &scene_block.vSphericalL20, &scene_block.vSphericalL21,  &scene_block.vSphericalL22,
    };
    for (std::size_t index = 0; index < harmonics.size(); ++index) {
        const Color3& band = scene.environment.spherical_harmonics[index];
        *harmonics[index] = {band.r, band.g, band.b, 0.0f};
    }
    return scene_block;
}
#endif

#if BBLITE_HAS_BILLBOARDS
/**
 * The scene block a billboard program binds at its group 0: the pin's
 * block for the pass, over the view projection and view the pass draws
 * billboards with. A pass without a camera writes none and keeps what its
 * block last held (`pal::write_billboard_scene_block`).
 */
inline upstream::SceneUniforms billboard_scene_block(const Scene& scene, const Engine& engine,
                                                     const CameraRecord& camera,
                                                     const std::array<float, 16>& view_projection,
                                                     const std::array<float, 16>& view) {
    upstream::SceneUniforms block = pinned_scene_block(scene, engine, camera, view_projection);
    block.viewProjection = view_projection;
    block.view = view;
    return block;
}
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
inline std::vector<std::uint8_t> pinned_lights_block(const Scene& scene, const Engine& engine) {
    std::array<std::uint32_t, 4> header{};
    std::array<upstream::LightEntry, upstream::pinned_max_lights> entries{};
    std::uint32_t count = 0;
    for (const LightHandle handle : scene.lights) {
        if (count >= upstream::pinned_max_lights)
            break;
        if (handle.value >= engine.lights.size())
            continue;
        const LightRecord& light = handle_at(engine.lights, handle);
        // Which writer each kind takes is generated: the scene compiles arms
        // only for the kinds it reaches, so the mapping cannot be restated here.
        upstream::write_pinned_light(light, entries[count]);
        ++count;
    }
    header[0] = count;
#if BBLITE_FLOATING_ORIGIN
    apply_light_floating_origin(entries, count, scene, engine);
#endif
    std::vector<std::uint8_t> bytes(sizeof(header) + entries.size() * sizeof(upstream::LightEntry));
    std::memcpy(bytes.data(), header.data(), sizeof(header));
    std::memcpy(bytes.data() + sizeof(header), entries.data(),
                entries.size() * sizeof(upstream::LightEntry));
    return bytes;
}

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
inline upstream::MeshUniforms pinned_mesh_block(const Scene& scene, const Engine& engine,
                                                MeshHandle mesh) {
    upstream::MeshUniforms block{};
    block.world = mesh_block_world(scene, engine, handle_at(engine.meshes, mesh));
    pinned_mesh_light_selection(scene, engine, mesh, block);
    return block;
}

/**
 * A geometry task's pre-draw update (`geometry-renderer-task.ts` executes
 * every bound renderable's `update` before its first draw): each Standard
 * mesh of the layer's plan, the hidden ones included, because the pin
 * reads visibility only at the draw.
 */
inline void update_pinned_velocity_frame(PinnedVelocityHistory& history, const Scene& scene,
                                         const Engine& engine,
                                         const std::vector<upstream::RenderItem>& items) {
    begin_pinned_velocity_frame(history, scene);
    for (const upstream::RenderItem& source : items) {
        const upstream::RenderItem item =
            upstream::bind_render_item(source, engine, source.material);
        if (item.material_kind != upstream::RenderMaterialKind::standard) {
            continue;
        }
        update_pinned_velocity(
            history, item.mesh,
            mesh_block_world(scene, engine, handle_at(engine.meshes, item.mesh)));
    }
}

/**
 * The Standard geometry output's block tail (`standard-geometry-renderable.ts`
 * `_baseUpdate`): what this frame's update wrote for the mesh. The generic
 * lambda makes the access dependent: outside a template both `if constexpr`
 * branches must compile, and most scenes' mirrored MeshUniforms carries no
 * velocity tail.
 */
inline void write_pinned_velocity_tail(const PinnedVelocityHistory& history, MeshHandle mesh,
                                       upstream::MeshUniforms& block) {
    [&](auto& dependent) {
        if constexpr (requires {
                          dependent.previousWorld;
                          dependent.velocityEnabled;
                      }) {
            if (mesh.value >= history.renderables.size() ||
                !(history.renderables[mesh.value].mesh == mesh) ||
                history.renderables[mesh.value].updated_frame != history.frame) {
                throw std::logic_error("A geometry task drew a Standard mesh its frame's "
                                       "velocity update did not reach.");
            }
            const PinnedVelocityHistory::Renderable& renderable = history.renderables[mesh.value];
            dependent.previousWorld = renderable.written_previous_world;
            dependent.velocityEnabled = renderable.written_velocity_enabled;
        }
    }(block);
}
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
inline upstream::NodeMeshUniforms node_mesh_block(const Scene& scene, const Engine& engine,
                                                  MeshHandle mesh) {
    upstream::NodeMeshUniforms block{};
    const MeshRecord& record = handle_at(engine.meshes, mesh);
    block.world = mesh_block_world(scene, engine, record);
    if (record.receives_shadows) {
        block.receivesShadow[0] = 1.0f;
    }
    // `writeAttributeFlags`: the block's three spare lanes carry whether
    // the mesh supplies uv1, tangents and vertex colours, which is what
    // `MeshAttributeExistsBlock` selects its serialized fallback on. The
    // pin skips these stores for a graph that raised no such block; here
    // they are unconditional, because a module that does not declare the
    // block never reads the lanes and every mesh block is packed by this
    // one function.
    if (record.geometry < engine.geometries.size()) {
        const ModelGeometry& geometry = engine.geometries[record.geometry];
        block.receivesShadow[1] = geometry.has_uvs ? 1.0f : 0.0f;
        block.receivesShadow[2] = geometry.has_tangents ? 1.0f : 0.0f;
        block.receivesShadow[3] = geometry.has_vertex_colors ? 1.0f : 0.0f;
    }
    pinned_mesh_light_selection(scene, engine, mesh, block);
    return block;
}
#endif
#endif

} // namespace bbl::pal

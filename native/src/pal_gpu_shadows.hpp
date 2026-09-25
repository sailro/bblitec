// The shadow family's shared half: the depth state a pass takes, the
// casters a directional fit folds, and the generators' refresh.
#pragma once
#include <bblite/features/shadows_csm.hpp>
#include "pal_gpu_materials.hpp"

namespace bbl::pal {

#if BBLITE_SHADOWS_ESM
inline bool esm_map_is_active(const Engine& engine, std::uint32_t index) {
    return std::any_of(engine.shadow_generators.begin(), engine.shadow_generators.end(),
                       [index](const ShadowGeneratorRecord& generator) {
                           return generator.filter == ShadowFilter::esm_directional &&
                                  generator.esm_index == index &&
                                  generator.map_target.value != invalid_handle;
                       });
}
#endif

/**
 * The depth state one pass takes: the pin's own convention, or the shadow
 * target's exception to it.
 *
 * `createShadowRenderTarget` is the single place upstream names another
 * compare and another clear, and generation emits both from that descriptor
 * — so a pass asks here rather than either backend typing standard-Z out.
 */
DepthCompare pass_depth_compare(bool shadow_pass);

float pass_depth_clear(bool shadow_pass);

/**
 * How many samples a pass rasterizes at.
 *
 * The third field of the same exception: `createShadowRenderTarget` names
 * one sample, because a multisampled map would need a resolve before the
 * receiver could sample it and the pin builds none. Emitted from that
 * descriptor beside the compare and the clear, so all three answer from one
 * reading of the pin rather than two read and one typed.
 */
std::uint32_t pass_depth_samples(bool shadow_pass, std::uint32_t scene_samples);

#if BBLITE_SHADOW_RECEIVERS
/**
 * The casters `computeDirectionalLightMatrix` folds, as it reads them.
 *
 * The pin walks `Mesh` objects and takes `worldMatrix`, `boundMin` and
 * `boundMax` off each; composing a world matrix is this layer's, so the
 * carrier is filled here and the fold stays the pin's. Geometry bounds start
 * from the pin's fallback and live public bound overrides are applied last.
 *
 * Not the ESM generator's alone: BOTH directional generators fit their
 * volume to the caster bounds, because a directional light has no position
 * to project from. Only the spot generator builds its volume from the
 * light, which is why this is gated on the receiver half rather than on
 * either filter.
 */
void fitted_shadow_casters(const Engine& engine, const ShadowGeneratorRecord& generator,
                           std::vector<upstream::ShadowCaster>& casters);
#endif

#if BBLITE_SHADOW_RECEIVERS
/**
 * The scene's shadow generators, each with its light's own slot in
 * `scene.lights`.
 *
 * That slot IS the ordinal every shadow contract names. The pin composes a
 * receiver's group-2 rows as `shadowTex_<lightIndex>`, where `lightIndex`
 * is "the position of its light in `scene.lights`" -- so a scene whose
 * shadow-casting light is not its first light numbers its rows from the
 * light, not from a count of generators. Counting generators instead
 * agrees with the light order exactly while every light carries one, and
 * scene 207 -- an ambient hemispheric light beside a shadow-casting
 * directional -- is where the two part company.
 *
 * Stated once so a backend that keys densely and one that keys by handle
 * cannot disagree about which generator is light `n`.
 */
template <typename Visit>
inline void for_each_shadow_generator(const Scene& scene, const Engine& engine, Visit&& visit) {
    for (std::size_t slot = 0; slot < scene.lights.size(); ++slot) {
        const LightHandle light = scene.lights[slot];
        if (light.value >= engine.lights.size())
            continue;
        const ShadowGeneratorHandle handle = handle_at(engine.lights, light).shadow_generator;
        if (handle.value >= engine.shadow_generators.size())
            continue;
        visit(handle, light, slot);
    }
}

/**
 * The light-space pair one caster pass renders through.
 *
 * A cascaded generator draws one pass per cascade and each carries that
 * cascade's own biased view-projection; every other generator has one pass
 * and the pair on the record. Which one a pass takes is decided by the
 * generator's own FILTER, not by whether an index happens to be in range,
 * and it is decided once here because both backends ask the same question.
 */
struct ShadowCasterMatrices {
    const std::array<float, 16>& view_projection;
    const std::array<float, 16>& view;
};

ShadowCasterMatrices shadow_caster_matrices(const Engine& engine, const FrameTaskRecord& task);

/** The refresh's own carriers, kept by each backend across frames. */
struct ShadowRefreshState {
    /** Refilled per generator by the ESM caster fold, never reallocated. */
    std::vector<upstream::ShadowCaster> casters;
    /**
     * The receiver block each generator last uploaded, by handle, against
     * which the next frame's is compared. `renderPcfShadowMap` re-uploads
     * only when the light moved, and for a static one those bytes are
     * identical every frame. The carrier holds whichever of the two shapes
     * the generator publishes -- 96 bytes for a single-map receiver, 320
     * for a cascaded one -- and its own size beside them.
     */
    std::vector<upstream::ShadowReceiverBlock> blocks;
    /** Whether `blocks[handle]` holds an upload yet. */
    std::vector<bool> uploaded;
    /** The enabled value last synchronized into this backend's receiver allocation. */
    std::vector<upstream::ShadowEnabledUploadState> enabled_uploads;
    /**
     * The pinned render gate's `_last*` lanes, by handle — the state each
     * `render*ShadowMap` hook keeps on its task between frames, plus the
     * frame's `due` verdict `refresh_shadow_generators` writes for the
     * task loop. Backend state rather than a record field because the
     * pin's is task state: each backend's task loop skips against what IT
     * last rendered.
     */
    std::vector<upstream::ShadowRefreshGate> gates;
    /**
     * Frame-graph texture recreation (a resize, a target added) released
     * every rendered map, so what the gate knows is rendered no longer
     * exists. Clearing the sentinels makes each generator's next frame
     * render, the way a fresh pinned task state's `-1` lanes do.
     */
    void invalidate_rendered_maps() {
        for (upstream::ShadowRefreshGate& gate : gates) {
            gate.rendered = false;
        }
    }
};

/**
 * Refresh every generator the scene's lights name, then hand each to the
 * backend.
 *
 * What is shared is the refresh and BOTH dirty tests. The outer one is the
 * pin's render gate: every `render*ShadowMap` hook returns before the
 * matrix fit and the caster pass when neither the casters' nor the light's
 * version moved (`shadow_refresh_due` carries the full rule), so the fit
 * runs — the ESM/directional one re-reading its casters' world bounds, the
 * PCF spot rebuilding from the light's live position and direction — only
 * on the frames the pin would run it. The inner one is the receiver block:
 * what falls out of a fit is re-uploaded only when it moved. All of that
 * is engine-side math with one right answer.
 *
 * What stays per backend is the resource each keeps for a generator, which
 * is what the visitor receives: the record, its own handle, its dense
 * position in the light order, the block, and whether that block is new.
 * The gate's verdict lands on the gate itself (`gates[handle].due`), which
 * the backend's task loop reads to skip the pass itself. A gated frame
 * whose block is already uploaded skips the visitor too: the fit did not
 * run, so the block's bytes are provably the ones the backend holds.
 */
template <typename Visit>
inline void refresh_shadow_generators(const Scene& scene, Engine& engine,
                                      ShadowRefreshState& refresh, Visit&& visit) {
    if (refresh.blocks.size() < engine.shadow_generators.size()) {
        refresh.blocks.resize(engine.shadow_generators.size());
        refresh.uploaded.resize(engine.shadow_generators.size(), false);
        refresh.enabled_uploads.resize(engine.shadow_generators.size());
        refresh.gates.resize(engine.shadow_generators.size());
    }
    // The pin's own floating-origin offset for a shadow map:
    // `renderPcfShadowMap` and `renderEsmShadowMap` each read the active
    // camera's world translation and build the light view and the caster fit
    // against it, so the map lands in the same eye-relative frame the mesh
    // worlds are packed into. Off the mode this is the zero vector, which is
    // the pin's own `foCam ? ... : 0`. A frame constant, so it is read once
    // here rather than per generator.
    const Vec3d eye = frame_floating_origin_offset(scene, engine);
#if BBLITE_SHADOWS_CSM
    // `csmCameraAspect` is `getEffectiveAspectRatio(camera, rt._width,
    // rt._height)`, so a camera carrying a viewport fits its cascades to
    // the frustum it actually draws. A scene with no camera goes through
    // the same pinned body over a default record -- whose viewport is
    // empty, which IS the pin's nullish camera -- rather than restating the
    // whole-target ratio, where the second copy would be the one that
    // drifts. A frame constant like `eye` above, so it is read once here
    // rather than per generator.
    const PixelViewport surface_extent =
        scene_surface_extent(engine, scene, engine.options.width, engine.options.height);
    const CameraRecord* const aspect_camera = scene_camera(engine, scene);
    const double csm_camera_aspect = upstream::effective_aspect_ratio(
        aspect_camera ? *aspect_camera : no_camera_record,
        static_cast<double>(surface_extent.width), static_cast<double>(surface_extent.height));
#endif
    for_each_shadow_generator(
        scene, engine, [&](ShadowGeneratorHandle handle, LightHandle light, std::size_t slot) {
            ShadowGeneratorRecord& generator = handle_at(engine.shadow_generators, handle);
            const LightRecord& light_record = handle_at(engine.lights, light);
            upstream::ShadowRefreshGate& gate = handle_at(refresh.gates, handle);
            const auto notify_receivers = [&](const upstream::ShadowReceiverBlock& block) {
#if BBLITE_SHADOWS_CSM
                const auto receiver_callbacks = generator.csm_receiver_callbacks;
                if (generator.filter == ShadowFilter::csm_directional && receiver_callbacks &&
                    !receiver_callbacks->empty()) {
                    js::F32Array values(block.size / sizeof(float));
                    if (!values.empty())
                        std::memcpy(values.data(), block.bytes.data(), block.size);
                    receiver_callbacks->dispatch(values);
                }
#else
                (void)block;
#endif
            };
            // A backend refresh owns each receiver allocation and its source upload state.
            bool shadow_enabled = true;
            if (generator.runtime_enabled) {
                upstream::ShadowReceiverBlock block =
                    handle_at(refresh.uploaded, handle)
                        ? handle_at(refresh.blocks, handle)
                        : upstream::shadow_receiver_block(generator);
#if BBLITE_SHADOWS_CSM
                if (generator.filter == ShadowFilter::csm_directional &&
                    !handle_at(refresh.uploaded, handle))
                    block.bytes.fill(std::byte{});
#endif
                // Shadow receiver slots remain allocated for this refresh state's lifetime.
                const std::uint64_t receiver_identity =
                    static_cast<std::uint64_t>(handle.value) + 1;
                shadow_enabled = upstream::synchronize_shadow_enabled(
                    generator, handle_at(refresh.enabled_uploads, handle), receiver_identity,
                    [&]() -> std::optional<js::F32Array> {
#if BBLITE_SHADOWS_CSM
                        js::F32Array values(block.size / sizeof(float));
                        if (!values.empty())
                            std::memcpy(values.data(), block.bytes.data(), block.size);
                        return values;
#else
                        return std::nullopt;
#endif
                    },
                    [&]() -> std::shared_ptr<PlatformEventListeners<void(const js::F32Array&)>> {
#if BBLITE_SHADOWS_CSM
                        return generator.csm_receiver_callbacks;
#else
                        return {};
#endif
                    },
                    [&](std::uint64_t, double byte_offset, const auto& data) {
                        const auto offset = static_cast<std::size_t>(byte_offset);
                        const auto bytes = data.size() * sizeof(float);
                        if (offset > block.size || bytes > block.size - offset)
                            throw std::runtime_error(
                                "Shadow enabled receiver upload exceeds its block.");
                        std::memcpy(block.bytes.data() + offset, data.data(), bytes);
                        visit(generator, handle, slot, block, true);
                        handle_at(refresh.blocks, handle) = block;
                        handle_at(refresh.uploaded, handle) = true;
                    });
            }
            const upstream::CsmCameraKey* csm_camera = nullptr;
#if BBLITE_SHADOWS_CSM
            const double aspect = csm_camera_aspect;
            // `renderCsmShadowMap` keys its gate on the camera the cascade
            // is fitted to — change key and aspect — in place of the
            // single-map generators' floating-origin term. The key here is
            // what the fit consumes: the camera view-projection (aspect
            // folded in) and the near/far pair the split formula reads. A
            // forced generator's gate returns before reading it, so the
            // key is built only when the gate will.
            const CameraRecord* const fit_camera = scene_camera(engine, scene);
            const bool csm_fit =
                generator.filter == ShadowFilter::csm_directional && fit_camera != nullptr;
            upstream::CsmCameraKey camera_key;
            if (csm_fit)
                csm_camera = &camera_key;
            if (csm_fit && !generator.force_refresh_every_frame) {
                camera_key.view_projection = upstream::build_view_projection(*fit_camera, aspect);
                camera_key.near_plane = fit_camera->near_plane;
                camera_key.far_plane = fit_camera->far_plane;
            }
#endif
            // The pin's render gate, ahead of each family's fit exactly as
            // each `render*ShadowMap` hook tests it ahead of its own. On a
            // skipped frame the generator's matrices — and so the block
            // below — keep their last-render values. The verdict lands on
            // the gate, where each backend's task loop reads it to skip
            // the caster pass itself.
            const bool due =
                shadow_enabled && upstream::shadow_refresh_due(engine, generator, light_record, eye,
                                                               csm_camera, gate);
            gate.due = due;
            if (due) {
                if (generator.filter == ShadowFilter::pcf_spot) {
                    upstream::update_pcf_spot_shadow(generator, light_record, eye);
                } else {
                    // Every directional fit re-reads its casters' world
                    // bounds; the spot rebuild reads only the light. The
                    // PCF directional arm needs no define of its own: it
                    // shares every resource the spot generator builds, and
                    // what it needs beside them -- the caster fit -- is
                    // the receiver half's, not the ESM's.
                    fitted_shadow_casters(engine, generator, refresh.casters);
#if BBLITE_SHADOWS_ESM
                    if (generator.filter == ShadowFilter::esm_directional) {
                        upstream::update_esm_directional_shadow(generator, light_record,
                                                                refresh.casters, eye);
                    } else
#endif
#if BBLITE_SHADOWS_CSM
                        if (csm_fit) {
                        upstream::update_csm_cascades(generator, light_record,
                                                      handle_at(engine.cameras, scene.camera),
                                                      aspect, refresh.casters);
                    } else
#endif
                    {
                        upstream::update_pcf_directional_shadow(generator, light_record,
                                                                refresh.casters, eye);
                    }
                }
            } else if (handle_at(refresh.uploaded, handle)) {
                // A gated frame's fit did not run, so the block's bytes
                // are provably the ones already uploaded: the pack, the
                // compare and the visitor are skipped with the pass.
                return;
            }
            const upstream::ShadowReceiverBlock block = upstream::shadow_receiver_block(generator);
            notify_receivers(block);
            const bool moved =
                !handle_at(refresh.uploaded, handle) || block != handle_at(refresh.blocks, handle);
            handle_at(refresh.blocks, handle) = block;
            handle_at(refresh.uploaded, handle) = true;
            visit(generator, handle, slot, block, moved);
        });
}
#endif

} // namespace bbl::pal

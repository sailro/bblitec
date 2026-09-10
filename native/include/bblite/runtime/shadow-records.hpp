#pragma once
// Included within namespace bbl by runtime.hpp.

enum class ShadowFilter {
    pcf_spot,
    /**
     * `createPcfDirectionalShadowGenerator`: the spot generator's own GPU
     * state over the ESM's caster-fitted orthographic volume, which is
     * exactly how the pin assembles it -- `renderPcfShadowMap` with
     * `computeDirectionalLightMatrix` as its matrix builder.
     */
    pcf_directional,
    /**
     * `createCsmDirectionalShadowGenerator`, whose own `_shadowType: "csm"`
     * is what sends both receiver families down their cascaded arm. Its map
     * is a layered `depth32float` array rather than the 2D one the two PCF
     * families share, and its receiver block is the 320-byte cascade one.
     */
    csm_directional,
    esm_directional,
};

/**
 * One fitted cascade, as `_computeCsmCascades` returns it.
 *
 * The receiver samples with `transform` and the cascade's own caster pass
 * renders through `caster_view_projection` — the PCF family's unbiased /
 * biased split, applied per cascade.
 */
#if defined(BBLITE_SHADOWS_CSM) && BBLITE_SHADOWS_CSM
struct ShadowCascade {
    /** The cascade's light-space view, from the pinned light basis. */
    std::array<float, 16> view{};
    /** `cascadeTransforms[i]`: ortho * view, texel-snapped, unbiased. */
    std::array<float, 16> transform{};
    /** That transform with the pin's clip-space bias. */
    std::array<float, 16> caster_view_projection{};
    /** `viewFrustumZ[i]`: the split distance in camera view space. */
    double view_frustum_z = 0.0;
    /** `frustumLengths[i]`: this slice's own length. */
    double frustum_length = 0.0;
};
#endif

/**
 * One `ShadowGenerator`, as the three pinned factories build it.
 *
 * The pin keeps the GPU objects on the generator (a `depth32float` map, a
 * comparison sampler, the params UBO and the receiver UBO); those are the
 * PAL's, so the record carries only the values that decide them plus the
 * two matrices the refresh rebuilds — the unbiased one the receiver samples
 * with, and the biased one the caster pass renders through.
 */
struct ShadowGeneratorRecord {
    ShadowFilter filter = ShadowFilter::pcf_spot;
    std::uint32_t map_size = 512;
    double bias = 0.0;
    double darkness = 0.0;
    double near_plane = 1.0;
    double far_plane = 10000.0;
    /** `sg._lightMatrix` — unbiased, what the receiver samples with. */
    std::array<float, 16> light_matrix{};
    /** The shadow camera's view, from the pinned light-space basis. */
    std::array<float, 16> caster_view{};
    /** That camera's view-projection, with the pinned clip-space bias. */
    std::array<float, 16> caster_view_projection{};
    /** The `ShadowTask` inputs `setShadowTaskCasterMeshes` registered. */
    std::vector<MeshHandle> caster_meshes;
    /**
     * Bumped by every `set_shadow_task_caster_meshes`. The pin rebuilds a
     * generator's task state when the caster ARRAY it is handed is a new
     * one (`existing._casterMeshes === casterMeshes` in the ensure hooks),
     * and a fresh state's `_last*Version` sentinels force the next render;
     * this counter is that identity change, read by the render gate.
     */
    std::uint64_t caster_list_version = 0;
    // enableMorphTargetShadows: bound each caster by its morph-expanded
    // AABB rather than its unmorphed geometry box. Off unless the scene
    // asks, exactly as upstream installs no provider unless it is called.
    bool morph_shadow_bounds = false;
    /**
     * `sg._config._forceRefreshEveryFrame`: when set, the pinned render
     * gate never skips (`renderEsmShadowMap` / `renderPcfShadowMap` /
     * `renderCsmShadowMap` each test it first).
     */
    bool force_refresh_every_frame = false;
    /**
     * The render target this generator's map lives in, which is what every
     * receiver lookup resolves through. A cascaded generator's cascades are
     * layers of this one target.
     */
    RenderTargetHandle map_target{};
    /**
     * Every caster pass the task state built: one for a single-map
     * generator, one per cascade layer for a cascaded one.
     */
    std::vector<TaskHandle> caster_tasks;
    /** Source/view pairs retained while a dynamic caster list is filtered. */
    std::vector<MaterialHandle> caster_material_sources;
    std::vector<MaterialHandle> caster_material_views;
    /** ESM only: one of the two lanes its receiver block packs. */
    double depth_scale = 0.0;
    /** ESM and CSM: the soft fade at the edge of the fitted volume. */
    double frustum_edge_falloff = 0.0;
    /** ESM only: the ortho volume the caster fit projects into. */
    double ortho_min_z = 1.0;
    double ortho_max_z = 10000.0;
    /**
     * CSM only: the cascade configuration, and the fit it produces.
     *
     * `csm_cascades` is refilled by `update_csm_cascades` on every frame
     * the pinned render gate finds due, and is what both the caster passes
     * and the receiver's 320-byte block are read from. An unset
     * `csm_shadow_max_z` is the pin's own `?? null`, resolved against the
     * active camera's far plane where the split is computed.
     */
#if defined(BBLITE_SHADOWS_CSM) && BBLITE_SHADOWS_CSM
    std::uint32_t csm_num_cascades = 4;
    double csm_lambda = 0.5;
    double csm_cascade_blend_percentage = 0.1;
    std::optional<double> csm_shadow_max_z{};
    std::vector<ShadowCascade> csm_cascades;
    /** Subscribers to the exact packed CSM receiver block for this frame. */
    std::shared_ptr<
        PlatformEventListeners<void(const js::F32Array&)>>
        csm_receiver_callbacks;
#endif
    /**
     * ESM only: this generator's ordinal among the ESM ones, which is the
     * row generation emitted its recorded resources under.
     */
    std::uint32_t esm_index = 0;
};

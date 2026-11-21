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

/** The options `sg._csmCache` keeps (`enableCsmStaticCache`). */
struct CsmStaticCacheOptions {
    double refit_angle = 0.0;
    double refit_max_interval_ms = 0.0;
    std::uint32_t static_cascades_per_frame = 0;
    double cascade_coverage_padding = 0.0;
};

/**
 * `createCoverageState`: the camera-coverage refit a cache with a
 * `cascadeCoveragePadding` runs. A camera pose change does not refit:
 * each cascade keeps its published map until the camera's slice leaves it.
 */
struct CsmCoverageState {
    /** `1 + padding`: what the stabilized fit's radius is scaled by. */
    double radius_scale = 1.0;
    /** The camera projection revision the published splits were fit for. */
    double projection_revision = -1.0;
    /** The camera pose the coverage test last ran for. */
    double pose_version = -1.0;
    /** The camera and pose of the pending fit. */
    const CameraRecord* fit_camera = nullptr;
    double fit_pose = -1.0;
    /** The camera change the receivers were last notified of. */
    double notified_camera_version = -1.0;
};

/**
 * `enableCsmStaticCache`: the options `sg._csmCache` keeps, and the cached
 * task state's CPU side (`ensureCsmShadowCacheState`): the refit gate and
 * static refit scheduler lowered from the pin (`csm_static_cache.hpp`), the
 * cascades fitted at the last refit and this frame's plan. The cache
 * texture is a render target; the static caster passes ride the
 * generator's `caster_tasks` ahead of the dynamic ones.
 */
struct CsmStaticCacheState {
    CsmStaticCacheOptions options;
    RenderTargetHandle cache_target{};
    /** `_gate` and `_staticScheduler`: the generated `CsmRefitRuntime`. */
    std::shared_ptr<void> refit;
    /** `_coverage`: set for a cache keeping a coverage padding. */
    std::optional<CsmCoverageState> coverage;
    // renderCsmShadowMapCached
    double last_camera_version = -1.0;
    const CameraRecord* last_camera = nullptr;
    double last_camera_aspect = -1.0;
    double cached_content_version = -1.0;
    /** `_pendingCascades`: the last refit's fit, published cascade by cascade. */
    std::vector<ShadowCascade> pending;
    /** Membership moved: the static and dynamic caster passes are refilled. */
    bool membership_dirty = true;
    /** This frame refilled them, after the frame's draw lists were built. */
    bool refilled = false;
    // This frame's plan, read by both backends' task loops.
    std::vector<bool> static_due;
    std::vector<bool> dynamic_due;
    std::vector<std::uint32_t> copy_layers;
};

struct ShadowMaterialSnapshot {
    MaterialHandle view;
    std::uint64_t generation{};
    std::uint32_t features{};
    bool active{};
};

/** The inputs of a retained no-color caster packet. */
struct ShadowCasterSnapshot {
    MaterialHandle material;
    MaterialHandle view;
    std::uint64_t renderable_generation{};
    std::uint64_t view_generation{};
    bool operator==(const ShadowCasterSnapshot&) const = default;
};

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
    /** Installed by the source runtime enable wrapper; absence uses the original hook. */
    std::optional<bool> runtime_enabled;
    std::uint64_t runtime_enabled_version = 0;
    ShadowFilter filter = ShadowFilter::pcf_spot;
    // The configuration scalars here and below start at zero: each factory
    // writes every one its filter reads from its options, which generation
    // fills from the pin's own `??` chain. A directional generator's near
    // and far come back out of its caster fit instead.
    std::uint32_t map_size = 0;
    double bias = 0.0;
    double darkness = 0.0;
    double near_plane = 0.0;
    double far_plane = 0.0;
    /** `sg._lightMatrix` — unbiased, what the receiver samples with. */
    std::array<float, 16> light_matrix{};
    /** The shadow camera's view, from the pinned light-space basis. */
    std::array<float, 16> caster_view{};
    /** That camera's view-projection, with the pinned clip-space bias. */
    std::array<float, 16> caster_view_projection{};
    /** The `ShadowTask` inputs `setShadowTaskCasterMeshes` registered. */
    std::vector<MeshHandle> caster_meshes;
    /**
     * The fit reads every caster the array names, a removed one included,
     * so the array names each (`name_mesh`) and none gives up its slot.
     */
    std::vector<MeshName> caster_names;
    /** Caster-array identity for the cache refit gate and initial task registration. */
    std::uint64_t caster_list_version = 0;
    // enableMorphTargetShadows: bound each caster by its morph-expanded
    // AABB rather than its unmorphed geometry box. Off unless the scene
    // asks, exactly as upstream installs no provider unless it is called.
    bool morph_shadow_bounds = false;
    // enableSkeletonShadows: bound each skinned caster by its bones' live
    // boxes rather than its bind-pose geometry box.
    bool skeleton_shadow_bounds = false;
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
    std::unordered_map<std::uint32_t, ShadowMaterialSnapshot> caster_material_views;
    std::unordered_map<std::uint32_t, ShadowCasterSnapshot> caster_snapshots;
    std::uint64_t caster_packet_version = 0;
    /** ESM only: one of the two lanes its receiver block packs. */
    double depth_scale = 0.0;
    /** ESM and CSM: the soft fade at the edge of the fitted volume. */
    double frustum_edge_falloff = 0.0;
    /** ESM only: the ortho volume the caster fit projects into. */
    double ortho_min_z = 0.0;
    double ortho_max_z = 0.0;
    /**
     * CSM only: the cascade configuration, and the fit it produces.
     *
     * `csm_cascades` is refilled by `update_csm_cascades` on every frame
     * the pinned render gate finds due, and is what both the caster passes
     * and the receiver's 320-byte block are read from. An unset
     * `csm_shadow_max_z` is the pin's own `?? null`, resolved against the
     * active camera's far plane where the split is computed.
     */
    std::uint32_t csm_num_cascades = 0;
    double csm_lambda = 0.0;
    double csm_cascade_blend_percentage = 0.0;
    bool csm_stabilize_cascades = false;
    std::optional<double> csm_shadow_max_z{};
    /** `cfg._worldSpaceBias`: unset is the pin's `null`, where `bias` applies. */
    std::optional<double> csm_world_space_bias{};
    std::vector<ShadowCascade> csm_cascades;
    /** Subscribers to the exact packed CSM receiver block for this frame. */
    std::shared_ptr<PlatformEventListeners<void(const js::F32Array&)>> csm_receiver_callbacks;
    /** `sg._csmCache`, set by `enableCsmStaticCache`. */
    std::shared_ptr<CsmStaticCacheState> csm_cache;
    /** `sg._csmReceiverTexture`: `getCsmReceiverTexture` ran for this generator. */
    bool csm_receiver_texture_read = false;
    /**
     * ESM only: this generator's ordinal among the ESM ones, which is the
     * row generation emitted its recorded resources under.
     */
    std::uint32_t esm_index = 0;
};

// Pipeline facts both backends translate: the blend tuples, the pipeline
// kind traits, the plan checks, the skybox stage order, the background
// arms, the cluster numbering and the diagnostic blocks.
#pragma once
#include <bblite/features/has_pbr_renderer.hpp>
#include "pal_gpu_targets.hpp"

namespace bbl::pal {

/**
 * The three blend-factor tuples the corpus reaches, stated once. A
 * transparent draw blends colour src-alpha over one-minus-src-alpha and
 * accumulates alpha at one; the pinned background ground rides one over
 * one-minus-src-alpha on both lanes. The operation is always add. Every
 * blending pipeline in either backend translates one of these instances
 * to its API's enums; `BlendFactors` itself lives in the runtime records,
 * because generated code names it too.
 */
inline constexpr BlendFactors transparent_blend{
    BlendFactor::src_alpha,
    BlendFactor::one_minus_src_alpha,
    BlendFactor::one,
    BlendFactor::one_minus_src_alpha,
};

// ShaderMaterial blendMode "additive": color src-alpha + destination,
// alpha source + destination, exactly as the pin's shader pipeline states it.
inline constexpr BlendFactors shader_additive_blend{
    BlendFactor::src_alpha,
    BlendFactor::one,
    BlendFactor::one,
    BlendFactor::one,
};

inline constexpr BlendFactors ground_blend{
    BlendFactor::one,
    BlendFactor::one_minus_src_alpha,
    BlendFactor::one,
    BlendFactor::one_minus_src_alpha,
};

/**
 * The one alpha-to-coverage rule: coverage needs samples to spread
 * across, and WebGPU rejects a 1-sample a2c pipeline outright where
 * D3D12 quantizes coverage to a ~0.5 cutoff instead. Every pipeline in
 * either backend that wants a2c enables it through this, so a
 * single-sample run draws the same pixels on both.
 */
inline bool alpha_to_coverage_enabled(bool wants_a2c, std::uint32_t samples) {
    return wants_a2c && samples > 1;
}

#if BBLITE_HAS_PBR_RENDERER
/**
 * The fixed-function facts one `RenderPipelineKind` carries, decoded once
 * for both backends: the material family, whether the draw blends, the
 * cull mode and the front face. The plan's own enums carry the answers,
 * so a backend keeps only its API-enum translation — the same split the
 * depth compare already uses. A new enumerator must be given an arm here
 * rather than inheriting one.
 */
struct RenderPipelineKindTraits {
    upstream::RenderMaterialKind family{};
    bool transparent{};
    upstream::RenderCullMode cull{};
    bool clockwise_front_face{};
    // The primitive the pipeline is built at. Only the glTF PBR kinds carry
    // anything but triangles, and each of those already fixes its cull mode
    // to none, exactly as `buildPrimitiveState` does -- so every other arm
    // takes this default rather than restating it.
    MeshTopology topology = MeshTopology::triangles;
};

/** Whether the kind asks for alpha-to-coverage (the `shader_a2c` arm). */
inline bool pipeline_kind_wants_a2c(upstream::RenderPipelineKind kind) {
    return kind == upstream::RenderPipelineKind::shader_a2c;
}

RenderPipelineKindTraits pipeline_kind_traits(upstream::RenderPipelineKind kind);

/**
 * Every plan item's kind and variant, checked against the generated
 * tables before anything is uploaded or drawn from it. Both backends run
 * this at every plan (re)build, so a plan the build cannot draw fails at
 * rebuild time on both rather than at (or past) one backend's draw.
 */
void validate_render_plan_items(const upstream::RenderPlan& plan);

/**
 * A material family appearing after registration must have composed
 * artifacts to draw with: generation composes variants from the whole
 * scene, so a family the tables never saw is a compiler contract broken,
 * not a scene mistake. This is the table half of the guard, shared by
 * both backends; a backend whose modules are built eagerly at startup
 * (SDL_GPU) keeps its own built-pipeline residue beside it.
 */
void reject_uncomposed_family_growth(std::uint32_t added_families);

#endif

/**
 * The format classes of a geometry-output task's colour targets, in the
 * task's own attachment order, plus whether a trailing target in the
 * frame's colour format follows. Both backends assemble their MRT
 * pipeline targets from this one list; only the API structs stay per
 * backend.
 */
struct GeometryTargetClasses {
    std::vector<TextureFormatClass> attachments;
    bool trailing_output = false;
};

GeometryTargetClasses geometry_target_classes(const FrameTaskRecord& task);

/**
 * The count assertion beside the list: a variant composed for N targets
 * over a task carrying M is the same generation bug on either backend,
 * so the refusal is stated once. `family` names the variant family the
 * caller resolves ("pinned", "standard" or "node").
 */
void require_geometry_target_count(const GeometryTargetClasses& classes,
                                   std::size_t entry_color_target_count, const char* family);

/**
 * The colour formats a geometry task's pipeline renders into, in
 * attachment order: one per composed class and, when the task keeps
 * `emitColor`'s output, the frame's colour format last. `format` maps a
 * class onto the backend's own format enum and `trailing` is that
 * backend's frame colour format, so both backends build their MRT target
 * descriptions from this one list.
 */
template <typename Format, typename FormatOf>
inline std::vector<Format>
geometry_color_target_formats(const FrameTaskRecord& task, std::size_t entry_color_target_count,
                              const char* family, FormatOf&& format, Format trailing) {
    const GeometryTargetClasses classes = geometry_target_classes(task);
    require_geometry_target_count(classes, entry_color_target_count, family);
    std::vector<Format> formats;
    formats.reserve(classes.attachments.size() + 1u);
    for (const TextureFormatClass format_class : classes.attachments) {
        formats.push_back(format(format_class));
    }
    if (classes.trailing_output)
        formats.push_back(trailing);
    return formats;
}

/**
 * The skybox stage in sub-draw order: load-env.ts pushes the solid cube
 * before the DDS and .env arms, every background renderable carries
 * order 0, and the image-skybox cube draws after the environment arm.
 * Both backends walk this one array, so the stage cannot reorder on one
 * of them.
 */
enum class SkyboxLayer {
    solid,
    environment,
    image,
};

inline constexpr std::array<SkyboxLayer, 3> skybox_stage_order{
    SkyboxLayer::solid,
    SkyboxLayer::environment,
    SkyboxLayer::image,
};

#if BBLITE_PINNED_BACKGROUNDS
/**
 * The background arms a run draws, by the stage slot each one fills.
 *
 * The entry points push one renderable per arm, and the pin keys each
 * arm's pipeline on its own flags: the ground and the DDS skybox compose
 * WGSL_DITHER or WGSL_NO_DITHER on `enableNoise`, and the environment
 * skybox is the .env arm when it samples the environment's own cube.
 * Stated once, so both backends build and draw the same arms.
 */
struct PinnedBackgroundDraws {
    std::optional<upstream::PinnedBackgroundArmKind> solid;
    std::optional<upstream::PinnedBackgroundArmKind> environment;
    std::optional<upstream::PinnedBackgroundArmKind> image;
    std::optional<upstream::PinnedBackgroundArmKind> ground;

    [[nodiscard]] std::optional<upstream::PinnedBackgroundArmKind> skybox(SkyboxLayer layer) const {
        switch (layer) {
        case SkyboxLayer::solid:
            return solid;
        case SkyboxLayer::environment:
            return environment;
        case SkyboxLayer::image:
            return image;
        }
        return std::nullopt;
    }

    template <typename Visit> void for_each(Visit visit) const {
        for (const std::optional<upstream::PinnedBackgroundArmKind>& kind :
             {solid, environment, image, ground}) {
            if (kind)
                visit(*kind);
        }
    }
};

PinnedBackgroundDraws select_pinned_backgrounds(const FrameOptions& options,
                                                const EnvironmentState& environment);
#endif

/**
 * Cluster ids advance in fixed 128-triangle groups, and the id and
 * cluster buffers are compared against the browser's, so both backends
 * have to number them identically.
 */
struct ClusterRange {
    std::uint32_t triangle_count;
    std::uint32_t id_start;
};

ClusterRange advance_cluster_range(std::uint32_t index_count, std::uint32_t& cluster_id_base);

#if BBLITE_HAS_PBR_RENDERER
/**
 * The alpha state the diagnostic shaders read: the bucket as a mode, the
 * cutoff, and the material alpha. A material-less item renders opaque at
 * full alpha.
 */
std::array<float, 4> diagnostic_alpha_options(const upstream::RenderItem& item,
                                              const MaterialRecord* material);

/**
 * The id and cluster diagnostic uniform blocks. The draw-id RGB packing
 * (one little-endian byte per channel over 255) and the
 * {cluster base, 128 triangles per cluster} pair are diffed against the
 * browser's buffers, so both backends fill the blocks here.
 */
struct DiagnosticIdUniforms {
    float id_color[4];
    float alpha_options[4];
};

struct DiagnosticClusterUniforms {
    std::uint32_t cluster_options[4];
    float alpha_options[4];
};

DiagnosticIdUniforms diagnostic_id_uniforms(std::uint32_t draw_id,
                                            const std::array<float, 4>& alpha_options);

DiagnosticClusterUniforms diagnostic_cluster_uniforms(std::uint32_t cluster_base,
                                                      const std::array<float, 4>& alpha_options);
#endif

} // namespace bbl::pal

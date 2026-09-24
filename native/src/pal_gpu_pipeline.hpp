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

inline RenderPipelineKindTraits pipeline_kind_traits(upstream::RenderPipelineKind kind) {
    using Kind = upstream::RenderPipelineKind;
    using Family = upstream::RenderMaterialKind;
    using Cull = upstream::RenderCullMode;
    using Topology = MeshTopology;
    switch (kind) {
    case Kind::pbr_opaque_back:
        return {Family::pbr, false, Cull::back, false};
    case Kind::pbr_opaque_back_clockwise:
        return {Family::pbr, false, Cull::back, true};
    case Kind::pbr_opaque_none:
        return {Family::pbr, false, Cull::none, false};
    case Kind::pbr_opaque_none_clockwise:
        return {Family::pbr, false, Cull::none, true};
    case Kind::pbr_transparent_back:
        return {Family::pbr, true, Cull::back, false};
    case Kind::pbr_transparent_back_clockwise:
        return {Family::pbr, true, Cull::back, true};
    case Kind::pbr_transparent_none:
        return {Family::pbr, true, Cull::none, false};
    case Kind::pbr_transparent_none_clockwise:
        return {Family::pbr, true, Cull::none, true};
    // Points and lines cull nothing and have no winding, so each is one
    // arm per blend state.
    case Kind::pbr_opaque_points:
        return {Family::pbr, false, Cull::none, false, Topology::points};
    case Kind::pbr_opaque_lines:
        return {Family::pbr, false, Cull::none, false, Topology::lines};
    case Kind::pbr_opaque_line_strip:
        return {Family::pbr, false, Cull::none, false, Topology::line_strip};
    case Kind::pbr_transparent_points:
        return {Family::pbr, true, Cull::none, false, Topology::points};
    case Kind::pbr_transparent_lines:
        return {Family::pbr, true, Cull::none, false, Topology::lines};
    case Kind::pbr_transparent_line_strip:
        return {Family::pbr, true, Cull::none, false, Topology::line_strip};
    case Kind::standard_opaque_back:
        return {Family::standard, false, Cull::back, false};
    case Kind::standard_opaque_none:
        return {Family::standard, false, Cull::none, false};
    case Kind::standard_transparent_back:
        return {Family::standard, true, Cull::back, false};
    case Kind::standard_transparent_none:
        return {Family::standard, true, Cull::none, false};
    // The mirrored-mesh opt-in's own arms: same family, same blend and
    // cull, clockwise front face.
    case Kind::standard_opaque_back_clockwise:
        return {Family::standard, false, Cull::back, true};
    case Kind::standard_opaque_none_clockwise:
        return {Family::standard, false, Cull::none, true};
    case Kind::standard_transparent_back_clockwise:
        return {Family::standard, true, Cull::back, true};
    case Kind::standard_transparent_none_clockwise:
        return {Family::standard, true, Cull::none, true};
    // A shader kind's concrete fixed-function state comes from the
    // emitted variant table (cull, blend, depth write, topology); the
    // kind itself carries only the family and the a2c request.
    case Kind::shader:
    case Kind::shader_a2c:
        return {Family::shader, false, Cull::back, false};
    case Kind::node_opaque_back:
        return {Family::node, false, Cull::back, false};
    case Kind::node_opaque_none:
        return {Family::node, false, Cull::none, false};
    case Kind::node_transparent_back:
        return {Family::node, true, Cull::back, false};
    case Kind::node_transparent_none:
        return {Family::node, true, Cull::none, false};
    }
    throw std::runtime_error("render pipeline kind " + std::to_string(static_cast<int>(kind)) +
                             " is not implemented yet.");
}

/**
 * Every plan item's kind and variant, checked against the generated
 * tables before anything is uploaded or drawn from it. Both backends run
 * this at every plan (re)build, so a plan the build cannot draw fails at
 * rebuild time on both rather than at (or past) one backend's draw.
 */
inline void validate_render_plan_items(const upstream::RenderPlan& plan) {
    for (const upstream::RenderItem& item : plan.items) {
        if (item.material_kind == upstream::RenderMaterialKind::shader) {
            if (item.shader_variant >= upstream::shader_variant_count()) {
                throw std::runtime_error("this shader material variant is not implemented "
                                         "yet.");
            }
        } else if (item.material_kind == upstream::RenderMaterialKind::node) {
#if BBLITE_NODE_VARIANTS > 0
            if (item.shader_variant >= node_graph_count()) {
                throw std::runtime_error("this node material graph was not composed.");
            }
#else
            throw std::runtime_error("a node material in a build with no composed graphs.");
#endif
        }
    }
}

/**
 * A material family appearing after registration must have composed
 * artifacts to draw with: generation composes variants from the whole
 * scene, so a family the tables never saw is a compiler contract broken,
 * not a scene mistake. This is the table half of the guard, shared by
 * both backends; a backend whose modules are built eagerly at startup
 * (SDL_GPU) keeps its own built-pipeline residue beside it.
 */
inline void reject_uncomposed_family_growth(std::uint32_t added_families) {
#if BBLITE_STANDARD_VARIANTS > 0
    if ((added_families & material_family_standard) != 0 && upstream::standard_variants.empty()) {
        throw std::runtime_error("Post-registration Standard material family has no composed "
                                 "variants.");
    }
#else
    if ((added_families & material_family_standard) != 0) {
        throw std::runtime_error("Post-registration Standard material family in a build with "
                                 "no composed variants.");
    }
#endif
    if ((added_families & material_family_shader) != 0 && upstream::shader_variant_count() == 0) {
        throw std::runtime_error("Post-registration shader material family has no composed "
                                 "variants.");
    }
}

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

inline GeometryTargetClasses geometry_target_classes(const FrameTaskRecord& task) {
    GeometryTargetClasses classes;
    classes.attachments.reserve(task.geometry.attachments.size());
    for (const GeometryTextureDescription& description : task.geometry.attachments) {
        classes.attachments.push_back(geometry_format_class(description));
    }
    classes.trailing_output = task.geometry.target.value != invalid_handle;
    return classes;
}

/**
 * The count assertion beside the list: a variant composed for N targets
 * over a task carrying M is the same generation bug on either backend,
 * so the refusal is stated once. `family` names the variant family the
 * caller resolves ("pinned", "standard" or "node").
 */
inline void require_geometry_target_count(const GeometryTargetClasses& classes,
                                          std::size_t entry_color_target_count,
                                          const char* family) {
    const std::size_t total = classes.attachments.size() + (classes.trailing_output ? 1u : 0u);
    if (total == entry_color_target_count)
        return;
    throw std::runtime_error(std::string(family) + " geometry variant writes " +
                             std::to_string(entry_color_target_count) +
                             " targets where its task carries " + std::to_string(total) + ".");
}

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

inline PinnedBackgroundDraws select_pinned_backgrounds(const FrameOptions& options,
                                                       const EnvironmentState& environment) {
    using Kind = upstream::PinnedBackgroundArmKind;
    PinnedBackgroundDraws draws;
    const bool background = options.background_enabled(environment);
    if (background && environment.has_solid_skybox)
        draws.solid = Kind::solid_skybox;
    if (options.skybox_enabled(environment)) {
        draws.environment = environment.skybox_uses_environment ? Kind::hdr_skybox
                            : environment.enable_noise          ? Kind::dds_skybox
                                                                : Kind::dds_skybox_no_dither;
    }
    if (background && environment.has_image_skybox)
        draws.image = Kind::image_skybox;
    if (options.ground_enabled(environment))
        draws.ground = environment.enable_noise ? Kind::ground_dither : Kind::ground;
    return draws;
}
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

inline ClusterRange advance_cluster_range(std::uint32_t index_count,
                                          std::uint32_t& cluster_id_base) {
    const std::uint32_t triangle_count = index_count / 3;
    const std::uint32_t id_start = cluster_id_base;
    cluster_id_base += (triangle_count + 127u) / 128u;
    return ClusterRange{triangle_count, id_start};
}

#if BBLITE_HAS_PBR_RENDERER
/**
 * The alpha state the diagnostic shaders read: the bucket as a mode, the
 * cutoff, and the material alpha. A material-less item renders opaque at
 * full alpha.
 */
inline std::array<float, 4> diagnostic_alpha_options(const upstream::RenderItem& item,
                                                     const MaterialRecord* material) {
    std::array<float, 4> options{};
    if (!material) {
        options[2] = 1.0f;
        return options;
    }
    options[0] = item.bucket == upstream::RenderBucket::alpha_blend  ? 2.0f
                 : item.bucket == upstream::RenderBucket::alpha_mask ? 1.0f
                                                                     : 0.0f;
    options[1] = material->alpha_cutoff;
    options[2] = material->alpha;
    return options;
}

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

inline DiagnosticIdUniforms diagnostic_id_uniforms(std::uint32_t draw_id,
                                                   const std::array<float, 4>& alpha_options) {
    DiagnosticIdUniforms uniforms{};
    uniforms.id_color[0] = static_cast<float>(draw_id & 0xffu) / 255.0f;
    uniforms.id_color[1] = static_cast<float>((draw_id >> 8) & 0xffu) / 255.0f;
    uniforms.id_color[2] = static_cast<float>((draw_id >> 16) & 0xffu) / 255.0f;
    uniforms.id_color[3] = 1.0f;
    std::copy_n(alpha_options.begin(), 4, uniforms.alpha_options);
    return uniforms;
}

inline DiagnosticClusterUniforms
diagnostic_cluster_uniforms(std::uint32_t cluster_base, const std::array<float, 4>& alpha_options) {
    DiagnosticClusterUniforms uniforms{};
    uniforms.cluster_options[0] = cluster_base;
    uniforms.cluster_options[1] = 128;
    std::copy_n(alpha_options.begin(), 4, uniforms.alpha_options);
    return uniforms;
}
#endif

} // namespace bbl::pal

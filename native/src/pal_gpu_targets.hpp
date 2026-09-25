// Render targets and the frame-graph passes' shared rules: depth
// borrowing, the effect wrapper's bindings, the transmission grab, scaled
// and planned target extents, post-process extents and geometry outputs.
#pragma once
#include <bblite/features/has_post_process.hpp>
#include <bblite/features/has_screen_space.hpp>
#include "pal_gpu_picking.hpp"

namespace bbl::pal {

/**
 * Whether another task binds this geometry task's depth.
 *
 * The pin hands that depth over as an eager wrapper target, so the borrowing
 * pass loads it — which only works if the task that wrote it stored it. The
 * answer belongs to the frame graph, so it is settled once with the task's
 * textures rather than re-scanned per frame.
 */
bool geometry_depth_is_borrowed(const Engine& engine, std::size_t task);

/**
 * Whether a render target hands samplers its depth attachment.
 *
 * `rtt.ts` forks on `if (!rt._colorTexture || !rt._colorView)`: a target
 * that declared a colour format hands that attachment back, and one that
 * did not hands its depth. `has_color` is the compiler's record of the
 * declared format, written once by the lowered `create_render_target_texture`
 * from the descriptor, so the fork reads it rather than inferring the answer
 * from whichever textures a backend happens to have allocated.
 *
 * Both backends ask this, and only the handles they return differ.
 */
inline bool render_target_samples_depth(const RenderTargetRecord& record) {
    return !record.has_color;
}

/** The refusal both backends owe a depth-only target with no depth. */
[[noreturn]] inline void fail_render_target_has_no_texture() {
    throw std::runtime_error("Depth-only render target has no color texture.");
}

/**
 * The refusal both backends owe a frame record naming a handle outside its
 * table: a generation defect, classified as `handle_at` classifies its own
 * refusal. Never a `GpuTransportError`, which would reach the
 * device-recovery listeners as a lost device.
 */
[[noreturn]] inline void refuse_invalid_frame_handle(const char* message) {
    throw std::out_of_range(message);
}

/**
 * The texture `setEffectTexture` stored for one declared binding name.
 *
 * The walk and the refusal are the pin's own `findTextureSlot` contract:
 * a binding the compiled fragment kept must have been set before the
 * first render, and a name the wrapper never stored fails by name rather
 * than binding a neighbour. Both backends resolve through this.
 */

const SolidTexture& effect_texture_for_binding(const EffectWrapperRecord& wrapper,
                                               std::string_view name);

/**
 * The uniform floats a scene set must fill the block the descriptor
 * declared exactly: a short write leaves a stale or zero tail behind the
 * declared size, silently and differently per backend.
 */
void require_effect_uniform_size(const EffectWrapperRecord& wrapper, std::uint32_t uniform_bytes);

using upstream::transmission_grab_size;
using upstream::transmission_sampler_max_anisotropy;

inline std::uint32_t transmission_grab_mip_count() {
    return static_cast<std::uint32_t>(
        upstream::transmission_mip_level_count(transmission_grab_size, transmission_grab_size));
}

/**
 * Whether one draw's material is transmissive — the predicate behind the
 * pinned mid-pass break: `executePassWithTransmission` grabs the scene
 * colour before the FIRST draw this returns true for. The once-per-frame
 * latch and the pass surgery around it stay per backend.
 */
inline bool transmissive_draw_material(const MaterialRecord* material) {
    return material != nullptr &&
           (material->transmission_factor > 0.0f || !material->transmission_texture.bytes.empty());
}

/**
 * The pixels a target scaled from another occupies, by the pin's own rule:
 * `max(1, floor(extent * ratio))`, evaluated against whatever the source
 * resolved to this build.
 */
inline std::uint32_t scaled_target_extent(std::uint32_t source, double ratio) {
    return static_cast<std::uint32_t>(
        std::max(1.0, std::floor(static_cast<double>(source) * ratio)));
}

/** Both extents of a target sized from another, see `scaled_target_extents`. */
struct ScaledExtents {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
};

/**
 * A scaled target's extents under the rounding its record names: the
 * composite rule above, or the screen-space effects' own
 * `computeScreenSpaceScaledSize`, which generation lowers from the pin and
 * which takes one scale for both axes. A record asking for that rule in a
 * build that reached no screen-space effect names a generation defect, so
 * it fails rather than rounding the other way.
 */
ScaledExtents scaled_target_extents(const RenderTargetRecord& record, std::uint32_t source_width,
                                    std::uint32_t source_height);

template <class Format> struct RenderTargetPlan {
    std::uint32_t width, height;
    Format color_format;
};

void synchronize_render_target_lifecycles(const Engine& engine);

/** Resolve source-relative sizes and inherited formats before allocating GPU resources. */
template <class Format, class Convert>
std::vector<RenderTargetPlan<Format>>
plan_render_targets(const Engine& engine, std::uint32_t width, std::uint32_t height,
                    Format surface_format, Convert&& convert) {
    std::vector<RenderTargetPlan<Format>> plans;
    plans.reserve(engine.render_targets.size());
    for (const auto& record : engine.render_targets) {
        if (record.retired) {
            plans.push_back({0, 0, Format{}});
            continue;
        }
        auto [target_width, target_height] = surface_target_extent(engine, record, width, height);
        Format format = surface_format;
        if (record.scale_source.value != invalid_handle) {
            if (record.scale_source.value >= plans.size()) {
                throw std::runtime_error("A render target must scale from an earlier target.");
            }
            const auto& source = plans[record.scale_source.value];
            const auto scaled = scaled_target_extents(record, source.width, source.height);
            target_width = scaled.width;
            target_height = scaled.height;
            format = source.color_format;
        }
        if (record.swapchain)
            format = surface_format;
        else if (record.has_format)
            format = convert(record.format);
        plans.push_back({target_width, target_height, format});
    }
    return plans;
}

#if BBLITE_HAS_SCREEN_SPACE
template <class Clear, class Stage, class PostProcess>
void record_screen_space_decision(const ScreenSpaceFrameDecision& decision, bool composite,
                                  Clear&& clear, Stage&& stage, PostProcess&& post_process) {
    if (decision.clear_identity) {
        clear(false);
        clear(true);
    }
    if (decision.run_effect) {
        stage(true, decision.producer_uniforms.data());
        stage(false, decision.temporal_uniforms.data());
        post_process(0u);
    }
    if (composite)
        post_process(1u);
}

/**
 * What the generated screen-space frame function reads off a backend's
 * targets: the depth source's and the raw target's extents, and the
 * allocation identities its texture-identity tests compare (docs/fidelity.md).
 * Both backends keep those three fields on their target rows under the same
 * names, so one reader serves both.
 */
template <typename RenderTargets>
ScreenSpaceFrameInputs screen_space_frame_inputs(const RenderTargets& targets,
                                                 const ScreenSpaceTaskOptions& task) {
    const auto& depth = targets.at(task.depth.value);
    const auto& source = targets.at(task.source.value);
    const auto& raw = targets.at(task.raw.value);
    const auto& stable = targets.at(task.stable.value);
    const auto& history = targets.at(task.history.value);
    ScreenSpaceFrameInputs inputs;
    inputs.depth_width = depth.width;
    inputs.depth_height = depth.height;
    inputs.effect_width = raw.width;
    inputs.effect_height = raw.height;
    inputs.depth_allocation = depth.allocation;
    inputs.color_allocation = source.allocation;
    inputs.raw_allocation = raw.allocation;
    inputs.stable_allocation = stable.allocation;
    inputs.history_allocation = history.allocation;
    return inputs;
}
#endif

#if BBLITE_HAS_POST_PROCESS
/** One post-process pass's resolved output and source extents. */
struct PostProcessExtent {
    std::uint32_t output_width = 0;
    std::uint32_t output_height = 0;
    std::uint32_t source_width = 0;
    std::uint32_t source_height = 0;
};

/**
 * The extents both backends resolve one post-process pass against: the
 * output target's own size (the frame's, when the pass presents to the
 * swapchain), and the sampled target's when the pass names another render
 * target whose backend row exists -- otherwise the source inherits the
 * output extent. `RenderTargets` is each backend's per-target state
 * vector; only its rows' `width`/`height` are read.
 */
template <typename RenderTargets>
inline PostProcessExtent
resolve_post_process_extent(const RenderTargetRecord& output_record,
                            const RenderTargets& render_targets, const PostProcessPassOptions& pass,
                            std::uint32_t frame_width, std::uint32_t frame_height) {
    PostProcessExtent extent;
    extent.output_width =
        output_record.swapchain ? frame_width : handle_at(render_targets, pass.output_target).width;
    extent.output_height = output_record.swapchain
                               ? frame_height
                               : handle_at(render_targets, pass.output_target).height;
    extent.source_width = extent.output_width;
    extent.source_height = extent.output_height;
    if (pass.source.source == RenderTextureSource::render_target &&
        pass.source.target.value < render_targets.size()) {
        extent.source_width = handle_at(render_targets, pass.source.target).width;
        extent.source_height = handle_at(render_targets, pass.source.target).height;
    }
    return extent;
}
#endif

TextureFormatClass geometry_format_class(const GeometryTextureDescription& description);

/**
 * All four channels of a geometry attachment clear to this value: the
 * pinned NORMALIZED_VIEW_DEPTH lane clears to one (its far plane), every
 * other lane to zero.
 */
inline float geometry_clear_component(GeometryTextureType type) {
    return type == GeometryTextureType::normalized_view_depth ? 1.0f : 0.0f;
}

} // namespace bbl::pal

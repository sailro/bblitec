#pragma once
// The backend-neutral half of a `createSsaoTask` task's frame: the mode the
// live settings select, the extents its owned textures and buffers take from
// the source, the views its passes name at a mip-chain level, and the pass
// walk both backends encode in the pin's own order. The plan is generated (`ssao_plan.hpp`, read off the pin's factory);
// the per-frame decision is generated (`frame_graph_ssao.hpp`, lowered from
// it). SDL_GPU's encoder is pal_sdl_gpu_scene_ssao.cpp, Dawn's
// pal_dawn_scene_ssao.cpp.

#include <bblite/features/has_ssao.hpp>

#if BBLITE_HAS_SSAO
#include <bblite/runtime.hpp>
#include <bblite/upstream/frame_graph_ssao.hpp>
#include <bblite/upstream/renderer_plan.hpp>
#include <bblite/upstream/ssao_plan.hpp>

#include "pal_gpu_shader_passes.hpp"

#include <algorithm>
#include <bit>
#include <cstdint>
#include <optional>
#include <span>
#include <stdexcept>
#include <vector>

namespace bbl::pal {

/** One owned texture's extent and level count for a source extent. */
struct SsaoTextureExtent {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint32_t levels = 1;
};

/**
 * The pin's sizes: `createSsaoGpu` and the temporal owner take their working
 * extent, the half-resolution adapter `Math.ceil(extent / 2)`, the unused
 * normal one texel; an AO chain has `min(5, floor(log2(max(w, h))) + 1)`
 * levels. Composition recorded the factory at two source extents, odd and
 * even, and asserted every texture against exactly these rules.
 */
inline SsaoTextureExtent ssao_texture_extent(const upstream::SsaoTextureInfo& texture,
                                             std::uint32_t source_width,
                                             std::uint32_t source_height) {
    SsaoTextureExtent extent;
    switch (texture.extent) {
    case upstream::SsaoExtent::source:
        extent.width = source_width;
        extent.height = source_height;
        break;
    case upstream::SsaoExtent::half:
        extent.width = (source_width + 1u) / 2u;
        extent.height = (source_height + 1u) / 2u;
        break;
    case upstream::SsaoExtent::unit:
        extent.width = 1u;
        extent.height = 1u;
        break;
    }
    if (texture.chain) {
        const std::uint32_t largest = std::max(extent.width, extent.height);
        extent.levels = std::min<std::uint32_t>(5u, std::bit_width(largest));
    }
    return extent;
}

/** The working extent a mode's owner (`SsaoGpu`) takes: the half one in Half. */
inline SsaoTextureExtent ssao_working_extent(const upstream::SsaoModeInfo& mode,
                                             std::uint32_t source_width,
                                             std::uint32_t source_height) {
    return mode.half ? SsaoTextureExtent{(source_width + 1u) / 2u, (source_height + 1u) / 2u, 1u}
                     : SsaoTextureExtent{source_width, source_height, 1u};
}

/**
 * A storage buffer's bytes over the working extent: fixed, or the pin's
 * motion-mask pyramid (`ssaoMotionMaskCellCount(width, height) * 16`).
 */
inline std::uint32_t ssao_buffer_bytes(const upstream::SsaoBufferInfo& buffer,
                                       const SsaoTextureExtent& working) {
    switch (buffer.size) {
    case upstream::SsaoBufferSize::fixed:
        return buffer.bytes;
    case upstream::SsaoBufferSize::motion_cells:
        return static_cast<std::uint32_t>(upstream::ssao_motion_mask_cell_count(
                   static_cast<double>(working.width), static_cast<double>(working.height))) *
               16u;
    }
    throw std::runtime_error("An SSAO buffer has an unknown size rule.");
}

/** A view resolved at a pass's chain level: what it reads or writes, which levels. */
struct SsaoResolvedView {
    upstream::SsaoTextureSource source = upstream::SsaoTextureSource::owned;
    std::uint32_t texture = 0;
    std::uint32_t base_mip = 0;
    std::uint32_t mip_count = 1;
    /** One level of a texture whose chain has more: a single-level view. */
    bool single_level_of_chain = false;
};

/** `extents` holds every task-level texture's extent, by its plan index. */
inline SsaoResolvedView resolve_ssao_view(const upstream::SsaoModeInfo& mode, std::uint32_t view,
                                          std::uint32_t level,
                                          std::span<const SsaoTextureExtent> extents) {
    const upstream::SsaoViewInfo& info = mode.views[view];
    SsaoResolvedView resolved;
    resolved.source = info.source;
    resolved.texture = info.texture;
    const std::int32_t base =
        info.base_mip + (info.relative ? static_cast<std::int32_t>(level) : 0);
    if (base < 0)
        throw std::runtime_error("An SSAO view names a level below its chain.");
    resolved.base_mip = static_cast<std::uint32_t>(base);
    const std::uint32_t levels =
        info.source == upstream::SsaoTextureSource::owned ? extents[info.texture].levels : 1u;
    if (resolved.base_mip >= levels)
        throw std::runtime_error("An SSAO view names a level past its chain.");
    resolved.mip_count = info.mip_count == 0u ? levels - resolved.base_mip : info.mip_count;
    resolved.single_level_of_chain = resolved.mip_count == 1u && levels > 1u;
    return resolved;
}

/** The mip extent of an owned texture's level. */
inline SsaoTextureExtent ssao_level_extent(const SsaoTextureExtent& extent, std::uint32_t level) {
    return {std::max(1u, extent.width >> level), std::max(1u, extent.height >> level), 1u};
}

/**
 * Every pass instance of a frame in the pin's order: a pass repeated over a
 * chain runs once per level 1..levels-1 of that texture, which is how the
 * pin's reduction loops walk `reductions` and `convolution.mipLevelCount`.
 */
template <class Visit>
void for_each_ssao_pass(std::span<const upstream::SsaoPassInfo> passes,
                        std::span<const SsaoTextureExtent> extents, Visit&& visit) {
    for (const upstream::SsaoPassInfo& pass : passes) {
        if (pass.repeat_texture < 0) {
            visit(pass, 0u);
            continue;
        }
        const std::uint32_t levels = extents[static_cast<std::size_t>(pass.repeat_texture)].levels;
        for (std::uint32_t level = 1u; level < levels; ++level)
            visit(pass, level);
    }
}

/**
 * One pass instance of a frame and where it falls among the pin's passes,
 * which GPU task timing counts: a dispatch encoded in the compute pass of
 * the one before it continues that pass, and a buffer clear is no pass.
 */
struct SsaoPassInstance {
    const upstream::SsaoPassInfo* pass = nullptr;
    std::uint32_t level = 0;
    /** It begins one of the pin's passes. */
    bool opens = false;
    /** It ends one. */
    bool closes = false;
};

inline std::vector<SsaoPassInstance>
ssao_pass_instances(std::span<const upstream::SsaoPassInfo> passes,
                    std::span<const SsaoTextureExtent> extents) {
    std::vector<SsaoPassInstance> instances;
    std::vector<bool> continued;
    for_each_ssao_pass(
        passes, extents, [&](const upstream::SsaoPassInfo& pass, std::uint32_t level) {
            const bool dispatch = pass.stage == upstream::SsaoPassStage::compute;
            const bool after_dispatch = !instances.empty() && instances.back().pass->stage ==
                                                                  upstream::SsaoPassStage::compute;
            const bool same_pass = pass.repeat_texture >= 0 && level > 1u ? true : pass.continues;
            continued.push_back(dispatch && after_dispatch && same_pass);
            instances.push_back({&pass, level, false, false});
        });
    for (std::size_t index = 0; index < instances.size(); ++index) {
        SsaoPassInstance& instance = instances[index];
        if (instance.pass->stage == upstream::SsaoPassStage::clear_buffer)
            continue;
        instance.opens = !continued[index];
        instance.closes = index + 1u == instances.size() || !continued[index + 1u];
    }
    return instances;
}

/** The pass list a decision encodes. */
inline std::span<const upstream::SsaoPassInfo>
ssao_decision_passes(const upstream::SsaoModeInfo& mode, const SsaoFrameDecision& decision) {
    if (decision.clear_output)
        return mode.disabled;
    if (!decision.run)
        return {};
    return mode.frames.at(decision.history_index);
}

/** A decision block's floats, by the uniform buffer the pin writes it to. */
inline std::span<const float> ssao_uniform_block(const SsaoFrameDecision& decision,
                                                 upstream::SsaoUniformBlock block) {
    switch (block) {
    case upstream::SsaoUniformBlock::params:
        return decision.params;
    case upstream::SsaoUniformBlock::full_params:
        return decision.full_params;
    case upstream::SsaoUniformBlock::temporal:
        return decision.temporal;
    }
    throw std::runtime_error("An SSAO pass binds an unknown uniform block.");
}

/**
 * The mode a frame encodes: the one composed for the adapter's resolution
 * and the live settings the pin's passes read (`plan_ssao_frame`). A quality
 * no mode composes is one the frame function refuses with the pin's own
 * message, so it selects any mode of the other settings.
 */
inline std::uint32_t ssao_mode_index(const upstream::SsaoPlanInfo& plan,
                                     const SsaoTaskOptions& task, bool half) {
    const bool normal = task.normal.has_value();
    const bool temporal = task.temporal.enabled;
    // `_prepareGpu` installs the transport extension only while both are enabled.
    const bool pruning = task.pruning && task.pruning->enabled && temporal;
    std::optional<std::uint32_t> other_quality;
    for (std::uint32_t index = 0; index < plan.modes.size(); ++index) {
        const upstream::SsaoModeInfo& mode = plan.modes[index];
        if (mode.half != half || mode.key.normal != normal || mode.key.temporal != temporal ||
            mode.key.pruning != pruning)
            continue;
        if (mode.key.quality == task.quality)
            return index;
        if (!other_quality)
            other_quality = index;
    }
    if (other_quality)
        return *other_quality;
    throw std::runtime_error("The SSAO plan composes no mode for the task's settings.");
}

/**
 * The working state a backend keeps per task between frames, independent
 * of the API: the mode and source extent its textures were made for, and
 * the identities the frame function compares (`SsaoFrameInputs`).
 */
struct SsaoTaskTracking {
    std::uint32_t mode = ~0u;
    std::uint32_t source_width = 0;
    std::uint32_t source_height = 0;
    std::uint64_t allocation = 0;
    /** The source textures the working owner last bound, by backend identity. */
    const void* bound_depth = nullptr;
    const void* bound_normal = nullptr;
    const void* bound_velocity = nullptr;
    std::uint64_t depth_identity = 0;
    std::uint64_t normal_identity = 0;
    std::uint64_t velocity_identity = 0;
};

/**
 * What a backend resolved for one frame: the mode, the frame inputs, and
 * whether the source extent changed, which replaces every texture and buffer
 * the task owns. A mode switch at the same extent keeps the ones both modes
 * use, as the pin keeps its owners across the settings that select programs.
 */
struct SsaoFramePlan {
    std::uint32_t mode = 0;
    bool resized = false;
    SsaoFrameInputs inputs{};
};

/**
 * The adapter's activation and the identities it implies, in the pin's
 * order: the half adapter decides its mode for the source extent
 * (`ssao_prepare_resolution`); the working owner (`SsaoGpu`) is replaced
 * when the extent or the resolution changes, and in Half when the normal
 * input appears or goes (`createPipeline` for another normal format); the
 * owner's bound sources are the ones it last saw. `next` numbers a new
 * owner or source.
 */
inline SsaoFramePlan plan_ssao_frame(SsaoTaskOptions& task, SsaoTaskTracking& tracking,
                                     std::uint64_t& next, std::uint32_t source_width,
                                     std::uint32_t source_height, const void* depth,
                                     const void* normal, const void* velocity,
                                     std::uint32_t velocity_width, std::uint32_t velocity_height) {
    const upstream::SsaoPlanInfo& plan = upstream::ssao_plan_infos[task.plan];
    task.source_width = source_width;
    task.source_height = source_height;
    const bool half = upstream::ssao_prepare_resolution(task, source_width, source_height);
    if (half && velocity && (velocity_width != source_width || velocity_height != source_height))
        throw std::runtime_error("Half-pipeline SSAO velocity and source depth must have "
                                 "identical built dimensions.");
    const std::uint32_t mode = ssao_mode_index(plan, task, half);
    const upstream::SsaoModeInfo& info = plan.modes[mode];
    SsaoFramePlan frame;
    frame.mode = mode;
    frame.resized =
        tracking.source_width != source_width || tracking.source_height != source_height;
    const bool resolution_changed =
        tracking.mode == ~0u || plan.modes[tracking.mode].half != info.half;
    const bool normal_format_changed = info.half && tracking.mode != ~0u &&
                                       plan.modes[tracking.mode].key.normal != info.key.normal;
    const bool owner_created = frame.resized || resolution_changed || normal_format_changed;
    tracking.mode = mode;
    tracking.source_width = source_width;
    tracking.source_height = source_height;
    if (owner_created)
        tracking.allocation = ++next;
    const bool depth_changed = tracking.bound_depth != depth || owner_created;
    const bool normal_changed = tracking.bound_normal != normal || owner_created;
    const bool velocity_changed = tracking.bound_velocity != velocity || owner_created;
    if (tracking.bound_depth != depth)
        tracking.depth_identity = ++next;
    if (tracking.bound_normal != normal)
        tracking.normal_identity = normal ? ++next : 0u;
    if (tracking.bound_velocity != velocity)
        tracking.velocity_identity = velocity ? ++next : 0u;
    tracking.bound_depth = depth;
    tracking.bound_normal = normal;
    tracking.bound_velocity = velocity;
    const SsaoTextureExtent working = ssao_working_extent(info, source_width, source_height);
    SsaoFrameInputs& inputs = frame.inputs;
    inputs.depth_width = source_width;
    inputs.depth_height = source_height;
    inputs.working_width = working.width;
    inputs.working_height = working.height;
    const SsaoTextureExtent output =
        ssao_texture_extent(plan.textures[info.output], source_width, source_height);
    inputs.output_width = output.width;
    inputs.output_height = output.height;
    inputs.gpu = tracking.allocation;
    // A half owner binds its own reduced depth, normal and velocity, made
    // with it; a full one binds the sources themselves.
    inputs.source_depth = info.half ? tracking.allocation : tracking.depth_identity;
    inputs.source_normal =
        info.half ? tracking.allocation : (normal ? tracking.normal_identity : 0u);
    inputs.source_velocity =
        velocity ? (info.half ? tracking.allocation : tracking.velocity_identity) : 0u;
    inputs.velocity_width = velocity ? velocity_width : 0u;
    inputs.velocity_height = velocity ? velocity_height : 0u;
    inputs.pipeline_created = info.half && owner_created;
    inputs.sources_rebound = info.half && (depth_changed || normal_changed || velocity_changed);
    inputs.sampling_footprint = info.sampling_footprint;
    return frame;
}

/**
 * What `enablePbrSsao`'s plugin binds in a pass (`ssao-pbr.ts`): the task's
 * output in a pass of the task's camera once the task has executed, which
 * `use_output` states with the working owner it was made with, and the
 * neutral texture otherwise. A pass of that camera at another aspect than
 * the output's refuses, as `_prepareDraw` does.
 */
struct SsaoPbrSampling {
    bool use_output = false;
    /** The owner the output belongs to: a held binding of another is stale. */
    std::uint64_t allocation = 0;
};

inline SsaoPbrSampling ssao_pbr_sampling(const Engine& engine, const SsaoTaskOptions& task,
                                         const SsaoTaskTracking& tracking,
                                         const ShaderPassMatrices* pass) {
    const CameraRecord& camera = handle_at(engine.cameras, task.camera);
    if (!pass || pass->camera != &camera || tracking.allocation == 0)
        return {};
    const upstream::SsaoPlanInfo& plan = upstream::ssao_plan_infos[task.plan];
    const upstream::SsaoModeInfo& mode = plan.modes[tracking.mode];
    const SsaoTextureExtent output = ssao_texture_extent(
        plan.textures[mode.output], tracking.source_width, tracking.source_height);
    if (upstream::effective_aspect_ratio(camera, pass->target_width, pass->target_height) !=
        upstream::effective_aspect_ratio(camera, output.width, output.height))
        throw std::runtime_error(
            "PBR SSAO and its consuming pass must use the same camera aspect ratio.");
    return {true, tracking.allocation};
}

} // namespace bbl::pal
#endif

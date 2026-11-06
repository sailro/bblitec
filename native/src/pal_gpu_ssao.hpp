#pragma once
// The backend-neutral half of a `createSsaoTask` task's frame: the mode the
// live settings select, the extents its owned textures and buffers take from
// the source, the views its passes name at a mip-chain level, and the frame
// walk both backends encode in the pin's own order. The plan is generated
// (`ssao_plan.hpp`, read off the pin's factory); the per-frame decision is
// generated (`frame_graph_ssao.hpp`, lowered from it). SDL_GPU's encoder is
// pal_sdl_gpu_scene_ssao.cpp, Dawn's pal_dawn_scene_ssao.cpp.

#include <bblite/features/has_ssao.hpp>

#if BBLITE_HAS_SSAO
#include <bblite/pal_gpu_task_timing.hpp>
#include <bblite/runtime.hpp>
#include <bblite/upstream/frame_graph_ssao.hpp>
#include <bblite/upstream/renderer_plan.hpp>
#include <bblite/upstream/ssao_plan.hpp>

#include "pal_gpu_shader_passes.hpp"

#include <algorithm>
#include <array>
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

/** The extent a rule takes from a source extent: its own, half of it rounded up, one texel. */
inline SsaoTextureExtent ssao_extent(upstream::SsaoExtent rule, std::uint32_t source_width,
                                     std::uint32_t source_height) {
    switch (rule) {
    case upstream::SsaoExtent::source:
        return {source_width, source_height, 1u};
    case upstream::SsaoExtent::half:
        return {(source_width + 1u) / 2u, (source_height + 1u) / 2u, 1u};
    case upstream::SsaoExtent::unit:
        return {1u, 1u, 1u};
    }
    throw std::runtime_error("An SSAO texture has an unknown extent rule.");
}

/**
 * The pin's sizes: `createSsaoGpu` and the temporal owner take their working
 * extent, the half-resolution adapter `Math.ceil(extent / 2)`, the unused
 * normal one texel; an AO chain has the pin's own level count over it
 * (`ssao_mip_level_count`). Composition recorded the factory at two source
 * extents, odd and even, and asserted every texture against these rules.
 */
inline SsaoTextureExtent ssao_texture_extent(const upstream::SsaoTextureInfo& texture,
                                             std::uint32_t source_width,
                                             std::uint32_t source_height) {
    SsaoTextureExtent extent = ssao_extent(texture.extent, source_width, source_height);
    if (texture.chain)
        extent.levels = static_cast<std::uint32_t>(upstream::ssao_mip_level_count(
            static_cast<double>(extent.width), static_cast<double>(extent.height)));
    return extent;
}

/** The working extent a mode's owner (`SsaoGpu`) takes: the half one in Half. */
inline SsaoTextureExtent ssao_working_extent(const upstream::SsaoModeInfo& mode,
                                             std::uint32_t source_width,
                                             std::uint32_t source_height) {
    return ssao_extent(mode.half ? upstream::SsaoExtent::half : upstream::SsaoExtent::source,
                       source_width, source_height);
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

/** The task's sources a frame reads: depth, and the normal and velocity inputs it has. */
template <class Texture> struct SsaoSources {
    Texture depth{};
    Texture normal{};
    Texture velocity{};
};

/**
 * The source a view reads, refusing an input the task lacks; empty for a
 * view of a texture the task owns.
 */
template <class Texture>
std::optional<Texture> ssao_source_texture(const SsaoResolvedView& view,
                                           const SsaoSources<Texture>& sources) {
    switch (view.source) {
    case upstream::SsaoTextureSource::depth:
        return sources.depth;
    case upstream::SsaoTextureSource::normal:
        if (!sources.normal)
            throw std::runtime_error("An SSAO pass reads a normal input the task has none of.");
        return sources.normal;
    case upstream::SsaoTextureSource::velocity:
        if (!sources.velocity)
            throw std::runtime_error("An SSAO pass reads a velocity input the task has none of.");
        return sources.velocity;
    case upstream::SsaoTextureSource::owned:
        break;
    }
    return std::nullopt;
}

/**
 * A dispatch's workgroup counts: the storage view it writes covers that
 * view's level, one writing buffers alone the working extent, each over the
 * program's `@workgroup_size` rounded up.
 */
inline std::array<std::uint32_t, 2> ssao_dispatch_groups(const upstream::SsaoModeInfo& mode,
                                                         const upstream::SsaoPassInfo& pass,
                                                         std::uint32_t level,
                                                         std::span<const SsaoTextureExtent> extents,
                                                         const SsaoTextureExtent& working) {
    const upstream::SsaoProgramInfo& program = upstream::ssao_program_infos[pass.program];
    SsaoTextureExtent extent = working;
    if (pass.domain >= 0) {
        const SsaoResolvedView domain = resolve_ssao_view(
            mode, pass.resources[static_cast<std::size_t>(pass.domain)].index, level, extents);
        extent = ssao_level_extent(extents[domain.texture], domain.base_mip);
    }
    return {(extent.width + program.workgroup_x - 1u) / program.workgroup_x,
            (extent.height + program.workgroup_y - 1u) / program.workgroup_y};
}

/**
 * One pass instance of a frame and where it falls among the pin's passes,
 * which GPU task timing counts: a dispatch encoded in the compute pass of
 * the one before it continues that pass, and a buffer clear is no pass.
 */
struct SsaoPassInstance {
    const upstream::SsaoPassInfo* pass = nullptr;
    std::uint32_t level = 0;
    /** It is encoded in the pin's pass of the instance before it. */
    bool continued = false;
    /** It begins one of the pin's passes. */
    bool opens = false;
    /** It ends one. */
    bool closes = false;
};

/**
 * Every pass instance of a frame in the pin's order, into `instances`: a
 * pass repeated over a chain runs once per level 1..levels-1 of that
 * texture, which is how the pin's reduction loops walk `reductions` and
 * `convolution.mipLevelCount`.
 */
inline void ssao_pass_instances(std::span<const upstream::SsaoPassInfo> passes,
                                std::span<const SsaoTextureExtent> extents,
                                std::vector<SsaoPassInstance>& instances) {
    instances.clear();
    for (const upstream::SsaoPassInfo& pass : passes) {
        const bool repeated = pass.repeat_texture >= 0;
        const std::uint32_t end =
            repeated ? extents[static_cast<std::size_t>(pass.repeat_texture)].levels : 1u;
        for (std::uint32_t level = repeated ? 1u : 0u; level < end; ++level) {
            const bool dispatch = pass.stage == upstream::SsaoPassStage::compute;
            const bool after_dispatch = !instances.empty() && instances.back().pass->stage ==
                                                                  upstream::SsaoPassStage::compute;
            const bool same_pass = (repeated && level > 1u) || pass.continues;
            instances.push_back({&pass, level, dispatch && after_dispatch && same_pass});
        }
    }
    for (std::size_t index = 0; index < instances.size(); ++index) {
        SsaoPassInstance& instance = instances[index];
        if (instance.pass->stage == upstream::SsaoPassStage::clear_buffer)
            continue;
        instance.opens = !instance.continued;
        instance.closes = index + 1u == instances.size() || !instances[index + 1u].continued;
    }
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
    const bool pruning = upstream::ssao_installs_transport(task);
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
 * of the API: the mode its textures were made for and the identities the
 * frame function compares (`SsaoFrameInputs`).
 */
struct SsaoTaskTracking {
    std::uint32_t mode = ~0u;
    std::uint64_t allocation = 0;
    /** The working owner and the half adapter's pipeline, as the pin's tests read them. */
    SsaoOwnerShape owner;
    SsaoPipelineShape pipeline;
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

/** The sources a frame binds, by backend identity, with the velocity input's built extent. */
struct SsaoFrameSources {
    const void* depth = nullptr;
    const void* normal = nullptr;
    const void* velocity = nullptr;
    std::uint32_t velocity_width = 0;
    std::uint32_t velocity_height = 0;
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
                                     std::uint64_t& next, std::uint64_t device,
                                     std::uint32_t source_width, std::uint32_t source_height,
                                     const SsaoFrameSources& sources) {
    const upstream::SsaoPlanInfo& plan = upstream::ssao_plan_infos[task.plan];
    SsaoFramePlan frame;
    frame.resized = task.source_width != source_width || task.source_height != source_height;
    task.source_width = source_width;
    task.source_height = source_height;
    const bool half = upstream::ssao_prepare_resolution(task, source_width, source_height);
    const double width = source_width;
    const double height = source_height;
    // The pin's own tests decide whether `prepare` makes a new owner; the
    // backend answers each creation with the owner's shape.
    bool owner_created = false;
    if (!task.half) {
        owner_created = upstream::ssao_owner_replaced(tracking.owner, device, width, height);
        if (owner_created)
            tracking.owner = {true, device, "depth", width, height};
    } else if (!half) {
        // `discard()`: an inactive adapter keeps no pipeline.
        tracking.pipeline = {};
        owner_created =
            upstream::ssao_inactive_owner_replaced(tracking.owner, device, width, height);
        if (owner_created)
            tracking.owner = {true, device, "depth", width, height};
    } else {
        upstream::ssao_require_half_velocity(sources.velocity != nullptr, sources.velocity_width,
                                             sources.velocity_height, source_width, source_height);
        owner_created = upstream::ssao_pipeline_replaced(tracking.pipeline, device, width, height,
                                                         task, sources.normal != nullptr,
                                                         sources.velocity != nullptr);
        if (owner_created) {
            tracking.pipeline = {true,
                                 device,
                                 width,
                                 height,
                                 sources.normal ? task.normal_format : std::string(),
                                 sources.velocity ? task.velocity_format : std::string()};
            const SsaoTextureExtent reduced =
                ssao_extent(upstream::SsaoExtent::half, source_width, source_height);
            tracking.owner = {true, device, "float", static_cast<double>(reduced.width),
                              static_cast<double>(reduced.height)};
        }
    }
    const std::uint32_t mode = ssao_mode_index(plan, task, half);
    const upstream::SsaoModeInfo& info = plan.modes[mode];
    frame.mode = mode;
    tracking.mode = mode;
    if (owner_created)
        tracking.allocation = ++next;
    const bool depth_changed = tracking.bound_depth != sources.depth || owner_created;
    const bool normal_changed = tracking.bound_normal != sources.normal || owner_created;
    const bool velocity_changed = tracking.bound_velocity != sources.velocity || owner_created;
    if (tracking.bound_depth != sources.depth)
        tracking.depth_identity = ++next;
    if (tracking.bound_normal != sources.normal)
        tracking.normal_identity = sources.normal ? ++next : 0u;
    if (tracking.bound_velocity != sources.velocity)
        tracking.velocity_identity = sources.velocity ? ++next : 0u;
    tracking.bound_depth = sources.depth;
    tracking.bound_normal = sources.normal;
    tracking.bound_velocity = sources.velocity;
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
        info.half ? tracking.allocation : (sources.normal ? tracking.normal_identity : 0u);
    inputs.source_velocity =
        sources.velocity ? (info.half ? tracking.allocation : tracking.velocity_identity) : 0u;
    inputs.velocity_width = sources.velocity ? sources.velocity_width : 0u;
    inputs.velocity_height = sources.velocity ? sources.velocity_height : 0u;
    inputs.pipeline_created = info.half && owner_created;
    inputs.sources_rebound = info.half && (depth_changed || normal_changed || velocity_changed);
    inputs.sampling_footprint = info.sampling_footprint;
    return frame;
}

/**
 * One task's owned textures and buffers, by their plan index, made for its
 * source extent as the modes it ran first used them: a mode switch keeps
 * what both modes use. `Texture` and `Buffer` own their backend objects.
 */
template <class Texture, class Buffer> struct SsaoTaskResources {
    SsaoTaskTracking tracking;
    std::vector<Texture> textures;
    std::vector<SsaoTextureExtent> extents;
    std::vector<Buffer> buffers;
    std::vector<std::uint32_t> buffer_bytes;
    /** This frame's pass instances, kept to reuse their storage. */
    std::vector<SsaoPassInstance> instances;
};

/**
 * Every texture and buffer the mode uses, made where missing: a resize
 * replaces them all, `reset` first dropping what the backend derived from
 * them. `texture(info, extent)` and `buffer(info, bytes)` make one.
 */
template <class Resources, class Reset, class MakeTexture, class MakeBuffer>
void prepare_ssao_resources(Resources& task, const upstream::SsaoPlanInfo& plan,
                            const upstream::SsaoModeInfo& mode, std::uint32_t width,
                            std::uint32_t height, bool resized, Reset&& reset,
                            MakeTexture&& texture, MakeBuffer&& buffer) {
    if (resized || task.textures.size() != plan.textures.size()) {
        reset();
        task.textures.clear();
        task.textures.resize(plan.textures.size());
        task.extents.clear();
        for (const upstream::SsaoTextureInfo& info : plan.textures)
            task.extents.push_back(ssao_texture_extent(info, width, height));
        task.buffers.clear();
        task.buffers.resize(plan.buffers.size());
        task.buffer_bytes.assign(plan.buffers.size(), 0u);
    }
    for (const std::uint32_t index : mode.textures)
        if (!task.textures[index])
            task.textures[index] = texture(plan.textures[index], task.extents[index]);
    const SsaoTextureExtent working = ssao_working_extent(mode, width, height);
    for (const std::uint32_t index : mode.buffers) {
        const std::uint32_t bytes = ssao_buffer_bytes(plan.buffers[index], working);
        if (task.buffers[index] && task.buffer_bytes[index] == bytes)
            continue;
        task.buffers[index] = buffer(plan.buffers[index], bytes);
        task.buffer_bytes[index] = bytes;
    }
}

/** One frame as both backends' encoders read it. */
struct SsaoFrame {
    const upstream::SsaoPlanInfo& plan;
    const upstream::SsaoModeInfo& mode;
    std::uint32_t mode_index = 0;
    SsaoFrameDecision decision;
    SsaoTextureExtent working;
    /** The pass list the decision encodes, and which of the mode's three it is. */
    std::span<const upstream::SsaoPassInfo> passes;
    std::uint32_t list = 0;

    /** A uniform block a pass binds, with the bytes the plan's buffer for it takes. */
    std::span<const float> uniform(const upstream::SsaoResourceInfo& resource,
                                   std::size_t& bytes) const {
        const auto block = static_cast<upstream::SsaoUniformBlock>(resource.index);
        for (const upstream::SsaoUniformInfo& info : plan.uniforms)
            if (info.block == block) {
                bytes = info.bytes;
                return ssao_uniform_block(decision, block);
            }
        throw std::runtime_error("An SSAO pass binds a uniform block its plan does not write.");
    }
};

/**
 * One `createSsaoTask` frame on a backend's task state: the plan for the
 * sources, the resources it needs (`prepare(plan, mode, resized)`), the
 * generated decision (`decided(frame)`, before any pass), and every pass
 * instance in the pin's order with the timestamps GPU task timing writes
 * around the pin's passes (`encode(frame, instance, begin, end)`, each null
 * where none is written).
 */
template <class Resources, class Prepare, class Decided, class Encode>
void record_ssao_frame(Engine& engine, TaskHandle handle, Resources& task,
                       std::uint64_t& identities, std::uint64_t device,
                       const SsaoFrameSources& sources, std::uint32_t width, std::uint32_t height,
                       GpuTaskTimingSequence& timing, Prepare&& prepare, Decided&& decided,
                       Encode&& encode) {
    SsaoTaskOptions& options = handle_at(engine.frame_tasks, handle).ssao;
    const SsaoFramePlan planned =
        plan_ssao_frame(options, task.tracking, identities, device, width, height, sources);
    const upstream::SsaoPlanInfo& plan = upstream::ssao_plan_infos[options.plan];
    const upstream::SsaoModeInfo& mode = plan.modes[planned.mode];
    prepare(plan, mode, planned.resized);
    const SsaoFrameDecision decision = upstream::ssao_frame(engine, options, planned.inputs);
    const SsaoFrame frame{plan,
                          mode,
                          planned.mode,
                          decision,
                          ssao_working_extent(mode, width, height),
                          ssao_decision_passes(mode, decision),
                          decision.clear_output ? 2u : decision.history_index};
    decided(frame);
    ssao_pass_instances(frame.passes, task.extents, task.instances);
    std::optional<GpuTaskPassTimestamps> span;
    for (const SsaoPassInstance& instance : task.instances) {
        if (instance.opens)
            span = timing.pass();
        const GpuTimestampWrite* begin =
            span && instance.opens && span->begin ? &*span->begin : nullptr;
        const GpuTimestampWrite* end = span && instance.closes ? &span->end : nullptr;
        encode(frame, instance, begin, end);
        if (instance.closes)
            span.reset();
    }
}

/** The task's state on a backend, grown to hold its handle. */
template <class Resources>
Resources& ssao_task_resources(std::vector<Resources>& tasks, TaskHandle handle) {
    if (tasks.size() <= handle.value)
        tasks.resize(handle.value + 1u);
    return tasks[handle.value];
}

/** The texture a task publishes as `outputTexture`, by plan index, once it executed. */
template <class Resources>
std::uint32_t ssao_output_index(const Engine& engine, TaskHandle handle,
                                const std::vector<Resources>& tasks) {
    if (handle.value >= tasks.size() || tasks[handle.value].textures.empty())
        throw std::runtime_error("An SSAO output is read before its task executed.");
    const SsaoTaskOptions& options = handle_at(engine.frame_tasks, handle).ssao;
    return upstream::ssao_plan_infos[options.plan].modes[tasks[handle.value].tracking.mode].output;
}

/**
 * What `enablePbrSsao`'s plugin binds in a pass (`ssao-pbr.ts`): the output
 * of the task that lists the material and draws with the pass's camera --
 * the pin's scoped sampling selects the pass scene's task, whose camera it
 * then tests (`_selectBindingScope`, `_prepareDraw`) -- once that task has
 * executed, which `use_output` states with the working owner it was made
 * with, and the neutral texture otherwise. A pass of that camera at another
 * aspect than the output's refuses, as `_prepareDraw` does.
 */
struct SsaoPbrSampling {
    bool use_output = false;
    TaskHandle task{};
    /**
     * The binding version (`_bindingVersion`): the output's owner, whose
     * replacement replaces the sampled texture, or zero for the neutral one.
     */
    std::uint64_t version = 0;
};

template <class Resources>
SsaoPbrSampling ssao_pbr_sampling(const Engine& engine, const MaterialRecord& material,
                                  const std::vector<Resources>& tasks,
                                  const ShaderPassMatrices* pass) {
    if (!pass)
        return {};
    const auto lists = [&](const SsaoTaskOptions& task) {
        return std::any_of(task.pbr_materials.begin(), task.pbr_materials.end(),
                           [&](MaterialHandle handle) {
                               return &handle_at(engine.materials, handle) == &material;
                           });
    };
    std::optional<TaskHandle> handle;
    for (std::uint32_t index = 0; index < engine.frame_tasks.size() && !handle; ++index) {
        const FrameTaskRecord& record = engine.frame_tasks[index];
        if (record.kind == FrameTaskKind::ssao &&
            &handle_at(engine.cameras, record.ssao.camera) == pass->camera && lists(record.ssao))
            handle = TaskHandle{index};
    }
    if (!handle || handle->value >= tasks.size())
        return {};
    const SsaoTaskOptions& task = handle_at(engine.frame_tasks, *handle).ssao;
    const CameraRecord& camera = handle_at(engine.cameras, task.camera);
    const SsaoTaskTracking& tracking = tasks[handle->value].tracking;
    if (tracking.allocation == 0)
        return {};
    const upstream::SsaoPlanInfo& plan = upstream::ssao_plan_infos[task.plan];
    const upstream::SsaoModeInfo& mode = plan.modes[tracking.mode];
    const SsaoTextureExtent output =
        ssao_texture_extent(plan.textures[mode.output], task.source_width, task.source_height);
    // `context._projectionAspect ?? getEffectiveAspectRatio(camera, targetWidth, targetHeight)`.
    const double aspect = pass->projection_aspect.value_or(
        upstream::effective_aspect_ratio(camera, pass->target_width, pass->target_height));
    if (aspect != upstream::effective_aspect_ratio(camera, output.width, output.height))
        throw std::runtime_error(
            "PBR SSAO and its consuming pass must use the same camera aspect ratio.");
    return {true, *handle, tracking.allocation};
}

} // namespace bbl::pal
#endif

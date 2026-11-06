// Dawn encoding of `createSsaoTask` frames. SDL_GPU's twin is
// pal_sdl_gpu_scene_ssao.cpp; the plan walk both share is pal_gpu_ssao.hpp.
#include "pal_gpu_common.hpp"
#include "pal_gpu_ssao.hpp"
#include <bblite/features/has_ssao.hpp>

#include "pal_dawn_scene.hpp"

#if BBLITE_HAS_DAWN && BBLITE_HAS_SSAO
#include "pal_dawn_gpu_timestamp.hpp"

#include <map>
#include <optional>
#include <string>
#include <tuple>
#include <utility>

namespace bbl::pal {
inline namespace dawn_scene {

namespace {

/** One plan program on this device. */
struct DawnSsaoProgram {
    DawnBindGroupLayout group_layout;
    DawnPipelineLayout pipeline_layout;
    DawnOwned<WGPUComputePipeline, wgpuComputePipelineRelease> compute;
    DawnRenderPipeline render;
};

/**
 * One task's owned textures and buffers, by their plan index, made for its
 * source extent as the modes it ran first used them: a mode switch keeps
 * what both modes use.
 */
struct DawnSsaoTask {
    SsaoTaskTracking tracking;
    std::vector<DawnTexture> textures;
    std::vector<SsaoTextureExtent> extents;
    /** Views by (texture, base level, level count), made once per allocation. */
    std::map<std::tuple<std::uint32_t, std::uint32_t, std::uint32_t>, DawnTextureView> views;
    std::vector<DawnBuffer> buffers;
    std::vector<std::uint32_t> buffer_bytes;
    /** One buffer per uniform block the plan writes, by `SsaoUniformBlock`. */
    std::array<DawnBuffer, 3> uniforms;
};

} // namespace

struct DawnSsaoState {
    WGPUDevice device = nullptr;
    WGPUQueue queue = nullptr;
    std::vector<std::optional<DawnSsaoProgram>> programs;
    std::vector<DawnSampler> samplers;
    std::vector<DawnSsaoTask> tasks;
    std::uint64_t identities = 0;
};

namespace {

WGPUTextureFormat ssao_format(std::string_view name) {
    for (const DawnNamedTextureFormat& entry : dawn_webgpu_formats)
        if (entry.name == name)
            return entry.format;
    throw std::runtime_error("SSAO texture format '" + std::string(name) + "' has no Dawn format.");
}

/**
 * Every texture and buffer the mode uses, made where missing: a resize
 * replaces them all. WebGPU zero-initializes both.
 */
void prepare_ssao_resources(DawnState& state, DawnSsaoState& ssao, DawnSsaoTask& task,
                            const upstream::SsaoPlanInfo& plan, const upstream::SsaoModeInfo& mode,
                            std::uint32_t width, std::uint32_t height, bool resized) {
    if (resized || task.textures.size() != plan.textures.size()) {
        task.views.clear();
        task.textures.clear();
        task.textures.resize(plan.textures.size());
        task.extents.clear();
        for (const upstream::SsaoTextureInfo& info : plan.textures)
            task.extents.push_back(ssao_texture_extent(info, width, height));
        task.buffers.clear();
        task.buffers.resize(plan.buffers.size());
        task.buffer_bytes.assign(plan.buffers.size(), 0u);
    }
    for (const std::uint32_t index : mode.textures) {
        if (task.textures[index])
            continue;
        const upstream::SsaoTextureInfo& info = plan.textures[index];
        const SsaoTextureExtent& extent = task.extents[index];
        WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
        descriptor.label = string_view("ssao");
        descriptor.size = {extent.width, extent.height, 1u};
        descriptor.format = ssao_format(info.format);
        descriptor.mipLevelCount = extent.levels;
        descriptor.usage = static_cast<WGPUTextureUsage>(info.usage);
        task.textures[index] = DawnTexture{require_dawn_resource(
            wgpuDeviceCreateTexture(ssao.device, &descriptor), "SSAO texture")};
    }
    const SsaoTextureExtent working = ssao_working_extent(mode, width, height);
    for (const std::uint32_t index : mode.buffers) {
        const std::uint32_t bytes = ssao_buffer_bytes(plan.buffers[index], working);
        if (task.buffers[index] && task.buffer_bytes[index] == bytes)
            continue;
        // The pin's `GPUBufferUsage` bits are WebGPU's, which Dawn's share.
        task.buffers[index] = DawnBuffer{create_buffer(
            state, static_cast<WGPUBufferUsage>(plan.buffers[index].usage), nullptr, bytes)};
        task.buffer_bytes[index] = bytes;
    }
}

WGPUSampler ssao_sampler(DawnSsaoState& ssao, std::uint32_t index) {
    if (ssao.samplers.size() <= index)
        ssao.samplers.resize(index + 1u);
    if (ssao.samplers[index])
        return ssao.samplers[index];
    const upstream::SsaoSamplerInfo& info = upstream::ssao_sampler_infos[index];
    WGPUSamplerDescriptor sampler = WGPU_SAMPLER_DESCRIPTOR_INIT;
    sampler.minFilter = info.min_linear ? WGPUFilterMode_Linear : WGPUFilterMode_Nearest;
    sampler.magFilter = info.mag_linear ? WGPUFilterMode_Linear : WGPUFilterMode_Nearest;
    sampler.mipmapFilter = WGPUMipmapFilterMode_Nearest;
    ssao.samplers[index] = DawnSampler{
        require_dawn_resource(wgpuDeviceCreateSampler(ssao.device, &sampler), "SSAO sampler")};
    return ssao.samplers[index];
}

/** The pin's own layout, entry for entry, at the stage its pipeline runs. */
DawnBindGroupLayout ssao_group_layout(WGPUDevice device, const upstream::SsaoProgramInfo& info) {
    std::vector<WGPUBindGroupLayoutEntry> entries;
    const WGPUShaderStage visibility =
        info.compute ? WGPUShaderStage_Compute : WGPUShaderStage_Fragment;
    for (const upstream::SsaoLayoutInfo& binding : info.layout) {
        WGPUBindGroupLayoutEntry entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        entry.binding = binding.binding;
        entry.visibility = visibility;
        switch (binding.kind) {
        case upstream::SsaoBindingKind::uniform:
            entry.buffer.type = WGPUBufferBindingType_Uniform;
            break;
        case upstream::SsaoBindingKind::depth_texture:
            entry.texture.sampleType = WGPUTextureSampleType_Depth;
            break;
        case upstream::SsaoBindingKind::float_texture:
            entry.texture.sampleType = WGPUTextureSampleType_Float;
            break;
        case upstream::SsaoBindingKind::unfilterable_texture:
            entry.texture.sampleType = WGPUTextureSampleType_UnfilterableFloat;
            break;
        case upstream::SsaoBindingKind::uint_texture:
            entry.texture.sampleType = WGPUTextureSampleType_Uint;
            break;
        case upstream::SsaoBindingKind::storage_texture:
            entry.storageTexture.access = WGPUStorageTextureAccess_WriteOnly;
            entry.storageTexture.format = ssao_format(binding.storage_format);
            entry.storageTexture.viewDimension = WGPUTextureViewDimension_2D;
            break;
        case upstream::SsaoBindingKind::storage_buffer:
            entry.buffer.type = WGPUBufferBindingType_Storage;
            break;
        case upstream::SsaoBindingKind::read_only_storage_buffer:
            entry.buffer.type = WGPUBufferBindingType_ReadOnlyStorage;
            break;
        case upstream::SsaoBindingKind::filtering_sampler:
            entry.sampler.type = WGPUSamplerBindingType_Filtering;
            break;
        case upstream::SsaoBindingKind::non_filtering_sampler:
            entry.sampler.type = WGPUSamplerBindingType_NonFiltering;
            break;
        }
        entries.push_back(entry);
    }
    WGPUBindGroupLayoutDescriptor descriptor = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    return DawnBindGroupLayout{require_dawn_resource(
        wgpuDeviceCreateBindGroupLayout(device, &descriptor), "SSAO bind group layout")};
}

const DawnSsaoProgram& ssao_program(DawnState& state, DawnSsaoState& ssao, std::uint32_t index) {
    if (ssao.programs.size() <= index)
        ssao.programs.resize(index + 1u);
    std::optional<DawnSsaoProgram>& slot = ssao.programs[index];
    if (slot)
        return *slot;
    const upstream::SsaoProgramInfo& info = upstream::ssao_program_infos[index];
    DawnSsaoProgram program;
    program.group_layout = ssao_group_layout(ssao.device, info);
    WGPUPipelineLayoutDescriptor layout = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    const WGPUBindGroupLayout group = program.group_layout.get();
    layout.bindGroupLayoutCount = 1;
    layout.bindGroupLayouts = &group;
    program.pipeline_layout = DawnPipelineLayout{require_dawn_resource(
        wgpuDeviceCreatePipelineLayout(ssao.device, &layout), "SSAO pipeline layout")};
    DawnShaderModule module{load_wgsl_module(state, std::string(info.stem))};
    std::vector<std::string> names;
    std::vector<WGPUConstantEntry> constants;
    names.reserve(info.constants.size());
    for (const upstream::SsaoConstantInfo& constant : info.constants) {
        names.emplace_back(constant.name);
        WGPUConstantEntry entry = WGPU_CONSTANT_ENTRY_INIT;
        entry.key = WGPUStringView{names.back().c_str(), names.back().size()};
        entry.value = constant.value;
        constants.push_back(entry);
    }
    const std::string entry(info.entry);
    if (info.compute) {
        WGPUComputePipelineDescriptor descriptor = WGPU_COMPUTE_PIPELINE_DESCRIPTOR_INIT;
        descriptor.layout = program.pipeline_layout;
        descriptor.compute.module = module;
        descriptor.compute.entryPoint = WGPUStringView{entry.c_str(), entry.size()};
        descriptor.compute.constantCount = constants.size();
        descriptor.compute.constants = constants.data();
        program.compute = DawnOwned<WGPUComputePipeline, wgpuComputePipelineRelease>{
            require_dawn_resource(wgpuDeviceCreateComputePipeline(ssao.device, &descriptor),
                                  "SSAO compute pipeline")};
    } else {
        std::vector<WGPUColorTargetState> targets;
        for (const std::string_view format : info.targets) {
            WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
            target.format = ssao_format(format);
            targets.push_back(target);
        }
        const std::string vertex_entry(info.vertex_entry);
        WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
        fragment.module = module;
        fragment.entryPoint = WGPUStringView{entry.c_str(), entry.size()};
        fragment.constantCount = constants.size();
        fragment.constants = constants.data();
        fragment.targetCount = targets.size();
        fragment.targets = targets.data();
        WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
        descriptor.layout = program.pipeline_layout;
        descriptor.vertex.module = module;
        descriptor.vertex.entryPoint = WGPUStringView{vertex_entry.c_str(), vertex_entry.size()};
        descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
        descriptor.primitive.cullMode = WGPUCullMode_None;
        descriptor.multisample.count = 1;
        descriptor.fragment = &fragment;
        program.render = DawnRenderPipeline{require_dawn_resource(
            wgpuDeviceCreateRenderPipeline(ssao.device, &descriptor), "SSAO render pipeline")};
    }
    slot = std::move(program);
    return *slot;
}

/** The task's sources a frame reads: depth, and the normal and velocity inputs it has. */
struct DawnSsaoSources {
    WGPUTextureView depth = nullptr;
    WGPUTextureView normal = nullptr;
    WGPUTextureView velocity = nullptr;
};

/** Encodes one plan frame of one task into the frame's encoder. */
class DawnSsaoEncoder {
public:
    DawnSsaoEncoder(DawnState& state, DawnSsaoState& ssao, DawnSsaoTask& task,
                    const upstream::SsaoModeInfo& mode, WGPUCommandEncoder encoder,
                    const DawnSsaoSources& sources, const SsaoTextureExtent& working)
        : state_(state), ssao_(ssao), task_(task), mode_(mode), encoder_(encoder),
          sources_(sources), working_(working) {}

    void pass(const upstream::SsaoPassInfo& pass, std::uint32_t level,
              const WGPUPassTimestampWrites* timestamps) {
        switch (pass.stage) {
        case upstream::SsaoPassStage::compute:
            compute(pass, level, timestamps);
            return;
        case upstream::SsaoPassStage::render:
        case upstream::SsaoPassStage::clear:
            render(pass, level, timestamps);
            return;
        case upstream::SsaoPassStage::clear_buffer: {
            const auto index = static_cast<std::size_t>(pass.buffer);
            wgpuCommandEncoderClearBuffer(encoder_, task_.buffers.at(index), 0,
                                          task_.buffer_bytes.at(index));
            return;
        }
        }
    }

private:
    DawnState& state_;
    DawnSsaoState& ssao_;
    DawnSsaoTask& task_;
    const upstream::SsaoModeInfo& mode_;
    WGPUCommandEncoder encoder_;
    DawnSsaoSources sources_;
    SsaoTextureExtent working_;

    WGPUTextureView view(std::uint32_t index, std::uint32_t level) {
        const SsaoResolvedView resolved = resolve_ssao_view(mode_, index, level, task_.extents);
        switch (resolved.source) {
        case upstream::SsaoTextureSource::depth:
            return sources_.depth;
        case upstream::SsaoTextureSource::normal:
            if (!sources_.normal)
                throw std::runtime_error("An SSAO pass reads a normal input the task has none of.");
            return sources_.normal;
        case upstream::SsaoTextureSource::velocity:
            if (!sources_.velocity)
                throw std::runtime_error(
                    "An SSAO pass reads a velocity input the task has none of.");
            return sources_.velocity;
        case upstream::SsaoTextureSource::owned:
            break;
        }
        DawnTextureView& view =
            task_.views[{resolved.texture, resolved.base_mip, resolved.mip_count}];
        if (!view) {
            WGPUTextureViewDescriptor descriptor = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
            descriptor.baseMipLevel = resolved.base_mip;
            descriptor.mipLevelCount = resolved.mip_count;
            view = DawnTextureView{create_dawn_texture_view(task_.textures.at(resolved.texture),
                                                            &descriptor, "SSAO texture view")};
        }
        return view;
    }

    DawnBindGroup group(const upstream::SsaoPassInfo& pass, const DawnSsaoProgram& program,
                        std::uint32_t level) {
        const upstream::SsaoProgramInfo& info = upstream::ssao_program_infos[pass.program];
        std::vector<WGPUBindGroupEntry> entries;
        for (std::size_t index = 0; index < info.layout.size(); ++index) {
            const upstream::SsaoResourceInfo& resource = pass.resources[index];
            WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
            entry.binding = info.layout[index].binding;
            switch (resource.kind) {
            case upstream::SsaoResourceKind::uniform:
                entry.buffer = task_.uniforms.at(resource.index);
                entry.size = wgpuBufferGetSize(entry.buffer);
                break;
            case upstream::SsaoResourceKind::view:
                entry.textureView = view(resource.index, level);
                break;
            case upstream::SsaoResourceKind::sampler:
                entry.sampler = ssao_sampler(ssao_, resource.index);
                break;
            case upstream::SsaoResourceKind::buffer:
                entry.buffer = task_.buffers.at(resource.index);
                entry.size = task_.buffer_bytes.at(resource.index);
                break;
            }
            entries.push_back(entry);
        }
        WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        descriptor.layout = program.group_layout;
        descriptor.entryCount = entries.size();
        descriptor.entries = entries.data();
        return DawnBindGroup{require_dawn_resource(
            wgpuDeviceCreateBindGroup(ssao_.device, &descriptor), "SSAO bind group")};
    }

    void compute(const upstream::SsaoPassInfo& pass, std::uint32_t level,
                 const WGPUPassTimestampWrites* timestamps) {
        const upstream::SsaoProgramInfo& info = upstream::ssao_program_infos[pass.program];
        const DawnSsaoProgram& program = ssao_program(state_, ssao_, pass.program);
        const DawnBindGroup bound = group(pass, program, level);
        // A dispatch writing a storage view covers that view's level; one
        // writing buffers alone covers the working extent.
        SsaoTextureExtent extent = working_;
        if (pass.domain >= 0) {
            const SsaoResolvedView domain = resolve_ssao_view(
                mode_, pass.resources[static_cast<std::size_t>(pass.domain)].index, level,
                task_.extents);
            extent = ssao_level_extent(task_.extents[domain.texture], domain.base_mip);
        }
        WGPUComputePassDescriptor descriptor = WGPU_COMPUTE_PASS_DESCRIPTOR_INIT;
        descriptor.timestampWrites = timestamps;
        DawnOwned<WGPUComputePassEncoder, wgpuComputePassEncoderRelease> encoded{
            require_dawn_resource(wgpuCommandEncoderBeginComputePass(encoder_, &descriptor),
                                  "SSAO compute pass")};
        wgpuComputePassEncoderSetPipeline(encoded, program.compute);
        wgpuComputePassEncoderSetBindGroup(encoded, 0, bound, 0, nullptr);
        wgpuComputePassEncoderDispatchWorkgroups(
            encoded, (extent.width + info.workgroup_x - 1u) / info.workgroup_x,
            (extent.height + info.workgroup_y - 1u) / info.workgroup_y, 1u);
        wgpuComputePassEncoderEnd(encoded);
    }

    void render(const upstream::SsaoPassInfo& pass, std::uint32_t level,
                const WGPUPassTimestampWrites* timestamps) {
        std::vector<WGPURenderPassColorAttachment> attachments;
        for (const upstream::SsaoAttachmentInfo& attachment : pass.attachments) {
            WGPURenderPassColorAttachment color = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
            color.view = view(attachment.view, level);
            color.loadOp = WGPULoadOp_Clear;
            color.storeOp = WGPUStoreOp_Store;
            color.clearValue = {attachment.clear[0], attachment.clear[1], attachment.clear[2],
                                attachment.clear[3]};
            attachments.push_back(color);
        }
        WGPURenderPassDescriptor descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        descriptor.colorAttachmentCount = attachments.size();
        descriptor.colorAttachments = attachments.data();
        descriptor.timestampWrites = timestamps;
        std::optional<DawnBindGroup> bound;
        const DawnSsaoProgram* program = nullptr;
        if (pass.stage == upstream::SsaoPassStage::render) {
            program = &ssao_program(state_, ssao_, pass.program);
            bound = group(pass, *program, level);
        }
        DawnRenderPass encoded{require_dawn_resource(
            wgpuCommandEncoderBeginRenderPass(encoder_, &descriptor), "SSAO render pass")};
        if (program) {
            wgpuRenderPassEncoderSetPipeline(encoded, program->render);
            wgpuRenderPassEncoderSetBindGroup(encoded, 0, *bound, 0, nullptr);
            if (pass.buffer >= 0)
                wgpuRenderPassEncoderDrawIndirect(
                    encoded, task_.buffers.at(static_cast<std::size_t>(pass.buffer)), 0);
            else
                count_gpu_draw(wgpuRenderPassEncoderDraw, encoded, 3, 1, 0, 0);
        }
        wgpuRenderPassEncoderEnd(encoded);
    }
};

} // namespace

DawnSsaoState& ssao_state(DawnState& state) {
    if (!state.ssao) {
        state.ssao = std::make_shared<DawnSsaoState>();
        state.ssao->device = state.device;
        state.ssao->queue = state.queue;
    }
    return *state.ssao;
}

void record_ssao_task(DawnState& state, Engine& engine, TaskHandle handle,
                      WGPUCommandEncoder encoder, WGPUTextureView depth, WGPUTextureView normal,
                      WGPUTextureView velocity, std::uint32_t velocity_width,
                      std::uint32_t velocity_height, std::uint32_t width, std::uint32_t height,
                      GpuTaskTimingSequence& timing) {
    SsaoTaskOptions& options = handle_at(engine.frame_tasks, handle).ssao;
    DawnSsaoState& ssao = ssao_state(state);
    if (ssao.tasks.size() <= handle.value)
        ssao.tasks.resize(handle.value + 1u);
    DawnSsaoTask& task = ssao.tasks[handle.value];
    const SsaoFramePlan frame =
        plan_ssao_frame(options, task.tracking, ssao.identities, width, height, depth, normal,
                        velocity, velocity_width, velocity_height);
    const upstream::SsaoPlanInfo& plan = upstream::ssao_plan_infos[options.plan];
    const upstream::SsaoModeInfo& mode = plan.modes[frame.mode];
    prepare_ssao_resources(state, ssao, task, plan, mode, width, height, frame.resized);
    const SsaoFrameDecision decision = upstream::ssao_frame(engine, options, frame.inputs);
    // Each buffer the pin writes once per frame, before the frame's commands run.
    for (const upstream::SsaoUniformInfo& uniform : plan.uniforms) {
        DawnBuffer& buffer = task.uniforms.at(static_cast<std::size_t>(uniform.block));
        if (!buffer)
            buffer = DawnBuffer{create_buffer(
                state, WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst, nullptr, uniform.bytes)};
        const auto data = ssao_uniform_block(decision, uniform.block);
        if (data.size() * sizeof(float) != uniform.bytes)
            throw std::runtime_error("An SSAO uniform block's size disagrees with its buffer.");
        DawnGpuDevice{state.queue}.write_buffer(buffer, 0, data.data(), uniform.bytes);
    }
    DawnSsaoEncoder encoded(state, ssao, task, mode, encoder, {depth, normal, velocity},
                            ssao_working_extent(mode, width, height));
    // Each of the pin's passes gets its timestamps on the native passes
    // that open and close it.
    std::optional<GpuTaskPassTimestamps> span;
    for (const SsaoPassInstance& instance :
         ssao_pass_instances(ssao_decision_passes(mode, decision), task.extents)) {
        if (instance.opens)
            span = timing.pass();
        DawnPassTimestamps timestamps;
        if (span && instance.opens && span->begin)
            timestamps.add(*span->begin);
        if (span && instance.closes)
            timestamps.add(span->end);
        encoded.pass(*instance.pass, instance.level, timestamps.get());
        if (instance.closes)
            span.reset();
    }
}

WGPUTextureView ssao_output_view(DawnState& state, const Engine& engine, TaskHandle handle) {
    const SsaoTaskOptions& options = handle_at(engine.frame_tasks, handle).ssao;
    DawnSsaoState& ssao = ssao_state(state);
    if (handle.value >= ssao.tasks.size() || ssao.tasks[handle.value].textures.empty())
        throw std::runtime_error("An SSAO output is read before its task executed.");
    DawnSsaoTask& task = ssao.tasks[handle.value];
    const upstream::SsaoModeInfo& mode =
        upstream::ssao_plan_infos[options.plan].modes[task.tracking.mode];
    DawnTextureView& view = task.views[{mode.output, 0u, task.extents.at(mode.output).levels}];
    if (!view)
        view = DawnTextureView{
            create_dawn_texture_view(task.textures.at(mode.output), nullptr, "SSAO output view")};
    return view;
}

SsaoPbrBinding ssao_pbr_binding(DawnState& state, const Engine& engine, TaskHandle handle,
                                const ShaderPassMatrices* pass) {
    DawnSsaoState& ssao = ssao_state(state);
    const SsaoTaskOptions& options = handle_at(engine.frame_tasks, handle).ssao;
    const SsaoPbrSampling sampling =
        handle.value < ssao.tasks.size()
            ? ssao_pbr_sampling(engine, options, ssao.tasks[handle.value].tracking, pass)
            : SsaoPbrSampling{};
    // `getNearestSampler` for both, and the neutral `createSolidTexture2D(engine, 1, 1, 1, 1)`.
    if (sampling.use_output)
        return {ssao_output_view(state, engine, handle), state.nearest_sampler,
                sampling.allocation};
    return {state.white_view, state.nearest_sampler, 0};
}

} // namespace dawn_scene
} // namespace bbl::pal
#endif

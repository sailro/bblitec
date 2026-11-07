// Dawn encoding of `createSsaoTask` frames. SDL_GPU's twin is
// pal_sdl_gpu_scene_ssao.cpp; the frame walk both share is pal_gpu_ssao.hpp.
#include "pal_gpu_common.hpp"
#include "pal_gpu_ssao.hpp"
#include <bblite/features/has_ssao.hpp>

#include "pal_dawn_scene.hpp"

#if BBLITE_HAS_DAWN && BBLITE_HAS_SSAO
#include "pal_dawn_gpu_timestamp.hpp"
#include "pal_dawn_pinned_program.hpp"

#include <array>
#include <optional>
#include <string>
#include <unordered_map>
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

/** One task's owned textures and buffers (`SsaoTaskResources`) on this device. */
struct DawnSsaoTask : SsaoTaskResources<DawnTexture, DawnBuffer> {
    /**
     * Views by texture, then by base level and level count
     * (`base * levels + count - 1`), made once per allocation.
     */
    std::vector<std::vector<DawnTextureView>> views;
    /** One buffer per uniform block the plan writes, by `SsaoUniformBlock`. */
    std::array<DawnBuffer, 3> uniforms;
    /**
     * Each pass instance's bind group, by mode, pass list, pass and level
     * (`group_key`), as the pin binds its groups once over the textures,
     * buffers and sources its owner holds (`bindSsaoGpuSources`): dropped
     * when the task makes a texture or buffer, or the owner or a bound
     * source changes.
     */
    std::unordered_map<std::uint64_t, DawnBindGroup> groups;
    std::uint64_t group_allocation = 0;
    SsaoSources<WGPUTextureView> group_sources{};
};

/** The bindings one pass encodes, reused across passes and frames. */
struct DawnSsaoScratch {
    std::vector<WGPUBindGroupEntry> entries;
    std::vector<WGPURenderPassColorAttachment> attachments;
};

} // namespace

struct DawnSsaoState {
    WGPUDevice device = nullptr;
    std::vector<std::optional<DawnSsaoProgram>> programs;
    std::vector<DawnSampler> samplers;
    std::vector<DawnSsaoTask> tasks;
    std::uint64_t identities = 0;
    /** This device's identity, which the owners made on it carry. */
    std::uint64_t device_identity = ++identities;
    DawnSsaoScratch scratch;
};

namespace {

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

const DawnSsaoProgram& ssao_program(DawnState& state, DawnSsaoState& ssao, std::uint32_t index) {
    if (ssao.programs.size() <= index)
        ssao.programs.resize(index + 1u);
    std::optional<DawnSsaoProgram>& slot = ssao.programs[index];
    if (slot)
        return *slot;
    const upstream::SsaoProgramInfo& info = upstream::ssao_program_infos[index];
    DawnSsaoProgram program;
    // The pin's own layout, entry for entry, at the stage its pipeline runs.
    program.group_layout = create_dawn_pinned_group_layout(
        ssao.device, info.layout, info.compute ? WGPUShaderStage_Compute : WGPUShaderStage_Fragment,
        "SSAO bind group layout");
    program.pipeline_layout = create_dawn_pinned_pipeline_layout(ssao.device, program.group_layout,
                                                                 "SSAO pipeline layout");
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
    if (info.compute) {
        WGPUComputePipelineDescriptor descriptor = WGPU_COMPUTE_PIPELINE_DESCRIPTOR_INIT;
        descriptor.layout = program.pipeline_layout;
        descriptor.compute.module = module;
        descriptor.compute.entryPoint = WGPUStringView{info.entry.data(), info.entry.size()};
        descriptor.compute.constantCount = constants.size();
        descriptor.compute.constants = constants.data();
        program.compute = DawnOwned<WGPUComputePipeline, wgpuComputePipelineRelease>{
            require_dawn_resource(wgpuDeviceCreateComputePipeline(ssao.device, &descriptor),
                                  "SSAO compute pipeline")};
    } else {
        std::vector<WGPUTextureFormat> formats;
        for (const std::string_view format : info.targets)
            formats.push_back(dawn_named_texture_format(format));
        program.render = create_dawn_fullscreen_pipeline(
            ssao.device, program.pipeline_layout, module, info.vertex_entry, info.entry, constants,
            formats, "SSAO render pipeline");
    }
    slot = std::move(program);
    return *slot;
}

/** A pass instance's bind group key: its mode, pass list, pass and chain level. */
std::uint64_t group_key(const SsaoFrame& frame, const SsaoPassInstance& instance) {
    const auto pass = static_cast<std::uint64_t>(instance.pass - frame.passes.data());
    return (static_cast<std::uint64_t>(frame.mode_index) << 32u) |
           (static_cast<std::uint64_t>(frame.list) << 24u) | (pass << 8u) | instance.level;
}

/** Encodes one pass instance of a plan frame into the frame's encoder. */
class DawnSsaoEncoder {
public:
    DawnSsaoEncoder(DawnState& state, DawnSsaoState& ssao, DawnSsaoTask& task,
                    const SsaoFrame& frame, WGPUCommandEncoder encoder,
                    const SsaoSources<WGPUTextureView>& sources)
        : state_(state), ssao_(ssao), task_(task), frame_(frame), encoder_(encoder),
          sources_(sources), scratch_(ssao.scratch) {}

    void pass(const SsaoPassInstance& instance, const WGPUPassTimestampWrites* timestamps) {
        const upstream::SsaoPassInfo& pass = *instance.pass;
        switch (pass.stage) {
        case upstream::SsaoPassStage::compute:
            compute(instance, timestamps);
            return;
        case upstream::SsaoPassStage::render:
        case upstream::SsaoPassStage::clear:
            render(instance, timestamps);
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
    const SsaoFrame& frame_;
    WGPUCommandEncoder encoder_;
    const SsaoSources<WGPUTextureView>& sources_;
    DawnSsaoScratch& scratch_;

    WGPUTextureView view(std::uint32_t index, std::uint32_t level) {
        const SsaoResolvedView resolved =
            resolve_ssao_view(frame_.mode, index, level, task_.extents);
        if (const auto source = ssao_source_texture(resolved, sources_))
            return *source;
        const std::uint32_t levels = task_.extents[resolved.texture].levels;
        auto& views = task_.views.at(resolved.texture);
        if (views.size() < levels * levels)
            views.resize(levels * levels);
        DawnTextureView& view = views[resolved.base_mip * levels + resolved.mip_count - 1u];
        if (!view) {
            WGPUTextureViewDescriptor descriptor = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
            descriptor.baseMipLevel = resolved.base_mip;
            descriptor.mipLevelCount = resolved.mip_count;
            view = DawnTextureView{create_dawn_texture_view(task_.textures.at(resolved.texture),
                                                            &descriptor, "SSAO texture view")};
        }
        return view;
    }

    /** The pass instance's bind group: the held one, or one made over this frame's views. */
    WGPUBindGroup group(const SsaoPassInstance& instance, const DawnSsaoProgram& program) {
        DawnBindGroup& held = task_.groups[group_key(frame_, instance)];
        if (held)
            return held;
        const upstream::SsaoPassInfo& pass = *instance.pass;
        const upstream::SsaoProgramInfo& info = upstream::ssao_program_infos[pass.program];
        scratch_.entries.clear();
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
                entry.textureView = view(resource.index, instance.level);
                break;
            case upstream::SsaoResourceKind::sampler:
                entry.sampler = ssao_sampler(ssao_, resource.index);
                break;
            case upstream::SsaoResourceKind::buffer:
                entry.buffer = task_.buffers.at(resource.index);
                entry.size = task_.buffer_bytes.at(resource.index);
                break;
            }
            scratch_.entries.push_back(entry);
        }
        WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        descriptor.layout = program.group_layout;
        descriptor.entryCount = scratch_.entries.size();
        descriptor.entries = scratch_.entries.data();
        held = DawnBindGroup{require_dawn_resource(
            wgpuDeviceCreateBindGroup(ssao_.device, &descriptor), "SSAO bind group")};
        return held;
    }

    void compute(const SsaoPassInstance& instance, const WGPUPassTimestampWrites* timestamps) {
        const upstream::SsaoPassInfo& pass = *instance.pass;
        const DawnSsaoProgram& program = ssao_program(state_, ssao_, pass.program);
        const WGPUBindGroup bound = group(instance, program);
        const auto groups =
            ssao_dispatch_groups(frame_.mode, pass, instance.level, task_.extents, frame_.working);
        WGPUComputePassDescriptor descriptor = WGPU_COMPUTE_PASS_DESCRIPTOR_INIT;
        descriptor.timestampWrites = timestamps;
        DawnOwned<WGPUComputePassEncoder, wgpuComputePassEncoderRelease> encoded{
            require_dawn_resource(wgpuCommandEncoderBeginComputePass(encoder_, &descriptor),
                                  "SSAO compute pass")};
        wgpuComputePassEncoderSetPipeline(encoded, program.compute);
        wgpuComputePassEncoderSetBindGroup(encoded, 0, bound, 0, nullptr);
        wgpuComputePassEncoderDispatchWorkgroups(encoded, groups[0], groups[1], 1u);
        wgpuComputePassEncoderEnd(encoded);
    }

    void render(const SsaoPassInstance& instance, const WGPUPassTimestampWrites* timestamps) {
        const upstream::SsaoPassInfo& pass = *instance.pass;
        scratch_.attachments.clear();
        for (const upstream::SsaoAttachmentInfo& attachment : pass.attachments) {
            WGPURenderPassColorAttachment color = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
            color.view = view(attachment.view, instance.level);
            color.loadOp = WGPULoadOp_Clear;
            color.storeOp = WGPUStoreOp_Store;
            color.clearValue = {attachment.clear[0], attachment.clear[1], attachment.clear[2],
                                attachment.clear[3]};
            scratch_.attachments.push_back(color);
        }
        WGPURenderPassDescriptor descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        descriptor.colorAttachmentCount = scratch_.attachments.size();
        descriptor.colorAttachments = scratch_.attachments.data();
        descriptor.timestampWrites = timestamps;
        WGPUBindGroup bound = nullptr;
        const DawnSsaoProgram* program = nullptr;
        if (pass.stage == upstream::SsaoPassStage::render) {
            program = &ssao_program(state_, ssao_, pass.program);
            bound = group(instance, *program);
        }
        DawnRenderPass encoded{require_dawn_resource(
            wgpuCommandEncoderBeginRenderPass(encoder_, &descriptor), "SSAO render pass")};
        if (program) {
            wgpuRenderPassEncoderSetPipeline(encoded, program->render);
            wgpuRenderPassEncoderSetBindGroup(encoded, 0, bound, 0, nullptr);
            if (pass.buffer >= 0)
                wgpuRenderPassEncoderDrawIndirect(
                    encoded, task_.buffers.at(static_cast<std::size_t>(pass.buffer)), 0);
            else
                count_gpu_draw(wgpuRenderPassEncoderDraw, encoded, 3, 1, 0, 0);
        }
        wgpuRenderPassEncoderEnd(encoded);
    }
};

/** The owned texture a plan row names. WebGPU zero-initializes it. */
DawnTexture make_ssao_texture(DawnSsaoState& ssao, const upstream::SsaoTextureInfo& info,
                              const SsaoTextureExtent& extent) {
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.label = string_view("ssao");
    descriptor.size = {extent.width, extent.height, 1u};
    descriptor.format = dawn_named_texture_format(info.format);
    descriptor.mipLevelCount = extent.levels;
    descriptor.usage = static_cast<WGPUTextureUsage>(info.usage);
    return DawnTexture{
        require_dawn_resource(wgpuDeviceCreateTexture(ssao.device, &descriptor), "SSAO texture")};
}

} // namespace

DawnSsaoState& ssao_state(DawnState& state) {
    if (!state.ssao) {
        state.ssao = std::make_shared<DawnSsaoState>();
        state.ssao->device = state.device;
    }
    return *state.ssao;
}

void record_ssao_task(DawnState& state, Engine& engine, TaskHandle handle,
                      WGPUCommandEncoder encoder, WGPUTextureView depth, WGPUTextureView normal,
                      WGPUTextureView velocity, std::uint32_t velocity_width,
                      std::uint32_t velocity_height, std::uint32_t width, std::uint32_t height,
                      GpuTaskTimingSequence& timing) {
    DawnSsaoState& ssao = ssao_state(state);
    DawnSsaoTask& task = ssao_task_resources(ssao.tasks, handle);
    const SsaoSources<WGPUTextureView> sources{depth, normal, velocity};
    record_ssao_frame(
        engine, handle, task, ssao.identities, ssao.device_identity,
        {depth, normal, velocity, velocity_width, velocity_height}, width, height, timing,
        [&](const upstream::SsaoPlanInfo& plan, const upstream::SsaoModeInfo& mode, bool resized) {
            prepare_ssao_resources(
                task, plan, mode, width, height, resized,
                [&] {
                    task.views.clear();
                    task.groups.clear();
                },
                [&](const upstream::SsaoTextureInfo& info, const SsaoTextureExtent& extent) {
                    task.groups.clear();
                    return make_ssao_texture(ssao, info, extent);
                },
                [&](const upstream::SsaoBufferInfo& info, std::uint32_t bytes) {
                    // The pin's `GPUBufferUsage` bits are WebGPU's, which Dawn's share.
                    task.groups.clear();
                    return DawnBuffer{create_buffer(state, static_cast<WGPUBufferUsage>(info.usage),
                                                    nullptr, bytes)};
                });
            task.views.resize(plan.textures.size());
            if (task.group_allocation != task.tracking.allocation ||
                task.group_sources.depth != depth || task.group_sources.normal != normal ||
                task.group_sources.velocity != velocity) {
                task.groups.clear();
                task.group_allocation = task.tracking.allocation;
                task.group_sources = sources;
            }
        },
        // Each buffer the pin writes once per frame, before the frame's
        // commands run.
        [&](const SsaoFrame& frame) {
            for (const upstream::SsaoUniformInfo& uniform : frame.plan.uniforms) {
                DawnBuffer& buffer = task.uniforms.at(static_cast<std::size_t>(uniform.block));
                if (!buffer)
                    buffer = DawnBuffer{
                        create_buffer(state, WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst,
                                      nullptr, uniform.bytes)};
                DawnGpuDevice{state.queue}.write_buffer(
                    buffer, 0, ssao_uniform_block(frame.decision, uniform.block).data(),
                    uniform.bytes);
            }
        },
        [&](const SsaoFrame& frame, const SsaoPassInstance& instance,
            const GpuTimestampWrite* begin, const GpuTimestampWrite* end) {
            // Each of the pin's passes gets its timestamps on the native
            // passes that open and close it.
            DawnPassTimestamps timestamps;
            if (begin)
                timestamps.add(*begin);
            if (end)
                timestamps.add(*end);
            DawnSsaoEncoder(state, ssao, task, frame, encoder, sources)
                .pass(instance, timestamps.get());
        });
}

namespace {

/** The view of the texture a task publishes as `outputTexture`, once it executed. */
WGPUTextureView ssao_output_view(DawnState& state, const Engine& engine, TaskHandle handle) {
    DawnSsaoState& ssao = ssao_state(state);
    const std::uint32_t output = ssao_output_index(engine, handle, ssao.tasks);
    DawnSsaoTask& task = ssao.tasks[handle.value];
    const std::uint32_t levels = task.extents.at(output).levels;
    auto& views = task.views.at(output);
    if (views.size() < levels * levels)
        views.resize(levels * levels);
    DawnTextureView& view = views[levels - 1u];
    if (!view)
        view = DawnTextureView{
            create_dawn_texture_view(task.textures.at(output), nullptr, "SSAO output view")};
    return view;
}

/** What `enablePbrSsao`'s plugin samples for a material in a pass (`ssao_pbr_sampling`). */
DawnDynamicPluginBinding ssao_pbr_binding(DawnState& state, const Engine& engine,
                                          const MaterialRecord& material,
                                          const ShaderPassMatrices* pass) {
    DawnSsaoState& ssao = ssao_state(state);
    const SsaoPbrSampling sampling = ssao_pbr_sampling(engine, material, ssao.tasks, pass);
    // `getNearestSampler` for both, and the neutral `createSolidTexture2D(engine, 1, 1, 1, 1)`.
    if (sampling.use_output)
        return {ssao_output_view(state, engine, sampling.task), state.nearest_sampler,
                sampling.version};
    return {state.white_view, state.nearest_sampler, sampling.version};
}

[[maybe_unused]] const bool ssao_owner_registered =
    DawnTaskOutputOwners::add(FrameTaskKind::ssao, {&ssao_output_view, &ssao_pbr_binding});

} // namespace

} // namespace dawn_scene
} // namespace bbl::pal
#endif

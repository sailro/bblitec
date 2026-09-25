// Dawn post-process and screen-space passes. SDL_GPU's twin is
// pal_sdl_gpu_scene_post_process.cpp.
#include "pal_gpu_common.hpp"
#include "pal_gpu_targets.hpp"
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_post_process.hpp>
#include <bblite/features/has_screen_space.hpp>

#include "pal_dawn_scene.hpp"

namespace bbl::pal {
inline namespace dawn_scene {

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_POST_PROCESS

std::size_t post_process_program(DawnState& state, const upstream::PostProcessShaderInfo& info,
                                 WGPUTextureFormat format, std::uint32_t samples,
                                 std::uint32_t alpha_mode, std::size_t extra_textures) {
    const std::uint32_t uniform_size = (info.uniform_byte_length + 15u) & ~15u;
    return find_or_create_program(
        state.post_process_programs,
        [&](const DawnPostProcessProgram& program) {
            return program.module_index == info.module_index && program.format == format &&
                   program.samples == samples && program.alpha_mode == alpha_mode &&
                   program.extra_textures == extra_textures &&
                   program.uniform_binding == info.uniform_binding &&
                   program.uniform_size == uniform_size;
        },
        [&] {
            return build_dawn_post_process_program(state.device, info, format, samples, alpha_mode,
                                                   extra_textures, uniform_size);
        });
}

void write_dawn_post_process_uniforms(DawnState& state, Engine& engine, TaskHandle handle,
                                      std::size_t index, std::uint32_t width, std::uint32_t height,
                                      bool force) {
    auto& pass = handle_at(engine.frame_tasks, handle).post_process.passes[index];
    auto& gpu = handle_at(state.post_process_tasks, handle)[index];
    if (!gpu.uniforms || (!force && !pass.uniforms_dirty))
        return;
    const auto& program = state.post_process_programs[gpu.program];
    const auto extent =
        resolve_post_process_extent(handle_at(engine.render_targets, pass.output_target),
                                    state.render_targets, pass, width, height);
    std::vector<float> data(program.uniform_size / sizeof(float), 0.0f);
    upstream::write_post_process_uniforms(engine, pass, extent.output_width, extent.output_height,
                                          extent.source_width, extent.source_height, data.data());
    wgpuQueueWriteBuffer(state.queue, gpu.uniforms, 0, data.data(), program.uniform_size);
    pass.uniforms_dirty = false;
}

void encode_dawn_post_process_pass(WGPUCommandEncoder encoder, WGPUTextureView surface_view,
                                   const PreparedDawnPostProcessPass& prepared) {
    WGPURenderPassColorAttachment attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    attachment.view = prepared.presents ? surface_view : prepared.output;
    attachment.loadOp = prepared.clear ? WGPULoadOp_Clear : WGPULoadOp_Load;
    attachment.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor pass_descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    pass_descriptor.colorAttachmentCount = 1;
    pass_descriptor.colorAttachments = &attachment;
    DawnRenderPass post_pass{wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor)};
    if (prepared.viewport) {
        const PixelViewport& rectangle = *prepared.viewport;
        wgpuRenderPassEncoderSetViewport(
            post_pass, static_cast<float>(rectangle.x), static_cast<float>(rectangle.y),
            static_cast<float>(rectangle.width), static_cast<float>(rectangle.height), 0.0f, 1.0f);
        wgpuRenderPassEncoderSetScissorRect(post_pass, static_cast<std::uint32_t>(rectangle.x),
                                            static_cast<std::uint32_t>(rectangle.y),
                                            static_cast<std::uint32_t>(rectangle.width),
                                            static_cast<std::uint32_t>(rectangle.height));
    }
    wgpuRenderPassEncoderSetPipeline(post_pass, prepared.pipeline);
    wgpuRenderPassEncoderSetBindGroup(post_pass, 0, prepared.group, 0, nullptr);
    count_gpu_draw(wgpuRenderPassEncoderDraw, post_pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(post_pass);
    post_pass.reset();
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_SCREEN_SPACE
DawnScreenSpaceProgram build_screen_space_program(DawnState& state, std::uint32_t stage) {
    const upstream::ScreenSpaceShaderInfo& info = upstream::screen_space_shader_infos.at(stage);
    DawnScreenSpaceProgram program;
    program.stage = stage;
    // Both stages live in one deployed module under the fragment stem.
    program.module = load_wgsl_module(state, std::string(info.stem) + ".frag");
    // The pin's own bind group layout, entry for entry: every binding is
    // fragment-visible, and the kinds are the ones its descriptors name.
    std::vector<WGPUBindGroupLayoutEntry> layout_entries;
    for (std::size_t index = 0; index < info.binding_count; ++index) {
        const upstream::ScreenSpaceStageBinding& binding = info.bindings[index];
        WGPUBindGroupLayoutEntry entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        entry.binding = binding.binding;
        entry.visibility = WGPUShaderStage_Fragment;
        switch (binding.kind) {
        case upstream::ScreenSpaceBindingKind::depth_texture:
            entry.texture.sampleType = WGPUTextureSampleType_Depth;
            break;
        case upstream::ScreenSpaceBindingKind::texture:
            entry.texture.sampleType = WGPUTextureSampleType_Float;
            break;
        case upstream::ScreenSpaceBindingKind::sampler:
            entry.sampler.type = WGPUSamplerBindingType_Filtering;
            break;
        case upstream::ScreenSpaceBindingKind::uniform:
            entry.buffer.type = WGPUBufferBindingType_Uniform;
            break;
        }
        layout_entries.push_back(entry);
    }
    WGPUBindGroupLayoutDescriptor layout_descriptor = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    layout_descriptor.entryCount = layout_entries.size();
    layout_descriptor.entries = layout_entries.data();
    program.group_layout = require_dawn_resource(
        wgpuDeviceCreateBindGroupLayout(state.device, &layout_descriptor), "pass pipeline layout");
    WGPUPipelineLayoutDescriptor pipeline_layout = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    pipeline_layout.bindGroupLayoutCount = 1;
    const auto group_layout = program.group_layout.get();
    pipeline_layout.bindGroupLayouts = &group_layout;
    program.pipeline_layout = require_dawn_resource(
        wgpuDeviceCreatePipelineLayout(state.device, &pipeline_layout), "pass pipeline layout");
    // Single-sample, unblended, a triangle list: `ensureProducerPipeline`.
    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = texture_format(info.target_format);
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = program.module;
    fragment.entryPoint = string_view(info.fragment_entry);
    fragment.targetCount = 1;
    fragment.targets = &color_target;
    WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = program.pipeline_layout;
    descriptor.vertex.module = program.module;
    descriptor.vertex.entryPoint = string_view(info.vertex_entry);
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.cullMode = WGPUCullMode_None;
    descriptor.multisample.count = 1;
    descriptor.multisample.mask = ~0u;
    descriptor.fragment = &fragment;
    program.pipeline = wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
    if (!program.pipeline) {
        dawn_error("screen-space pipeline creation failed.");
    }
    return program;
}

std::size_t screen_space_program(DawnState& state, std::uint32_t stage) {
    return find_or_create_program(
        state.screen_space_programs,
        [&](const DawnScreenSpaceProgram& program) { return program.stage == stage; },
        [&] { return build_screen_space_program(state, stage); });
}

WGPUTextureView screen_space_binding_view(DawnState& state, const ScreenSpaceTaskOptions& task,
                                          upstream::ScreenSpaceTextureRole role) {
    switch (role) {
    case upstream::ScreenSpaceTextureRole::depth:
        return handle_at(state.render_targets, task.depth).depth_sampled_view;
    case upstream::ScreenSpaceTextureRole::source_color:
        return handle_at(state.render_targets, task.source).sampled_color_view;
    case upstream::ScreenSpaceTextureRole::raw:
        return handle_at(state.render_targets, task.raw).sampled_color_view;
    case upstream::ScreenSpaceTextureRole::history:
        return handle_at(state.render_targets, task.history).sampled_color_view;
    default:
        dawn_error("A screen-space stage binds a texture role this backend "
                   "does not serve.");
    }
}

WGPURenderPassEncoder begin_screen_space_pass(WGPUCommandEncoder encoder, WGPUTextureView target) {
    WGPURenderPassColorAttachment attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    attachment.view = target;
    attachment.loadOp = WGPULoadOp_Clear;
    attachment.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor pass_descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    pass_descriptor.colorAttachmentCount = 1;
    pass_descriptor.colorAttachments = &attachment;
    return wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor);
}

void record_screen_space_stage(DawnState& state, const ScreenSpaceTaskOptions& task,
                               DawnScreenSpaceStage& stage, std::uint32_t stage_index,
                               WGPUCommandEncoder encoder, WGPUTextureView target,
                               const float* uniforms) {
    if (stage.program == npos) {
        stage.program = screen_space_program(state, stage_index);
    }
    const DawnScreenSpaceProgram& program = state.screen_space_programs[stage.program];
    const upstream::ScreenSpaceShaderInfo& info =
        upstream::screen_space_shader_infos[program.stage];
    if (!stage.uniforms) {
        WGPUBufferDescriptor uniform_descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        uniform_descriptor.size = info.uniform_bytes;
        uniform_descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        stage.uniforms = wgpuDeviceCreateBuffer(state.device, &uniform_descriptor);
    }
    wgpuQueueWriteBuffer(state.queue, stage.uniforms, 0, uniforms, info.uniform_bytes);
    if (!stage.group) {
        std::vector<WGPUBindGroupEntry> entries;
        for (std::size_t index = 0; index < info.binding_count; ++index) {
            const upstream::ScreenSpaceStageBinding& binding = info.bindings[index];
            WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
            entry.binding = binding.binding;
            switch (binding.kind) {
            case upstream::ScreenSpaceBindingKind::depth_texture:
            case upstream::ScreenSpaceBindingKind::texture:
                entry.textureView = screen_space_binding_view(state, task, binding.role);
                break;
            case upstream::ScreenSpaceBindingKind::sampler:
                // The pin's one bilinear sampler wherever it samples.
                entry.sampler = state.post_process_bilinear_sampler;
                break;
            case upstream::ScreenSpaceBindingKind::uniform:
                entry.buffer = stage.uniforms;
                entry.size = info.uniform_bytes;
                break;
            }
            entries.push_back(entry);
        }
        WGPUBindGroupDescriptor group_descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        group_descriptor.layout = program.group_layout;
        group_descriptor.entryCount = entries.size();
        group_descriptor.entries = entries.data();
        stage.group = wgpuDeviceCreateBindGroup(state.device, &group_descriptor);
    }
    DawnRenderPass pass{begin_screen_space_pass(encoder, target)};
    wgpuRenderPassEncoderSetPipeline(pass, program.pipeline);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, stage.group, 0, nullptr);
    count_gpu_draw(wgpuRenderPassEncoderDraw, pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    pass.reset();
}

void clear_screen_space_target(WGPUCommandEncoder encoder, WGPUTextureView view) {
    DawnRenderPass pass{begin_screen_space_pass(encoder, view)};
    wgpuRenderPassEncoderEnd(pass);
    pass.reset();
}
#endif

} // namespace dawn_scene
} // namespace bbl::pal

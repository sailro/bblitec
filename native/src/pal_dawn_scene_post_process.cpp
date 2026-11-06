// Dawn post-process and screen-space passes. SDL_GPU's twin is
// pal_sdl_gpu_scene_post_process.cpp.
#include "pal_gpu_common.hpp"
#include "pal_gpu_targets.hpp"
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_post_process.hpp>
#include <bblite/features/has_screen_space.hpp>

#include "pal_dawn_scene.hpp"

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_SCREEN_SPACE
#include "pal_dawn_pinned_program.hpp"
#endif

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
    FrameTaskRecord& task = handle_at(engine.frame_tasks, handle);
    auto& pass = task.post_process.passes[index];
    auto& gpu = handle_at(state.post_process_tasks, handle)[index];
    if (!gpu.uniforms || (!force && !pass.uniforms_dirty))
        return;
    const auto& program = state.post_process_programs[gpu.program];
    const auto extent = resolve_post_process_extent(
        pal::resolve_render_target(engine, pass.output_target, pal::task_target_user(task)),
        state.render_targets, pass, width, height);
    std::vector<float> data(program.uniform_size / sizeof(float), 0.0f);
    upstream::write_post_process_uniforms(engine, pass, extent.output_width, extent.output_height,
                                          extent.source_width, extent.source_height, data.data());
    DawnGpuDevice{state.queue}.write_buffer(gpu.uniforms, 0, data.data(), program.uniform_size);
    pass.uniforms_dirty = false;
}

void encode_dawn_post_process_pass(WGPUCommandEncoder encoder, WGPUTextureView surface_view,
                                   const PreparedDawnPostProcessPass& prepared,
                                   const WGPUPassTimestampWrites* timestamps) {
    WGPURenderPassColorAttachment attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    attachment.view = prepared.presents ? surface_view : prepared.output;
    attachment.loadOp = prepared.clear ? WGPULoadOp_Clear : WGPULoadOp_Load;
    attachment.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor pass_descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    pass_descriptor.colorAttachmentCount = 1;
    pass_descriptor.colorAttachments = &attachment;
    pass_descriptor.timestampWrites = timestamps;
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
    // The pin's own bind group layout, entry for entry, every binding
    // fragment-visible.
    program.group_layout = create_dawn_pinned_group_layout(
        state.device, info.bindings, WGPUShaderStage_Fragment, "screen-space bind group layout");
    program.pipeline_layout = create_dawn_pinned_pipeline_layout(state.device, program.group_layout,
                                                                 "screen-space pipeline layout");
    // Single-sample, unblended, a triangle list: `ensureProducerPipeline`.
    const WGPUTextureFormat target = texture_format(info.target_format);
    program.pipeline = create_dawn_fullscreen_pipeline(
        state.device, program.pipeline_layout, program.module, info.vertex_entry,
        info.fragment_entry, {}, std::span(&target, 1), "screen-space render pipeline");
    return program;
}

std::size_t screen_space_program(DawnState& state, std::uint32_t stage) {
    return find_or_create_program(
        state.screen_space_programs,
        [&](const DawnScreenSpaceProgram& program) { return program.stage == stage; },
        [&] { return build_screen_space_program(state, stage); });
}

WGPUTextureView screen_space_binding_view(DawnState& state, const Engine& engine,
                                          const ScreenSpaceTaskOptions& task,
                                          upstream::ScreenSpaceTextureRef texture) {
    const pal::TargetUser user{"Screen-space task", task.name};
    const DawnRenderTarget& target = pal::resolve_gpu_target(
        engine, state.render_targets, pal::screen_space_target(task, texture), user);
    return texture.role == upstream::ScreenSpaceTextureRole::depth ? target.depth_sampled_view
                                                                   : target.sampled_color_view;
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

void record_screen_space_stage(DawnState& state, const Engine& engine,
                               const ScreenSpaceTaskOptions& task, DawnScreenSpaceStage& stage,
                               const upstream::ScreenSpacePassInfo& pass,
                               WGPUCommandEncoder encoder, const float* uniforms) {
    if (stage.program == npos) {
        stage.program = screen_space_program(state, pass.stage);
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
    DawnGpuDevice{state.queue}.write_buffer(stage.uniforms, 0, uniforms, info.uniform_bytes);
    if (!stage.group) {
        std::vector<WGPUBindGroupEntry> entries;
        for (std::size_t index = 0; index < info.bindings.size(); ++index) {
            const PinnedLayoutEntry& binding = info.bindings[index];
            WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
            entry.binding = binding.binding;
            if (!binding.sample_type.empty()) {
                entry.textureView =
                    screen_space_binding_view(state, engine, task, pass.textures[index]);
            } else if (!binding.sampler_type.empty()) {
                // The pin's one bilinear sampler wherever it samples.
                entry.sampler = state.post_process_bilinear_sampler;
            } else {
                entry.buffer = stage.uniforms;
                entry.size = info.uniform_bytes;
            }
            entries.push_back(entry);
        }
        WGPUBindGroupDescriptor group_descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        group_descriptor.layout = program.group_layout;
        group_descriptor.entryCount = entries.size();
        group_descriptor.entries = entries.data();
        stage.group = wgpuDeviceCreateBindGroup(state.device, &group_descriptor);
    }
    const DawnRenderTarget& target = pal::resolve_gpu_target(
        engine, state.render_targets, pal::screen_space_target(task, pass.target),
        pal::TargetUser{"Screen-space task", task.name});
    DawnRenderPass encoded{begin_screen_space_pass(encoder, target.color_view)};
    wgpuRenderPassEncoderSetPipeline(encoded, program.pipeline);
    wgpuRenderPassEncoderSetBindGroup(encoded, 0, stage.group, 0, nullptr);
    count_gpu_draw(wgpuRenderPassEncoderDraw, encoded, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(encoded);
    encoded.reset();
}

void clear_screen_space_target(WGPUCommandEncoder encoder, WGPUTextureView view) {
    DawnRenderPass pass{begin_screen_space_pass(encoder, view)};
    wgpuRenderPassEncoderEnd(pass);
    pass.reset();
}
#endif

} // namespace dawn_scene
} // namespace bbl::pal

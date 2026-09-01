// Dawn driver for a standalone FrameGraphContext. It records only the tasks
// the context owns and therefore carries no scene/camera/mesh renderer.
#include <bblite/pal.hpp>
#include <bblite/pal_gpu.hpp>
#include <bblite/runtime.hpp>
#if BBLITE_HAS_POST_PROCESS
#include <bblite/upstream/frame_graph_post_process.hpp>
#include <bblite/upstream/post_process_shaders.hpp>
#endif

#include <algorithm>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

#if BBLITE_HAS_EFFECT_TASK
#include "pal_dawn_effect.hpp"
#endif
#include "pal_platform_events.hpp"
#include "pal_dawn_shared.hpp"
#include "pal_gpu_shared.hpp"
#include "pal_render_capture.hpp"

namespace bbl::pal {

#if defined(BBLITE_HAS_FRAME_GRAPH_RENDERER) && \
    BBLITE_HAS_FRAME_GRAPH_RENDERER && BBLITE_HAS_DAWN

namespace {

struct Target {
    WGPUTexture color = nullptr;
    WGPUTextureView view = nullptr;
    WGPUTexture sampled = nullptr;
    WGPUTextureView sampled_view = nullptr;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    WGPUTextureFormat format = WGPUTextureFormat_Undefined;
};

#if BBLITE_HAS_POST_PROCESS
struct PostProcessProgram {
    std::uint32_t module = 0;
    WGPUTextureFormat format = WGPUTextureFormat_Undefined;
    std::uint32_t samples = 1;
    std::uint32_t alpha_mode = 0;
    std::size_t extra_textures = 0;
    std::uint32_t uniform_binding = 0;
    std::uint32_t uniform_size = 0;
    WGPUShaderModule shader = nullptr;
    WGPUBindGroupLayout group_layout = nullptr;
    WGPUPipelineLayout pipeline_layout = nullptr;
    WGPURenderPipeline pipeline = nullptr;
};

struct PostProcessPass {
    std::size_t program = std::numeric_limits<std::size_t>::max();
    WGPUBindGroup group = nullptr;
    WGPUBuffer uniforms = nullptr;
};
#endif

struct State : DawnDevice {
    std::uint32_t samples = 1;
    std::vector<Target> targets;
#if BBLITE_HAS_EFFECT_TASK
    std::vector<DawnEffectPass> effects;
#endif
#if BBLITE_HAS_POST_PROCESS
    std::vector<std::vector<PostProcessPass>> post_processes;
    std::vector<PostProcessProgram> programs;
    WGPUSampler linear_sampler = nullptr;
    WGPUSampler nearest_sampler = nullptr;
#endif
    std::uint32_t width = 0;
    std::uint32_t height = 0;
};

WGPUTextureFormat texture_format(TextureFormatClass format) {
    switch (format) {
        case TextureFormatClass::rgba8_unorm:
            return WGPUTextureFormat_RGBA8Unorm;
        case TextureFormatClass::r16_float:
            return WGPUTextureFormat_R16Float;
        case TextureFormatClass::r32_float:
            return WGPUTextureFormat_R32Float;
        case TextureFormatClass::rgba16_float:
            return WGPUTextureFormat_RGBA16Float;
    }
    return WGPUTextureFormat_RGBA16Float;
}

std::uint32_t target_samples(const State& state, std::uint32_t requested) {
    return requested == 4 ? state.samples : 1u;
}

WGPUTexture create_texture(
    State& state,
    WGPUTextureFormat format,
    std::uint32_t samples,
    std::uint32_t width,
    std::uint32_t height,
    WGPUTextureUsage usage) {
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage = usage;
    descriptor.size = {width, height, 1};
    descriptor.format = format;
    descriptor.sampleCount = samples;
    WGPUTexture texture =
        wgpuDeviceCreateTexture(state.device, &descriptor);
    if (!texture) dawn_error("frame-graph texture creation failed.");
    return texture;
}

void release_graph(State& state) {
#if BBLITE_HAS_EFFECT_TASK
    for (DawnEffectPass& pass : state.effects) {
        release_dawn_effect_pass(pass);
    }
    state.effects.clear();
#endif
    for (Target& target : state.targets) {
        if (target.sampled_view && target.sampled_view != target.view) {
            wgpuTextureViewRelease(target.sampled_view);
        }
        if (target.sampled && target.sampled != target.color) {
            wgpuTextureRelease(target.sampled);
        }
        if (target.view) wgpuTextureViewRelease(target.view);
        if (target.color) wgpuTextureRelease(target.color);
    }
    state.targets.clear();
#if BBLITE_HAS_POST_PROCESS
    for (std::vector<PostProcessPass>& task : state.post_processes) {
        for (PostProcessPass& pass : task) {
            if (pass.group) wgpuBindGroupRelease(pass.group);
            if (pass.uniforms) wgpuBufferRelease(pass.uniforms);
        }
    }
    state.post_processes.clear();
    for (PostProcessProgram& program : state.programs) {
        if (program.pipeline) wgpuRenderPipelineRelease(program.pipeline);
        if (program.pipeline_layout) {
            wgpuPipelineLayoutRelease(program.pipeline_layout);
        }
        if (program.group_layout) {
            wgpuBindGroupLayoutRelease(program.group_layout);
        }
        if (program.shader) wgpuShaderModuleRelease(program.shader);
    }
    state.programs.clear();
#endif
    state.width = 0;
    state.height = 0;
}

void release(State& state) {
    release_graph(state);
#if BBLITE_HAS_POST_PROCESS
    if (state.linear_sampler) wgpuSamplerRelease(state.linear_sampler);
    if (state.nearest_sampler) wgpuSamplerRelease(state.nearest_sampler);
#endif
    if (state.queue) wgpuQueueRelease(state.queue);
    if (state.device) wgpuDeviceRelease(state.device);
    if (state.adapter) wgpuAdapterRelease(state.adapter);
    if (state.surface) wgpuSurfaceRelease(state.surface);
    if (state.instance) wgpuInstanceRelease(state.instance);
    if (state.window) SDL_DestroyWindow(state.window);
    SDL_Quit();
}

void build_graph(
    State& state,
    const Engine& engine,
    std::uint32_t width,
    std::uint32_t height) {
    if (
        state.targets.size() == engine.render_targets.size() &&
        state.width == width && state.height == height) {
        return;
    }
    release_graph(state);
    state.width = width;
    state.height = height;
    state.targets.resize(engine.render_targets.size());
    for (std::size_t index = 0; index < engine.render_targets.size(); ++index) {
        const RenderTargetRecord& record = engine.render_targets[index];
        Target& target = state.targets[index];
        target.width = record.width > 0 ? record.width : width;
        target.height = record.height > 0 ? record.height : height;
        if (record.scale_source.value != invalid_handle) {
            const Target& source = state.targets.at(record.scale_source.value);
            target.width = scaled_target_extent(source.width, record.width_ratio);
            target.height = scaled_target_extent(source.height, record.height_ratio);
        }
        if (record.swapchain) {
            target.format = state.surface_format;
            continue;
        }
        target.format = record.has_format
            ? texture_format(record.format)
            : record.scale_source.value != invalid_handle
                ? state.targets.at(record.scale_source.value).format
                : state.surface_format;
        if (!record.has_color) {
            throw std::runtime_error(
                "Standalone frame graphs currently require color targets.");
        }
        const std::uint32_t samples = target_samples(state, record.samples);
        target.color = create_texture(
            state,
            target.format,
            samples,
            target.width,
            target.height,
            samples == 1
                ? WGPUTextureUsage_RenderAttachment |
                    WGPUTextureUsage_TextureBinding |
                    WGPUTextureUsage_CopySrc
                : WGPUTextureUsage_RenderAttachment);
        target.view = wgpuTextureCreateView(target.color, nullptr);
        if (samples == 1) {
            target.sampled = target.color;
            target.sampled_view = target.view;
        } else {
            target.sampled = create_texture(
                state,
                target.format,
                1,
                target.width,
                target.height,
                WGPUTextureUsage_RenderAttachment |
                    WGPUTextureUsage_TextureBinding |
                    WGPUTextureUsage_CopySrc);
            target.sampled_view =
                wgpuTextureCreateView(target.sampled, nullptr);
        }
    }
#if BBLITE_HAS_EFFECT_TASK
    state.effects.resize(engine.frame_tasks.size());
#endif
#if BBLITE_HAS_POST_PROCESS
    state.post_processes.resize(engine.frame_tasks.size());
    for (std::size_t index = 0; index < engine.frame_tasks.size(); ++index) {
        const FrameTaskRecord& task = engine.frame_tasks[index];
        if (task.kind == FrameTaskKind::post_process) {
            state.post_processes[index].resize(task.post_process.passes.size());
        }
    }
#endif
}

#if BBLITE_HAS_POST_PROCESS
std::pair<WGPUTexture, WGPUTextureView> source_view(
    State& state,
    const Engine& engine,
    const RenderTextureRef& source) {
    if (source.source != RenderTextureSource::render_target) {
        throw std::runtime_error(
            "A standalone frame graph cannot sample a scene geometry task.");
    }
    const RenderTargetRecord& record = engine.render_targets.at(source.target.value);
    if (record.swapchain) {
        throw std::runtime_error(
            "A post-process pass cannot sample the swapchain target.");
    }
    const Target& target = state.targets.at(source.target.value);
    return {target.sampled, target.sampled_view};
}

std::size_t post_process_program(
    State& state,
    const upstream::PostProcessShaderInfo& info,
    WGPUTextureFormat format,
    std::uint32_t samples,
    std::uint32_t alpha_mode,
    std::size_t extras) {
    const std::uint32_t uniform_size =
        (info.uniform_byte_length + 15u) & ~15u;
    for (std::size_t index = 0; index < state.programs.size(); ++index) {
        const PostProcessProgram& found = state.programs[index];
        if (
            found.module == info.module_index && found.format == format &&
            found.samples == samples && found.alpha_mode == alpha_mode &&
            found.extra_textures == extras &&
            found.uniform_binding == info.uniform_binding &&
            found.uniform_size == uniform_size) {
            return index;
        }
    }
    PostProcessProgram program;
    program.module = info.module_index;
    program.format = format;
    program.samples = samples;
    program.alpha_mode = alpha_mode;
    program.extra_textures = extras;
    program.uniform_binding = info.uniform_binding;
    program.uniform_size = uniform_size;
    program.shader = load_wgsl_module(
        state.device,
        "postprocess-" + std::to_string(info.module_index) + ".frag");
    std::vector<WGPUBindGroupLayoutEntry> entries;
    WGPUBindGroupLayoutEntry sampler = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    sampler.binding = 0;
    sampler.visibility = WGPUShaderStage_Fragment;
    sampler.sampler.type = WGPUSamplerBindingType_Filtering;
    entries.push_back(sampler);
    for (std::size_t texture = 0; texture <= extras; ++texture) {
        WGPUBindGroupLayoutEntry entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        entry.binding = 1u + static_cast<std::uint32_t>(texture);
        entry.visibility = WGPUShaderStage_Fragment;
        entry.texture.sampleType = WGPUTextureSampleType_Float;
        entry.texture.viewDimension = WGPUTextureViewDimension_2D;
        entries.push_back(entry);
    }
    if (uniform_size > 0) {
        WGPUBindGroupLayoutEntry uniform = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        uniform.binding = info.uniform_binding;
        uniform.visibility = WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
        uniform.buffer.type = WGPUBufferBindingType_Uniform;
        entries.push_back(uniform);
    }
    WGPUBindGroupLayoutDescriptor group =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    group.entryCount = entries.size();
    group.entries = entries.data();
    program.group_layout =
        wgpuDeviceCreateBindGroupLayout(state.device, &group);
    WGPUPipelineLayoutDescriptor layout =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    layout.bindGroupLayoutCount = 1;
    layout.bindGroupLayouts = &program.group_layout;
    program.pipeline_layout =
        wgpuDeviceCreatePipelineLayout(state.device, &layout);
    const upstream::PostProcessBlend blend =
        upstream::post_process_blend(alpha_mode);
    const WGPUBlendState blend_state = blend_state_from(blend.factors);
    WGPUColorTargetState color = WGPU_COLOR_TARGET_STATE_INIT;
    color.format = format;
    if (blend.enabled) color.blend = &blend_state;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = program.shader;
    fragment.entryPoint = string_view("postProcessFragment");
    fragment.targetCount = 1;
    fragment.targets = &color;
    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = program.pipeline_layout;
    descriptor.vertex.module = program.shader;
    descriptor.vertex.entryPoint = string_view("postProcessVertex");
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.cullMode = WGPUCullMode_None;
    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    descriptor.fragment = &fragment;
    program.pipeline =
        wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
    if (!program.pipeline) {
        dawn_error("post-process pipeline creation failed.");
    }
    state.programs.push_back(program);
    return state.programs.size() - 1;
}

void record_post_process(
    State& state,
    Engine& engine,
    TaskHandle task_handle,
    std::size_t pass_index,
    WGPUCommandEncoder encoder,
    WGPUTextureView surface_view,
    std::uint32_t width,
    std::uint32_t height) {
    PostProcessPassOptions& pass = engine.frame_tasks.at(task_handle.value)
        .post_process.passes.at(pass_index);
    const upstream::PostProcessShaderInfo& info =
        upstream::post_process_shader_infos.at(pass.shader_index);
    PostProcessPass& gpu =
        state.post_processes.at(task_handle.value).at(pass_index);
    const RenderTargetRecord& output_record =
        engine.render_targets.at(pass.output_target.value);
    const Target& output = state.targets.at(pass.output_target.value);
    const std::uint32_t output_width = output_record.swapchain
        ? width : output.width;
    const std::uint32_t output_height = output_record.swapchain
        ? height : output.height;
    std::uint32_t source_width = output_width;
    std::uint32_t source_height = output_height;
    if (pass.source.source == RenderTextureSource::render_target) {
        const Target& source = state.targets.at(pass.source.target.value);
        source_width = source.width;
        source_height = source.height;
    }
    if (gpu.program == std::numeric_limits<std::size_t>::max()) {
        gpu.program = post_process_program(
            state,
            info,
            output.format,
            output_record.swapchain
                ? 1u
                : target_samples(state, output_record.samples),
            pass.alpha_mode,
            pass.extra_textures.size());
        const PostProcessProgram& program = state.programs[gpu.program];
        if (program.uniform_size > 0) {
            WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
            descriptor.size = program.uniform_size;
            descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
            gpu.uniforms = wgpuDeviceCreateBuffer(state.device, &descriptor);
        }
        std::vector<WGPUBindGroupEntry> entries;
        WGPUBindGroupEntry sampler = WGPU_BIND_GROUP_ENTRY_INIT;
        sampler.binding = 0;
        sampler.sampler = pass.sampling == PostProcessSampling::nearest
            ? state.nearest_sampler
            : state.linear_sampler;
        entries.push_back(sampler);
        WGPUBindGroupEntry source = WGPU_BIND_GROUP_ENTRY_INIT;
        source.binding = 1;
        source.textureView = source_view(state, engine, pass.source).second;
        entries.push_back(source);
        for (std::size_t index = 0; index < pass.extra_textures.size(); ++index) {
            WGPUBindGroupEntry extra = WGPU_BIND_GROUP_ENTRY_INIT;
            extra.binding = 2u + static_cast<std::uint32_t>(index);
            extra.textureView =
                source_view(state, engine, pass.extra_textures[index]).second;
            entries.push_back(extra);
        }
        if (gpu.uniforms) {
            WGPUBindGroupEntry uniform = WGPU_BIND_GROUP_ENTRY_INIT;
            uniform.binding = info.uniform_binding;
            uniform.buffer = gpu.uniforms;
            uniform.size = program.uniform_size;
            entries.push_back(uniform);
        }
        WGPUBindGroupDescriptor descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        descriptor.layout = program.group_layout;
        descriptor.entryCount = entries.size();
        descriptor.entries = entries.data();
        gpu.group = wgpuDeviceCreateBindGroup(state.device, &descriptor);
        pass.uniforms_dirty = true;
    }
    const PostProcessProgram& program = state.programs[gpu.program];
    if (gpu.uniforms && pass.uniforms_dirty) {
        std::vector<float> data(program.uniform_size / 4u, 0.0f);
        upstream::write_post_process_uniforms(
            engine,
            pass,
            output_width,
            output_height,
            source_width,
            source_height,
            data.data());
        wgpuQueueWriteBuffer(
            state.queue, gpu.uniforms, 0, data.data(), program.uniform_size);
        pass.uniforms_dirty = false;
    }
    WGPURenderPassColorAttachment attachment =
        WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    attachment.view = output_record.swapchain ? surface_view : output.view;
    attachment.loadOp = pass.clear ? WGPULoadOp_Clear : WGPULoadOp_Load;
    attachment.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor descriptor =
        WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    descriptor.colorAttachmentCount = 1;
    descriptor.colorAttachments = &attachment;
    WGPURenderPassEncoder render_pass =
        wgpuCommandEncoderBeginRenderPass(encoder, &descriptor);
    if (pass.has_viewport) {
        const PixelViewport rect = upstream::resolve_post_process_viewport(
            pass.viewport, output_width, output_height);
        wgpuRenderPassEncoderSetViewport(
            render_pass,
            static_cast<float>(rect.x),
            static_cast<float>(rect.y),
            static_cast<float>(rect.width),
            static_cast<float>(rect.height),
            0.0f,
            1.0f);
        wgpuRenderPassEncoderSetScissorRect(
            render_pass,
            static_cast<std::uint32_t>(rect.x),
            static_cast<std::uint32_t>(rect.y),
            static_cast<std::uint32_t>(rect.width),
            static_cast<std::uint32_t>(rect.height));
    }
    wgpuRenderPassEncoderSetPipeline(render_pass, program.pipeline);
    wgpuRenderPassEncoderSetBindGroup(render_pass, 0, gpu.group, 0, nullptr);
    wgpuRenderPassEncoderDraw(render_pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(render_pass);
    wgpuRenderPassEncoderRelease(render_pass);
}
#endif

} // namespace

bool run_frame_graph_dawn_engine(Engine& engine) {
    const FrameOptions options = read_frame_options();
    reject_unsupported_frame_options(
        options,
        "Dawn frame graph",
        /*supports_single_sample=*/true,
        /*supports_copy_task=*/false);
    if (engine.registered_frame_graph_contexts.empty()) {
        throw std::runtime_error(
            "Frame-graph renderer requires a registered context.");
    }
    FrameGraphContext& context =
        *engine.registered_frame_graph_contexts.front();
    State state;
    state.samples = options.single_sample
        ? 1u
        : upstream::preferred_sample_count();
    try {
        DawnDeviceOptions device_options;
        device_options.hidden_test_pass = options.test_pass;
        device_options.immediate_present = options.benchmark_requested;
        create_dawn_device(engine.options, device_options, state);
        sync_engine_canvas_size(state.window, engine);
        resize_dawn_surface(state, engine.options);
#if BBLITE_HAS_POST_PROCESS
        WGPUSamplerDescriptor sampler = WGPU_SAMPLER_DESCRIPTOR_INIT;
        sampler.addressModeU = WGPUAddressMode_ClampToEdge;
        sampler.addressModeV = WGPUAddressMode_ClampToEdge;
        sampler.addressModeW = WGPUAddressMode_ClampToEdge;
        sampler.minFilter = WGPUFilterMode_Linear;
        sampler.magFilter = WGPUFilterMode_Linear;
        state.linear_sampler = wgpuDeviceCreateSampler(state.device, &sampler);
        sampler.minFilter = WGPUFilterMode_Nearest;
        sampler.magFilter = WGPUFilterMode_Nearest;
        state.nearest_sampler = wgpuDeviceCreateSampler(state.device, &sampler);
        if (!state.linear_sampler || !state.nearest_sampler) {
            dawn_error("frame-graph sampler creation failed.");
        }
#endif
        std::uint32_t width = state.surface_width;
        std::uint32_t height = state.surface_height;
        if (width == 0 || height == 0) {
            dawn_error("frame-graph surface has a zero extent.");
        }
        build_graph(state, engine, width, height);

        const long limit = options.frame_budget();
        CaptureGate captures(options, limit, &engine);
        FrameClock clock;
        bool running = true;
        long frame = 0;
        PlatformInputReplay input_replay;
        while (captures.keep_running(running, frame)) {
            poll_platform_events(engine, running, options.test_pass);
            input_replay.dispatch(frame, state.window, engine);
            sync_engine_canvas_size(state.window, engine);
            if (resize_dawn_surface(state, engine.options)) {
                width = state.surface_width;
                height = state.surface_height;
                build_graph(state, engine, width, height);
            }
            (void)advance_frame(
                engine,
                context,
                clock,
                options.frame_delta_ms);
            WGPUSurfaceTexture surface_texture{};
            wgpuSurfaceGetCurrentTexture(state.surface, &surface_texture);
            if (!surface_texture.texture) continue;
            WGPUTextureView surface_view =
                wgpuTextureCreateView(surface_texture.texture, nullptr);
            WGPUCommandEncoder encoder =
                wgpuDeviceCreateCommandEncoder(state.device, nullptr);
            for (const TaskHandle handle : context.tasks) {
                FrameTaskRecord& task = engine.frame_tasks.at(handle.value);
#if BBLITE_HAS_EFFECT_TASK
                if (task.kind == FrameTaskKind::effect) {
                    DawnEffectPass& pass = state.effects.at(handle.value);
                    const RenderTargetRecord& record =
                        engine.render_targets.at(task.effect.target.value);
                    const Target& output = state.targets.at(task.effect.target.value);
                    if (!pass.pipeline) {
                        pass = create_dawn_effect_pass(
                            state,
                            engine,
                            task.effect.effect,
                            output.format,
                            record.swapchain
                                ? 1u
                                : target_samples(state, record.samples));
                    }
                    upload_dawn_effect_pass(
                        state.queue,
                        engine,
                        pass,
                        task.effect.effect);
                    WGPURenderPassColorAttachment attachment =
                        WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
                    attachment.view = record.swapchain ? surface_view : output.view;
                    if (!record.swapchain && target_samples(state, record.samples) > 1) {
                        attachment.resolveTarget = output.sampled_view;
                    }
                    attachment.loadOp = task.effect.clear
                        ? WGPULoadOp_Clear
                        : WGPULoadOp_Load;
                    attachment.storeOp = WGPUStoreOp_Store;
                    attachment.clearValue = WGPUColor{
                        task.effect.clear_color.r,
                        task.effect.clear_color.g,
                        task.effect.clear_color.b,
                        task.effect.clear_color.a};
                    WGPURenderPassDescriptor descriptor =
                        WGPU_RENDER_PASS_DESCRIPTOR_INIT;
                    descriptor.colorAttachmentCount = 1;
                    descriptor.colorAttachments = &attachment;
                    WGPURenderPassEncoder render_pass =
                        wgpuCommandEncoderBeginRenderPass(encoder, &descriptor);
                    record_dawn_effect_pass(render_pass, pass);
                    wgpuRenderPassEncoderEnd(render_pass);
                    wgpuRenderPassEncoderRelease(render_pass);
                } else
#endif
#if BBLITE_HAS_POST_PROCESS
                if (task.kind == FrameTaskKind::post_process) {
                    for (std::size_t index = 0;
                         index < task.post_process.passes.size();
                         ++index) {
                        record_post_process(
                            state,
                            engine,
                            handle,
                            index,
                            encoder,
                            surface_view,
                            width,
                            height);
                    }
                } else
#endif
                {
                    throw std::runtime_error(
                        "Standalone frame graphs support effect and post-process tasks.");
                }
            }
            const bool capture_frame =
                frame >= options.screenshot_frame &&
                !captures.screenshot_saved &&
                !options.screenshot_path.empty();
            captures.maybe_write_standalone_render_capture(
                "dawn", engine, width, height, frame);
            DawnSurfaceCapture capture{};
            if (capture_frame) {
                capture = begin_dawn_surface_capture(
                    state.device,
                    encoder,
                    surface_texture.texture,
                    width,
                    height);
            }
            WGPUCommandBuffer command =
                wgpuCommandEncoderFinish(encoder, nullptr);
            wgpuQueueSubmit(state.queue, 1, &command);
            wgpuCommandBufferRelease(command);
            wgpuCommandEncoderRelease(encoder);
            if (capture_frame) {
                finish_dawn_surface_capture(
                    state,
                    capture,
                    width,
                    height,
                    options.screenshot_path);
                captures.screenshot_saved = true;
            }
            if (capture.readback) wgpuBufferRelease(capture.readback);
            wgpuSurfacePresent(state.surface);
            wgpuTextureViewRelease(surface_view);
            wgpuTextureRelease(surface_texture.texture);
            if (!state.uncaptured_error.empty()) {
                dawn_error(state.uncaptured_error);
            }
            finish_frame(engine);
            ++frame;
        }
    } catch (...) {
        release(state);
        throw;
    }
    release(state);
    return true;
}

#endif

} // namespace bbl::pal

// SDL_GPU driver for a standalone FrameGraphContext. The context owns only
// ordered render-target tasks, so this translation unit deliberately has no
// scene renderer, camera, mesh, material, or image-loader dependency.
#include <bblite/pal.hpp>
#include <bblite/pal_gpu.hpp>
#include <bblite/runtime.hpp>
#if BBLITE_HAS_POST_PROCESS
#include <bblite/upstream/frame_graph_post_process.hpp>
#include <bblite/upstream/post_process_shaders.hpp>
#endif

#include <algorithm>
#include <array>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

#include "pal_platform_events.hpp"
#include "pal_gpu_shared.hpp"
#include "pal_render_capture.hpp"
#if BBLITE_HAS_EFFECT_TASK
#include "pal_sdl_gpu_effect.hpp"
#endif
#include "pal_sdl_gpu_shared.hpp"

namespace bbl::pal {

#if defined(BBLITE_HAS_FRAME_GRAPH_RENDERER) && \
    BBLITE_HAS_FRAME_GRAPH_RENDERER && BBLITE_HAS_SDL_GPU

namespace {

struct Target {
    SDL_GPUTexture* color = nullptr;
    SDL_GPUTexture* sampled = nullptr;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    SDL_GPUTextureFormat format = SDL_GPU_TEXTUREFORMAT_INVALID;
};

#if BBLITE_HAS_POST_PROCESS
struct PostProcessProgram {
    std::uint32_t module = 0;
    SDL_GPUTextureFormat format = SDL_GPU_TEXTUREFORMAT_INVALID;
    SDL_GPUSampleCount samples = SDL_GPU_SAMPLECOUNT_1;
    std::uint32_t alpha_mode = 0;
    SDL_GPUGraphicsPipeline* pipeline = nullptr;
    PinnedStageSlots vertex_slots;
    PinnedStageSlots fragment_slots;
};

struct PostProcessPass {
    std::size_t program = npos;
    std::vector<int> texture_sources;
    std::vector<float> uniforms;
};
#endif

struct State {
    SdlGpuDevice gpu;
    SDL_GPUSampleCount samples = SDL_GPU_SAMPLECOUNT_1;
    std::vector<Target> targets;
#if BBLITE_HAS_EFFECT_TASK
    std::vector<EffectPass> effects;
#endif
#if BBLITE_HAS_POST_PROCESS
    std::vector<std::vector<PostProcessPass>> post_processes;
    std::vector<PostProcessProgram> programs;
    SDL_GPUSampler* linear_sampler = nullptr;
    SDL_GPUSampler* nearest_sampler = nullptr;
    SDL_GPUTexture* present_copy = nullptr;
#endif
    std::uint32_t width = 0;
    std::uint32_t height = 0;
};

SDL_GPUTextureFormat texture_format(TextureFormatClass format) {
    switch (format) {
        case TextureFormatClass::rgba8_unorm:
            return SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
        case TextureFormatClass::r16_float:
            return SDL_GPU_TEXTUREFORMAT_R16_FLOAT;
        case TextureFormatClass::r32_float:
            return SDL_GPU_TEXTUREFORMAT_R32_FLOAT;
        case TextureFormatClass::rgba16_float:
            return SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
    }
    return SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
}

SDL_GPUSampleCount target_samples(
    const State& state,
    std::uint32_t requested) {
    return requested == 4 ? state.samples : SDL_GPU_SAMPLECOUNT_1;
}

SDL_GPUTexture* create_texture(
    State& state,
    SDL_GPUTextureFormat format,
    SDL_GPUSampleCount samples,
    std::uint32_t width,
    std::uint32_t height,
    SDL_GPUTextureUsageFlags usage) {
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = format;
    info.usage = usage;
    info.width = width;
    info.height = height;
    info.layer_count_or_depth = 1;
    info.num_levels = 1;
    info.sample_count = samples;
    SDL_GPUTexture* result = SDL_CreateGPUTexture(state.gpu.device, &info);
    if (!result) gpu_error("SDL_CreateGPUTexture frame graph");
    return result;
}

void release_graph(State& state) {
#if BBLITE_HAS_EFFECT_TASK
    for (EffectPass& pass : state.effects) {
        release_effect_pass(state.gpu.device, pass);
    }
    state.effects.clear();
#endif
    for (Target& target : state.targets) {
        if (target.sampled && target.sampled != target.color) {
            SDL_ReleaseGPUTexture(state.gpu.device, target.sampled);
        }
        if (target.color) SDL_ReleaseGPUTexture(state.gpu.device, target.color);
    }
    state.targets.clear();
#if BBLITE_HAS_POST_PROCESS
    for (PostProcessProgram& program : state.programs) {
        if (program.pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(state.gpu.device, program.pipeline);
        }
    }
    state.programs.clear();
    state.post_processes.clear();
    if (state.present_copy) {
        SDL_ReleaseGPUTexture(state.gpu.device, state.present_copy);
        state.present_copy = nullptr;
    }
#endif
    state.width = 0;
    state.height = 0;
}

void release(State& state) {
    release_graph(state);
#if BBLITE_HAS_POST_PROCESS
    if (state.linear_sampler) {
        SDL_ReleaseGPUSampler(state.gpu.device, state.linear_sampler);
    }
    if (state.nearest_sampler) {
        SDL_ReleaseGPUSampler(state.gpu.device, state.nearest_sampler);
    }
#endif
    if (state.gpu.window && state.gpu.device) {
        SDL_ReleaseWindowFromGPUDevice(state.gpu.device, state.gpu.window);
    }
    if (state.gpu.device) SDL_DestroyGPUDevice(state.gpu.device);
    if (state.gpu.window) release_run_window(state.gpu.window);
    quit_run_sdl();
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
            target.format = state.gpu.swapchain_format;
            continue;
        }
        target.format = record.has_format
            ? texture_format(record.format)
            : record.scale_source.value != invalid_handle
                ? state.targets.at(record.scale_source.value).format
                : state.gpu.swapchain_format;
        if (!record.has_color) {
            throw std::runtime_error(
                "Standalone frame graphs currently require color targets.");
        }
        const SDL_GPUSampleCount samples = target_samples(state, record.samples);
        target.color = create_texture(
            state,
            target.format,
            samples,
            target.width,
            target.height,
            SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
                (samples == SDL_GPU_SAMPLECOUNT_1
                    ? SDL_GPU_TEXTUREUSAGE_SAMPLER
                    : 0));
        target.sampled = samples == SDL_GPU_SAMPLECOUNT_1
            ? target.color
            : create_texture(
                state,
                target.format,
                SDL_GPU_SAMPLECOUNT_1,
                target.width,
                target.height,
                SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
                    SDL_GPU_TEXTUREUSAGE_SAMPLER);
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

SDL_GPUTexture* target_texture(
    State& state,
    const Engine& engine,
    RenderTargetHandle handle,
    SDL_GPUTexture* swapchain,
    bool sampled) {
    const RenderTargetRecord& record = engine.render_targets.at(handle.value);
    if (record.swapchain) return swapchain;
    const Target& target = state.targets.at(handle.value);
    return sampled ? target.sampled : target.color;
}

#if BBLITE_HAS_POST_PROCESS
SDL_GPUTexture* source_texture(
    State& state,
    const Engine& engine,
    const RenderTextureRef& source,
    SDL_GPUTexture* swapchain) {
    if (source.source != RenderTextureSource::render_target) {
        throw std::runtime_error(
            "A standalone frame graph cannot sample a scene geometry task.");
    }
    const RenderTargetRecord& record =
        engine.render_targets.at(source.target.value);
    if (record.swapchain) {
        throw std::runtime_error(
            "A post-process pass cannot sample the swapchain target.");
    }
    return target_texture(state, engine, source.target, swapchain, true);
}

/** Builds the entry `post_process_program` below found missing. */
PostProcessProgram build_post_process_program(
    State& state,
    std::uint32_t module,
    SDL_GPUTextureFormat format,
    SDL_GPUSampleCount samples,
    std::uint32_t alpha_mode) {
    PostProcessProgram program;
    program.module = module;
    program.format = format;
    program.samples = samples;
    program.alpha_mode = alpha_mode;
    const std::string stem = "postprocess-" + std::to_string(module);
    const std::string vertex_name = stem + ".vert";
    const std::string fragment_name = stem + ".frag";
    program.vertex_slots = read_pinned_stage_slots(vertex_name);
    program.fragment_slots = read_pinned_stage_slots(fragment_name);
    SDL_GPUShader* vertex = load_shader(
        state.gpu.device,
        vertex_name.c_str(),
        SDL_GPU_SHADERSTAGE_VERTEX,
        static_cast<Uint32>(program.vertex_slots.textures.size()),
        static_cast<Uint32>(program.vertex_slots.uniforms.size()),
        "postProcessVertex");
    SDL_GPUShader* fragment = load_shader(
        state.gpu.device,
        fragment_name.c_str(),
        SDL_GPU_SHADERSTAGE_FRAGMENT,
        static_cast<Uint32>(program.fragment_slots.textures.size()),
        static_cast<Uint32>(program.fragment_slots.uniforms.size()),
        "postProcessFragment");
    const upstream::PostProcessBlend blend =
        upstream::post_process_blend(alpha_mode);
    SDL_GPUColorTargetDescription target{};
    target.format = format;
    if (blend.enabled) target.blend_state = blend_state_from(blend.factors);
    SDL_GPUGraphicsPipelineCreateInfo info{};
    info.vertex_shader = vertex;
    info.fragment_shader = fragment;
    info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
    info.multisample_state.sample_count = samples;
    info.target_info.color_target_descriptions = &target;
    info.target_info.num_color_targets = 1;
    program.pipeline = SDL_CreateGPUGraphicsPipeline(state.gpu.device, &info);
    SDL_ReleaseGPUShader(state.gpu.device, vertex);
    SDL_ReleaseGPUShader(state.gpu.device, fragment);
    if (!program.pipeline) {
        gpu_error("SDL_CreateGPUGraphicsPipeline post-process");
    }
    return program;
}

// The find-or-create walk is the shared `find_or_create_program`; only
// the key equality is this driver's.
std::size_t post_process_program(
    State& state,
    std::uint32_t module,
    SDL_GPUTextureFormat format,
    SDL_GPUSampleCount samples,
    std::uint32_t alpha_mode) {
    return find_or_create_program(
        state.programs,
        [&](const PostProcessProgram& found) {
            return found.module == module && found.format == format &&
                found.samples == samples && found.alpha_mode == alpha_mode;
        },
        [&] {
            return build_post_process_program(
                state, module, format, samples, alpha_mode);
        });
}

void record_post_process(
    State& state,
    Engine& engine,
    TaskHandle task_handle,
    std::size_t pass_index,
    SDL_GPUCommandBuffer* command,
    SDL_GPUTexture* swapchain,
    std::uint32_t width,
    std::uint32_t height,
    SDL_GPUTexture*& capture_texture) {
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
    const bool presents = output_record.swapchain;
    if (presents && !state.present_copy) {
        state.present_copy = create_texture(
            state,
            state.gpu.swapchain_format,
            SDL_GPU_SAMPLECOUNT_1,
            width,
            height,
            SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
                SDL_GPU_TEXTUREUSAGE_SAMPLER);
    }
    if (gpu.program == npos) {
        gpu.program = post_process_program(
            state,
            info.module_index,
            output.format,
            presents ? SDL_GPU_SAMPLECOUNT_1
                     : target_samples(state, output_record.samples),
            pass.alpha_mode);
        gpu.uniforms.assign(
            ((info.uniform_byte_length + 15u) & ~15u) / 4u,
            0.0f);
        const PostProcessProgram& program = state.programs[gpu.program];
        std::size_t extra = 0;
        for (const std::string& name : program.fragment_slots.textures) {
            if (name == "sourceTextureSampler") {
                gpu.texture_sources.push_back(-1);
            } else if (extra < pass.extra_textures.size()) {
                gpu.texture_sources.push_back(static_cast<int>(extra++));
            } else {
                throw std::runtime_error(
                    "Post-process stage declares a texture the pass does not carry: " +
                    name);
            }
        }
    }
    const PostProcessProgram& program = state.programs[gpu.program];
    if (!gpu.uniforms.empty()) {
        std::fill(gpu.uniforms.begin(), gpu.uniforms.end(), 0.0f);
        upstream::write_post_process_uniforms(
            engine,
            pass,
            output_width,
            output_height,
            source_width,
            source_height,
            gpu.uniforms.data());
        const Uint32 bytes = static_cast<Uint32>(
            gpu.uniforms.size() * sizeof(float));
        if (!program.vertex_slots.uniforms.empty()) {
            SDL_PushGPUVertexUniformData(
                command, 0, gpu.uniforms.data(), bytes);
        }
        if (!program.fragment_slots.uniforms.empty()) {
            SDL_PushGPUFragmentUniformData(
                command, 0, gpu.uniforms.data(), bytes);
        }
    }
    SDL_GPUColorTargetInfo target{};
    target.texture = presents
        ? state.present_copy
        : target_texture(
            state, engine, pass.output_target, swapchain, false);
    target.load_op = pass.clear ? SDL_GPU_LOADOP_CLEAR : SDL_GPU_LOADOP_LOAD;
    target.clear_color = SDL_FColor{0.0f, 0.0f, 0.0f, 0.0f};
    target.store_op = SDL_GPU_STOREOP_STORE;
    SDL_GPURenderPass* render_pass =
        SDL_BeginGPURenderPass(command, &target, 1, nullptr);
    SDL_BindGPUGraphicsPipeline(render_pass, program.pipeline);
    if (pass.has_viewport) {
        const PixelViewport rect = upstream::resolve_post_process_viewport(
            pass.viewport, output_width, output_height);
        const SDL_GPUViewport viewport{
            static_cast<float>(rect.x),
            static_cast<float>(rect.y),
            static_cast<float>(rect.width),
            static_cast<float>(rect.height),
            0.0f,
            1.0f};
        SDL_SetGPUViewport(render_pass, &viewport);
        const SDL_Rect scissor{rect.x, rect.y, rect.width, rect.height};
        SDL_SetGPUScissor(render_pass, &scissor);
    }
    if (gpu.texture_sources.size() > 8) {
        throw std::runtime_error("A post-process pass exceeds 8 textures.");
    }
    std::array<SDL_GPUTextureSamplerBinding, 8> bindings{};
    SDL_GPUSampler* sampler = pass.sampling == PostProcessSampling::nearest
        ? state.nearest_sampler
        : state.linear_sampler;
    for (std::size_t slot = 0; slot < gpu.texture_sources.size(); ++slot) {
        const int source = gpu.texture_sources[slot];
        bindings[slot] = SDL_GPUTextureSamplerBinding{
            source_texture(
                state,
                engine,
                source < 0
                    ? pass.source
                    : pass.extra_textures.at(static_cast<std::size_t>(source)),
                swapchain),
            sampler};
    }
    if (!gpu.texture_sources.empty()) {
        SDL_BindGPUFragmentSamplers(
            render_pass,
            0,
            bindings.data(),
            static_cast<Uint32>(gpu.texture_sources.size()));
    }
    SDL_DrawGPUPrimitives(render_pass, 3, 1, 0, 0);
    SDL_EndGPURenderPass(render_pass);
    if (presents) {
        SDL_GPUBlitInfo blit{};
        blit.source = SDL_GPUBlitRegion{
            state.present_copy, 0, 0, 0, 0, width, height};
        blit.destination = SDL_GPUBlitRegion{
            swapchain, 0, 0, 0, 0, width, height};
        blit.load_op = SDL_GPU_LOADOP_DONT_CARE;
        blit.filter = SDL_GPU_FILTER_NEAREST;
        SDL_BlitGPUTexture(command, &blit);
        capture_texture = state.present_copy;
    }
}
#endif

} // namespace

bool run_frame_graph_gpu_engine(Engine& engine) {
    const FrameOptions options = read_frame_options();
    reject_unsupported_frame_options(
        options,
        "SDL_GPU frame graph",
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
        ? SDL_GPU_SAMPLECOUNT_1
        : gpu_sample_count_from(upstream::preferred_sample_count());
    try {
        SdlGpuDeviceOptions device_options;
        device_options.hidden_test_pass = options.test_pass;
        device_options.immediate_present = options.benchmark_requested;
        device_options.gpu_debug = options.gpu_debug;
        create_sdl_gpu_device(engine.options, device_options, state.gpu);
#if BBLITE_HAS_POST_PROCESS
        SDL_GPUSamplerCreateInfo sampler{};
        sampler.address_mode_u = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        sampler.address_mode_v = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        sampler.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        sampler.min_filter = SDL_GPU_FILTER_LINEAR;
        sampler.mag_filter = SDL_GPU_FILTER_LINEAR;
        state.linear_sampler = SDL_CreateGPUSampler(state.gpu.device, &sampler);
        sampler.min_filter = SDL_GPU_FILTER_NEAREST;
        sampler.mag_filter = SDL_GPU_FILTER_NEAREST;
        state.nearest_sampler = SDL_CreateGPUSampler(state.gpu.device, &sampler);
        if (!state.linear_sampler || !state.nearest_sampler) {
            gpu_error("SDL_CreateGPUSampler frame graph");
        }
#endif

        const long limit = options.frame_budget();
        CaptureGate captures(options, limit, &engine);
        FrameClock clock;
        bool running = true;
        long frame = 0;
        PlatformInputReplay input_replay;
        while (captures.keep_running(running, frame)) {
            poll_platform_events(engine, running, options.test_pass);
            input_replay.dispatch(frame, state.gpu.window, engine);
            (void)advance_frame(
                engine,
                context,
                clock,
                options.frame_delta_ms);
            SDL_GPUCommandBuffer* command =
                SDL_AcquireGPUCommandBuffer(state.gpu.device);
            if (!command) gpu_error("SDL_AcquireGPUCommandBuffer frame graph");
            SDL_GPUTexture* swapchain = nullptr;
            std::uint32_t width = 0;
            std::uint32_t height = 0;
            if (!SDL_WaitAndAcquireGPUSwapchainTexture(
                    command,
                    state.gpu.window,
                    &swapchain,
                    &width,
                    &height)) {
                gpu_error("SDL_WaitAndAcquireGPUSwapchainTexture frame graph");
            }
            if (!swapchain || width == 0 || height == 0) {
                SDL_SubmitGPUCommandBuffer(command);
                continue;
            }
            build_graph(state, engine, width, height);
            SDL_GPUTexture* capture_texture = nullptr;
            for (const TaskHandle handle : context.tasks) {
                FrameTaskRecord& task = engine.frame_tasks.at(handle.value);
#if BBLITE_HAS_EFFECT_TASK
                if (task.kind == FrameTaskKind::effect) {
                    EffectPass& pass = state.effects.at(handle.value);
                    const RenderTargetRecord& record =
                        engine.render_targets.at(task.effect.target.value);
                    const Target& output = state.targets.at(task.effect.target.value);
                    if (!pass.pipeline) {
                        pass = create_effect_pass(
                            state.gpu.device,
                            engine,
                            task.effect.effect,
                            output.format,
                            record.swapchain
                                ? 1u
                                : gpu_sample_count_value(
                                    target_samples(state, record.samples)));
                    }
                    SDL_GPUColorTargetInfo target{};
                    target.texture = target_texture(
                        state, engine, task.effect.target, swapchain, false);
                    target.clear_color = SDL_FColor{
                        task.effect.clear_color.r,
                        task.effect.clear_color.g,
                        task.effect.clear_color.b,
                        task.effect.clear_color.a};
                    target.load_op = task.effect.clear
                        ? SDL_GPU_LOADOP_CLEAR
                        : SDL_GPU_LOADOP_LOAD;
                    const SDL_GPUSampleCount samples =
                        target_samples(state, record.samples);
                    target.store_op = samples == SDL_GPU_SAMPLECOUNT_1
                        ? SDL_GPU_STOREOP_STORE
                        : SDL_GPU_STOREOP_RESOLVE;
                    if (samples != SDL_GPU_SAMPLECOUNT_1) {
                        target.resolve_texture = output.sampled;
                    }
                    SDL_GPURenderPass* render_pass =
                        SDL_BeginGPURenderPass(command, &target, 1, nullptr);
                    record_effect_pass(
                        command,
                        render_pass,
                        engine,
                        pass,
                        task.effect.effect);
                    SDL_EndGPURenderPass(render_pass);
                    if (record.swapchain) capture_texture = swapchain;
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
                            command,
                            swapchain,
                            width,
                            height,
                            capture_texture);
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
                "sdl_gpu", engine, width, height, frame);
            if (capture_frame) {
                if (!capture_texture) {
                    throw std::runtime_error(
                        "Frame graph did not produce a capturable surface target.");
                }
                save_texture_png(
                    state.gpu.device,
                    command,
                    capture_texture,
                    state.gpu.swapchain_format,
                    width,
                    height,
                    options.screenshot_path);
                captures.screenshot_saved = true;
            } else if (!SDL_SubmitGPUCommandBuffer(command)) {
                gpu_error("SDL_SubmitGPUCommandBuffer frame graph");
            }
            finish_frame(engine);
            ++frame;
        }
        if (!SDL_WaitForGPUIdle(state.gpu.device)) {
            gpu_error("SDL_WaitForGPUIdle frame graph");
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

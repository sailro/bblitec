// The frame driver for a scene that registers effect renderers and no
// `SceneContext`.
//
// The drawing is not here — it is in `pal_sdl_gpu_effect.hpp`, as the two
// halves of a rendering context, so the frame-graph task composes the same
// pass into a scene's own frame. What is here is only what an engine owns:
// the window, the device, the frame loop, the capture and the present. This
// translation unit exists because a scene registering no `SceneContext`
// generates no camera math and no render plan, so `pal_sdl_gpu.cpp` cannot be
// compiled for it at all.
#include <bblite/pal.hpp>
#include <bblite/pal_gpu.hpp>
#include <bblite/runtime.hpp>

#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

#include "pal_platform_events.hpp"
#include "pal_gpu_shared.hpp"
#include "pal_render_capture.hpp"

#if BBLITE_HAS_EFFECT_RENDERER
#include "pal_sdl_gpu_effect.hpp"
#endif

namespace bbl::pal {

#if BBLITE_HAS_EFFECT_RENDERER

bool run_effect_gpu_engine(Engine& engine) {
    const FrameOptions frame_options = read_frame_options();
    reject_unsupported_frame_options(
        frame_options,
        "SDL_GPU effects",
        /*supports_single_sample=*/true,
        /*supports_copy_task=*/false);
    if (engine.registered_effect_renderers.empty()) {
        throw std::runtime_error(
            "Effect renderer requires a registered EffectRenderer.");
    }
    SdlGpuDevice gpu{};
    SDL_Window*& window = gpu.window;
    SDL_GPUDevice*& device = gpu.device;
    SDL_GPUTexture* color = nullptr;
    SDL_GPUTexture* resolve = nullptr;
    std::uint32_t color_width = 0;
    std::uint32_t color_height = 0;
    std::vector<EffectPass> passes;
    const auto release = [&]() {
        for (EffectPass& pass : passes) {
            release_effect_pass(device, pass);
        }
        if (resolve) SDL_ReleaseGPUTexture(device, resolve);
        if (color) SDL_ReleaseGPUTexture(device, color);
        if (window && device) SDL_ReleaseWindowFromGPUDevice(device, window);
        if (device) SDL_DestroyGPUDevice(device);
        if (window) SDL_DestroyWindow(window);
        SDL_Quit();
    };

    try {
        SdlGpuDeviceOptions device_options;
        device_options.hidden_test_pass = frame_options.test_pass;
        device_options.immediate_present =
            frame_options.benchmark_requested;
        device_options.gpu_debug = frame_options.gpu_debug;
        create_sdl_gpu_device(engine.options, device_options, gpu);
        const SDL_GPUTextureFormat swapchain_format = gpu.swapchain_format;

        // The surface's own sample count: `createEffectRenderer` renders into
        // an MSAA target and resolves into the swapchain when the surface is
        // multisampled, and straight into it when it is not. The count is
        // the generated read of the pin's own surface declaration
        // (`msaaSamples === 1 ? 1 : 4`), not a re-typed 4.
        const std::uint32_t samples = frame_options.single_sample
            ? 1u
            : upstream::preferred_sample_count();

        // Registration order is draw order across renderers, as it is in the
        // pinned `engine._renderingContexts`.
        for (const EffectRendererHandle& handle :
             engine.registered_effect_renderers) {
            const EffectRendererRecord& record =
                engine.effect_renderers[handle.value];
            passes.push_back(create_effect_pass(
                device,
                engine,
                record.effect,
                swapchain_format,
                samples));
        }
        // The first registered renderer owns the frame's clear, exactly as
        // the first rendering context does upstream.
        const EffectRendererRecord& first =
            engine.effect_renderers
                [engine.registered_effect_renderers.front().value];

        const long limit = frame_options.frame_budget();
        const bool benchmark = frame_options.benchmarking();
        const long warmup = frame_options.benchmark_warmup();
        CaptureGate captures(frame_options, limit, &engine);
        // A swapchain texture cannot be read back, so a run that was
        // asked for any capture keeps a sampleable resolve texture and
        // blits it -- the whole run, so the captured frame is composed
        // exactly like the ones before it. A run without one renders (or
        // MSAA-resolves, the pin's own arm) straight into the swapchain;
        // the presented image is identical because the blit is a
        // full-surface 1:1 copy.
        const bool capture_run = captures.requested();
        std::vector<double> samples_ms;
        bool running = true;
        long frame = 0;
        FrameClock frame_clock;
        PlatformInputReplay input_replay;
        while (captures.keep_running(running, frame)) {
            poll_platform_events(
                engine, running, frame_options.test_pass);
            input_replay.dispatch(frame, window, engine);
            // A scene-less driver still serves a queued timeout, so a
            // `stopEngine` from one is not a silent no-op here.
            (void)advance_frame(
                engine,
                frame_clock,
                frame_options.frame_delta_ms);
            const double frame_start = monotonic_milliseconds();

            SDL_GPUCommandBuffer* command =
                SDL_AcquireGPUCommandBuffer(device);
            if (!command) gpu_error("SDL_AcquireGPUCommandBuffer");
            SDL_GPUTexture* swapchain = nullptr;
            std::uint32_t width = 0;
            std::uint32_t height = 0;
            if (!SDL_WaitAndAcquireGPUSwapchainTexture(
                    command, window, &swapchain, &width, &height)) {
                gpu_error("SDL_WaitAndAcquireGPUSwapchainTexture");
            }
            if (!swapchain || width == 0 || height == 0) {
                if (!SDL_SubmitGPUCommandBuffer(command)) {
                    gpu_error("SDL_SubmitGPUCommandBuffer effect");
                }
                continue;
            }
            const bool capture_frame =
                frame >= frame_options.screenshot_frame &&
                !captures.screenshot_saved &&
                !frame_options.screenshot_path.empty();
            captures.maybe_write_standalone_render_capture(
                "sdl_gpu", engine, width, height, frame);

            // Offscreen textures exist only where a lane needs one: the
            // sampleable resolve target for a capture run's readback, the
            // multisampled colour target whenever the surface is
            // multisampled. The multisampled target resolves into the
            // frame's destination, which is the pin's own arm.
            if (color_width != width || color_height != height) {
                if (color) SDL_ReleaseGPUTexture(device, color);
                if (resolve) SDL_ReleaseGPUTexture(device, resolve);
                color = nullptr;
                resolve = nullptr;
                SDL_GPUTextureCreateInfo info{};
                info.type = SDL_GPU_TEXTURETYPE_2D;
                info.format = swapchain_format;
                info.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
                    SDL_GPU_TEXTUREUSAGE_SAMPLER;
                info.width = width;
                info.height = height;
                info.layer_count_or_depth = 1;
                info.num_levels = 1;
                info.sample_count = SDL_GPU_SAMPLECOUNT_1;
                if (capture_run) {
                    resolve = SDL_CreateGPUTexture(device, &info);
                    if (!resolve) {
                        gpu_error("SDL_CreateGPUTexture effect resolve");
                    }
                }
                if (samples > 1) {
                    SDL_GPUTextureCreateInfo msaa = info;
                    msaa.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
                    msaa.sample_count = gpu_sample_count_from(samples);
                    color = SDL_CreateGPUTexture(device, &msaa);
                    if (!color) gpu_error("SDL_CreateGPUTexture effect color");
                }
                color_width = width;
                color_height = height;
            }

            // Where this frame's single-sample pixels land: the readback
            // texture on a capture run, the swapchain itself otherwise.
            SDL_GPUTexture* const destination =
                capture_run ? resolve : swapchain;
            SDL_GPUColorTargetInfo color_target{};
            color_target.texture = samples > 1 ? color : destination;
            color_target.clear_color = SDL_FColor{
                first.clear_color.r,
                first.clear_color.g,
                first.clear_color.b,
                first.clear_color.a};
            color_target.load_op = first.clear
                ? SDL_GPU_LOADOP_CLEAR
                : SDL_GPU_LOADOP_LOAD;
            if (samples > 1) {
                color_target.store_op = SDL_GPU_STOREOP_RESOLVE;
                color_target.resolve_texture = destination;
            } else {
                color_target.store_op = SDL_GPU_STOREOP_STORE;
            }
            SDL_GPURenderPass* render_pass =
                SDL_BeginGPURenderPass(command, &color_target, 1, nullptr);
            for (std::size_t index = 0; index < passes.size(); ++index) {
                const EffectRendererRecord& record =
                    engine.effect_renderers
                        [engine.registered_effect_renderers[index].value];
                record_effect_pass(
                    command,
                    render_pass,
                    engine,
                    passes[index],
                    record.effect);
            }
            SDL_EndGPURenderPass(render_pass);

            if (capture_run) {
                SDL_GPUBlitInfo blit{};
                blit.source =
                    SDL_GPUBlitRegion{resolve, 0, 0, 0, 0, width, height};
                blit.destination =
                    SDL_GPUBlitRegion{
                        swapchain, 0, 0, 0, 0, width, height};
                blit.load_op = SDL_GPU_LOADOP_DONT_CARE;
                blit.flip_mode = SDL_FLIP_NONE;
                blit.filter = SDL_GPU_FILTER_NEAREST;
                SDL_BlitGPUTexture(command, &blit);
            }

            if (capture_frame) {
                save_texture_png(
                    device,
                    command,
                    resolve,
                    swapchain_format,
                    width,
                    height,
                    frame_options.screenshot_path);
                captures.screenshot_saved = true;
            } else if (!SDL_SubmitGPUCommandBuffer(command)) {
                gpu_error("SDL_SubmitGPUCommandBuffer effect");
            }

            finish_frame(engine);
            if (benchmark && frame >= warmup) {
                samples_ms.push_back(
                    monotonic_milliseconds() - frame_start);
            }
            frame += 1;
        }
        if (benchmark) {
            report_benchmark(
                std::move(samples_ms),
                "SDL_GPU",
                SDL_GetGPUDeviceDriver(device));
        }
    } catch (...) {
        release();
        throw;
    }
    release();
    return true;
}
#endif

} // namespace bbl::pal

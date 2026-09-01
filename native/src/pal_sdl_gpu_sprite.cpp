// The frame driver for a scene that registers sprite renderers and no
// `SceneContext`.
//
// The drawing is not here — it is in `pal_sdl_gpu_sprite.hpp`, as the two
// halves of a rendering context, so the scene renderer composes the same
// pass into its own frame for a HUD over 3D. What is here is only what an
// engine owns: the window, the device, the frame loop, the capture and the
// present. This translation unit exists because a scene registering no
// `SceneContext` generates no camera math and no render plan, so
// `pal_sdl_gpu.cpp` cannot be compiled for it at all.
#include <bblite/pal.hpp>
#include <bblite/pal_gpu.hpp>
#include <bblite/runtime.hpp>
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
#include <bblite/pal_ui.hpp>
#endif

#include <array>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "pal_platform_events.hpp"
#include "pal_gpu_shared.hpp"
#include "pal_render_capture.hpp"

#if BBLITE_HAS_SPRITE_RENDERER
#include "pal_sdl_gpu_sprite.hpp"
#endif
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
#include "pal_sprite_ui_sdl.hpp"
#endif

namespace bbl::pal {

#if BBLITE_HAS_SPRITE_RENDERER

bool run_sprite_gpu_engine(Engine& engine) {
    const FrameOptions frame_options = read_frame_options();
    reject_unsupported_frame_options(
        frame_options,
        "SDL_GPU sprites",
        /*supports_single_sample=*/true,
        /*supports_copy_task=*/false);
    if (engine.registered_sprite_renderers.empty()) {
        throw std::runtime_error(
            "Sprite renderer requires a registered SpriteRenderer.");
    }
    SdlGpuDevice gpu{};
    SDL_Window*& window = gpu.window;
    SDL_GPUDevice*& device = gpu.device;
    SDL_GPUTexture* color = nullptr;
    std::uint32_t color_width = 0;
    std::uint32_t color_height = 0;
    std::vector<SpritePass> passes;
    std::vector<SDL_GPUTexture*> render_textures;
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
    UiRmlRuntime* ui_runtime = nullptr;
    SpriteUiSdlResources ui_resources;
#endif
    const auto release = [&]() {
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
        if (device) {
            release_sprite_ui_sdl_resources(device, ui_resources);
        }
        destroy_ui_rml_runtime(ui_runtime);
        ui_runtime = nullptr;
#endif
        for (SpritePass& pass : passes) {
            release_sprite_pass(device, pass);
        }
        for (SDL_GPUTexture* texture : render_textures) {
            if (texture) SDL_ReleaseGPUTexture(device, texture);
        }
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
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
        ui_runtime = create_ui_rml_runtime(
            engine,
            window,
            static_cast<std::uint32_t>(engine.options.width),
            static_cast<std::uint32_t>(engine.options.height));
#endif

        const auto sync_render_textures = [&]() {
            render_textures.resize(
                engine.sprite_render_textures.size(), nullptr);
            for (std::size_t index = 0;
                 index < engine.sprite_render_textures.size();
                 ++index) {
                const SpriteRenderTextureRecord& record =
                    engine.sprite_render_textures[index];
                SDL_GPUTexture*& texture = render_textures[index];
                if (record.disposed) {
                    if (texture) SDL_ReleaseGPUTexture(device, texture);
                    texture = nullptr;
                    continue;
                }
                if (texture) continue;
                SDL_GPUTextureCreateInfo info{};
                info.type = SDL_GPU_TEXTURETYPE_2D;
                info.format = swapchain_format;
                info.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
                    SDL_GPU_TEXTUREUSAGE_SAMPLER;
                info.width = record.width;
                info.height = record.height;
                info.layer_count_or_depth = 1;
                info.num_levels = 1;
                info.sample_count = SDL_GPU_SAMPLECOUNT_1;
                texture = SDL_CreateGPUTexture(device, &info);
                if (!texture) {
                    gpu_error("SDL_CreateGPUTexture sprite target");
                }
            }
        };
        const auto sync_renderer_passes = [&]() {
            bool matches =
                passes.size() ==
                engine.registered_sprite_renderers.size();
            for (
                std::size_t index = 0;
                matches && index < passes.size();
                ++index
            ) {
                matches =
                    passes[index].renderer.value ==
                    engine.registered_sprite_renderers[index].value;
            }
            if (matches) return;
            for (SpritePass& pass : passes) {
                release_sprite_pass(device, pass);
            }
            passes.clear();
            for (const SpriteRendererHandle& handle :
                 engine.registered_sprite_renderers) {
                passes.push_back(create_sprite_pass(
                    device,
                    engine,
                    handle,
                    render_textures,
                    swapchain_format));
            }
        };

        sync_render_textures();
        sync_renderer_passes();

        const long limit = frame_options.frame_budget();
        const bool benchmark = frame_options.benchmarking();
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
        const bool capture_ui = frame_options.capture_ui;
#endif
        const long warmup = frame_options.benchmark_warmup();
        CaptureGate captures(frame_options, limit, &engine);
        std::vector<double> samples;
        bool running = true;
        long frame = 0;
        FrameClock frame_clock;
        PlatformInputReplay input_replay;
        while (captures.keep_running(running, frame)) {
            SDL_Event event;
            while (SDL_PollEvent(&event)) {
                if (event.type == SDL_EVENT_QUIT) running = false;
                if (frame_options.test_pass && is_platform_input_event(event)) {
                    continue;
                }
                bool propagate_to_scene = true;
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
                propagate_to_scene =
                    handle_ui_rml_event(*ui_runtime, event);
#endif
                if (propagate_to_scene) {
                    handle_platform_event(event, engine);
                }
            }
            input_replay.dispatch(frame, window, engine);
            const float delta_ms = advance_frame(
                engine,
                frame_clock,
                frame_options.frame_delta_ms);
            const double frame_start = monotonic_milliseconds();

            sync_render_textures();
            sync_renderer_passes();

            // Every context updates before any records, which is the
            // pinned loop's order and, on D3D12, the only legal one: an
            // upload and a draw cannot share two open command lists.
            for (SpritePass& pass : passes) {
                // A scene callback may have added, removed or disposed a
                // layer since the last frame; the GPU mirror is addressed
                // by position, so it is rebuilt before anything reads it.
                sync_sprite_pass_layers(
                    device, engine, pass, render_textures);
                upload_sprite_pass(device, engine, pass, delta_ms);
            }

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
                    gpu_error("SDL_SubmitGPUCommandBuffer sprite");
                }
                continue;
            }
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
            update_ui_rml_runtime(*ui_runtime, width, height);
#endif
            const bool capture_frame =
                frame >= frame_options.screenshot_frame &&
                !captures.screenshot_saved &&
                !frame_options.screenshot_path.empty();
            // The render capture describes CPU state alone — the same
            // records the uploads above read — written at the frame the
            // screenshot gate names, exactly as the scene loop writes its
            // own beside its screenshot.
            if (
                frame >= frame_options.screenshot_frame &&
                !captures.render_capture_saved &&
                !frame_options.render_capture_path.empty()) {
                write_standalone_render_capture(
                    frame_options.render_capture_path,
                    "sdl_gpu",
                    engine,
                    static_cast<int>(width),
                    static_cast<int>(height),
                    frame);
                captures.render_capture_saved = true;
            }

            // Rendered offscreen and blitted, because a swapchain texture
            // cannot be read back for the capture.
            if (color_width != width || color_height != height) {
                if (color) SDL_ReleaseGPUTexture(device, color);
                SDL_GPUTextureCreateInfo color_info{};
                color_info.type = SDL_GPU_TEXTURETYPE_2D;
                color_info.format = swapchain_format;
                color_info.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
                    SDL_GPU_TEXTUREUSAGE_SAMPLER;
                color_info.width = width;
                color_info.height = height;
                color_info.layer_count_or_depth = 1;
                color_info.num_levels = 1;
                color_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
                color = SDL_CreateGPUTexture(device, &color_info);
                if (!color) gpu_error("SDL_CreateGPUTexture sprite color");
                color_width = width;
                color_height = height;
            }

            for (std::size_t first_index = 0;
                 first_index < passes.size();) {
                const SpriteRendererRecord& first_renderer =
                    engine.sprite_renderers[
                        passes[first_index].renderer.value];
                SDL_GPUTexture* target = color;
                if (first_renderer.has_target) {
                    target = render_textures[
                        first_renderer.target.value];
                }
                std::size_t end_index = first_index + 1;
                while (end_index < passes.size()) {
                    const SpriteRendererRecord& next =
                        engine.sprite_renderers[
                            passes[end_index].renderer.value];
                    if (
                        next.has_target !=
                            first_renderer.has_target ||
                        (next.has_target &&
                         next.target.value !=
                             first_renderer.target.value)
                    ) {
                        break;
                    }
                    ++end_index;
                }

                SDL_GPUColorTargetInfo color_target{};
                color_target.texture = target;
                color_target.clear_color = SDL_FColor{
                    first_renderer.clear_value.r,
                    first_renderer.clear_value.g,
                    first_renderer.clear_value.b,
                    first_renderer.clear_value.a};
                color_target.load_op = first_renderer.clear
                    ? SDL_GPU_LOADOP_CLEAR
                    : SDL_GPU_LOADOP_LOAD;
                color_target.store_op = SDL_GPU_STOREOP_STORE;
                SDL_GPURenderPass* render_pass =
                    SDL_BeginGPURenderPass(
                        command, &color_target, 1, nullptr);
                for (
                    std::size_t index = first_index;
                    index < end_index;
                    ++index
                ) {
                    record_sprite_pass(
                        command,
                        render_pass,
                        engine,
                        passes[index],
                        width,
                        height);
                }
                SDL_EndGPURenderPass(render_pass);
                first_index = end_index;
            }

#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
            const UiRenderFrame& ui_frame =
                record_ui_rml_frame(*ui_runtime, width, height);
            const bool ui_in_capture = capture_frame && capture_ui;
            if (ui_in_capture) {
                render_sprite_ui_sdl_frame(
                    device,
                    command,
                    color,
                    swapchain_format,
                    ui_resources,
                    ui_frame);
            }
#endif

            SDL_GPUBlitInfo blit{};
            blit.source =
                SDL_GPUBlitRegion{color, 0, 0, 0, 0, width, height};
            blit.destination =
                SDL_GPUBlitRegion{swapchain, 0, 0, 0, 0, width, height};
            blit.load_op = SDL_GPU_LOADOP_DONT_CARE;
            blit.flip_mode = SDL_FLIP_NONE;
            blit.filter = SDL_GPU_FILTER_NEAREST;
            SDL_BlitGPUTexture(command, &blit);

#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
            if (!ui_in_capture) {
                render_sprite_ui_sdl_frame(
                    device,
                    command,
                    swapchain,
                    swapchain_format,
                    ui_resources,
                    ui_frame);
            }
#endif

            if (capture_frame) {
                save_texture_png(
                    device,
                    command,
                    color,
                    swapchain_format,
                    width,
                    height,
                    frame_options.screenshot_path);
                captures.screenshot_saved = true;
            } else if (!SDL_SubmitGPUCommandBuffer(command)) {
                gpu_error("SDL_SubmitGPUCommandBuffer sprite");
            }

            finish_frame(engine);
            if (benchmark && frame >= warmup) {
                samples.push_back(
                    monotonic_milliseconds() - frame_start);
            }
            frame += 1;
        }
        if (benchmark) {
            report_benchmark(
                std::move(samples),
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

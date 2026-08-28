// The Dawn frame driver for a scene that registers sprite renderers and no
// `SceneContext`.
//
// The drawing is not here — it is in `pal_dawn_sprite.hpp`, as the two
// halves of a rendering context, so the scene renderer composes the same
// pass into its own frame for a HUD over 3D. What is here is only what an
// engine owns: the window, the device, the frame loop, the capture and the
// present. This translation unit exists because a scene registering no
// `SceneContext` generates no camera math and no render plan, so
// `pal_dawn.cpp` cannot be compiled for it at all.
#include <bblite/pal.hpp>
#include <bblite/pal_gpu.hpp>
#include <bblite/runtime.hpp>

#include <array>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

#include "pal_platform_events.hpp"
#include "pal_gpu_shared.hpp"
#include "pal_render_capture.hpp"

#if BBLITE_HAS_DAWN && BBLITE_HAS_SPRITE_RENDERER
#include "pal_dawn_sprite.hpp"
#endif

namespace bbl::pal {

#if BBLITE_HAS_DAWN && BBLITE_HAS_SPRITE_RENDERER

bool run_sprite_dawn_engine(Engine& engine) {
    const FrameOptions frame_options = read_frame_options();
    reject_unsupported_frame_options(
        frame_options,
        "Dawn sprites",
        /*supports_single_sample=*/true,
        /*supports_copy_task=*/false);
    if (engine.registered_sprite_renderers.empty()) {
        throw std::runtime_error(
            "Sprite renderer requires a registered SpriteRenderer.");
    }

    DawnDevice state;
    std::vector<DawnSpritePass> passes;
    std::vector<WGPUTexture> render_textures;
    std::vector<WGPUTextureView> render_texture_views;
    const auto release = [&]() {
        for (DawnSpritePass& pass : passes) {
            release_dawn_sprite_pass(pass);
        }
        for (WGPUTextureView view : render_texture_views) {
            if (view) wgpuTextureViewRelease(view);
        }
        for (WGPUTexture texture : render_textures) {
            if (texture) wgpuTextureRelease(texture);
        }
        if (state.queue) wgpuQueueRelease(state.queue);
        if (state.device) wgpuDeviceRelease(state.device);
        if (state.adapter) wgpuAdapterRelease(state.adapter);
        if (state.surface) wgpuSurfaceRelease(state.surface);
        if (state.instance) wgpuInstanceRelease(state.instance);
        if (state.window) SDL_DestroyWindow(state.window);
        SDL_Quit();
    };

    try {
        DawnDeviceOptions device_options;
        device_options.hidden_test_pass = frame_options.test_pass;
        device_options.immediate_present =
            frame_options.benchmark_requested;
        create_dawn_device(engine.options, device_options, state);

        const auto sync_render_textures = [&]() {
            while (
                render_textures.size() <
                engine.sprite_render_textures.size()
            ) {
                const SpriteRenderTextureRecord& record =
                    engine.sprite_render_textures[render_textures.size()];
                WGPUTextureDescriptor descriptor =
                    WGPU_TEXTURE_DESCRIPTOR_INIT;
                descriptor.dimension = WGPUTextureDimension_2D;
                descriptor.format = state.surface_format;
                descriptor.usage =
                    WGPUTextureUsage_RenderAttachment |
                    WGPUTextureUsage_TextureBinding;
                descriptor.size = {record.width, record.height, 1};
                WGPUTexture texture =
                    wgpuDeviceCreateTexture(state.device, &descriptor);
                if (!texture) {
                    dawn_error("sprite render texture creation failed.");
                }
                WGPUTextureView view =
                    wgpuTextureCreateView(texture, nullptr);
                if (!view) {
                    wgpuTextureRelease(texture);
                    dawn_error("sprite render texture view creation failed.");
                }
                render_textures.push_back(texture);
                render_texture_views.push_back(view);
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
            for (DawnSpritePass& pass : passes) {
                release_dawn_sprite_pass(pass);
            }
            passes.clear();
            for (const SpriteRendererHandle& handle :
                 engine.registered_sprite_renderers) {
                passes.push_back(create_dawn_sprite_pass(
                    state.device,
                    state.queue,
                    engine,
                    handle,
                    render_textures,
                    render_texture_views,
                    state.surface_format));
            }
        };

        sync_render_textures();
        sync_renderer_passes();

        const std::uint32_t width =
            static_cast<std::uint32_t>(engine.options.width);
        const std::uint32_t height =
            static_cast<std::uint32_t>(engine.options.height);
        // The extent is pinned to the engine options for the whole run
        // (no per-frame resize on this driver), so a zero extent cannot
        // be skipped like the SDL twin skips a minimized frame — refuse.
        if (width == 0 || height == 0) {
            dawn_error("sprite surface has a zero extent.");
        }
        const long limit = frame_options.frame_budget();
        const bool benchmark = frame_options.benchmarking();
        const long warmup = frame_options.benchmark_warmup();
        CaptureGate captures(frame_options, limit, &engine);
        std::vector<double> samples;
        bool running = true;
        long frame = 0;
        FrameClock frame_clock;
        KeyboardReplay keyboard_replay;
        while (captures.keep_running(running, frame)) {
            SDL_Event event;
            while (SDL_PollEvent(&event)) {
                if (event.type == SDL_EVENT_QUIT) running = false;
                handle_platform_event(event, engine);
            }
            keyboard_replay.dispatch(frame, engine);
            const float delta_ms = advance_frame(
                engine,
                frame_clock,
                frame_options.frame_delta_ms);
            const double frame_start = monotonic_milliseconds();

            sync_render_textures();
            sync_renderer_passes();

            WGPUSurfaceTexture surface_texture{};
            wgpuSurfaceGetCurrentTexture(state.surface, &surface_texture);
            if (!surface_texture.texture) {
                continue;
            }
            WGPUTextureView surface_view =
                wgpuTextureCreateView(surface_texture.texture, nullptr);

            // Every context updates before any records, which is the
            // pinned loop's order.
            for (DawnSpritePass& pass : passes) {
                // A scene callback may have added, removed or disposed a
                // layer since the last frame; the GPU mirror is addressed
                // by position, so it is rebuilt before anything reads it.
                sync_dawn_sprite_pass_layers(
                    state.device,
                    state.queue,
                    engine,
                    pass,
                    render_textures,
                    render_texture_views);
                const SpriteRendererRecord& renderer =
                    engine.sprite_renderers[pass.renderer.value];
                const SpriteRenderTextureRecord* target =
                    renderer.has_target
                        ? &engine.sprite_render_textures[
                              renderer.target.value]
                        : nullptr;
                upload_dawn_sprite_pass(
                    state.queue,
                    engine,
                    pass,
                    target ? target->width : width,
                    target ? target->height : height,
                    delta_ms);
            }

            WGPUCommandEncoder encoder =
                wgpuDeviceCreateCommandEncoder(state.device, nullptr);
            for (std::size_t first_index = 0;
                 first_index < passes.size();) {
                const SpriteRendererRecord& first_renderer =
                    engine.sprite_renderers[
                        passes[first_index].renderer.value];
                WGPUTextureView target_view = surface_view;
                if (first_renderer.has_target) {
                    target_view = render_texture_views[
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

                WGPURenderPassColorAttachment color_attachment =
                    WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
                color_attachment.view = target_view;
                color_attachment.loadOp = first_renderer.clear
                    ? WGPULoadOp_Clear
                    : WGPULoadOp_Load;
                color_attachment.storeOp = WGPUStoreOp_Store;
                color_attachment.clearValue = WGPUColor{
                    first_renderer.clear_value.r,
                    first_renderer.clear_value.g,
                    first_renderer.clear_value.b,
                    first_renderer.clear_value.a};
                WGPURenderPassDescriptor pass_descriptor =
                    WGPU_RENDER_PASS_DESCRIPTOR_INIT;
                pass_descriptor.colorAttachmentCount = 1;
                pass_descriptor.colorAttachments = &color_attachment;
                WGPURenderPassEncoder render_pass =
                    wgpuCommandEncoderBeginRenderPass(
                        encoder,
                        &pass_descriptor);
                for (
                    std::size_t index = first_index;
                    index < end_index;
                    ++index
                ) {
                    record_dawn_sprite_pass(
                        render_pass, engine, passes[index]);
                }
                wgpuRenderPassEncoderEnd(render_pass);
                wgpuRenderPassEncoderRelease(render_pass);
                first_index = end_index;
            }

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
                    "dawn",
                    engine,
                    static_cast<int>(width),
                    static_cast<int>(height),
                    frame);
                captures.render_capture_saved = true;
            }
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
                    frame_options.screenshot_path);
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
            if (benchmark && frame >= warmup) {
                samples.push_back(
                    monotonic_milliseconds() - frame_start);
            }
            frame += 1;
        }
        if (benchmark) {
            report_benchmark(std::move(samples), "Dawn", "D3D12");
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

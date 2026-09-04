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

#if BBLITE_HAS_DAWN && BBLITE_HAS_SPRITE_RENDERER
#include "pal_dawn_sprite.hpp"
#endif
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
#include "pal_sprite_ui_dawn.hpp"
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
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
    UiRmlRuntime* ui_runtime = nullptr;
    SpriteUiDawnResources ui_resources;
#endif
    const auto release = [&]() {
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
        release_sprite_ui_dawn_resources(ui_resources);
        destroy_ui_rml_runtime(ui_runtime);
        ui_runtime = nullptr;
#endif
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
        sync_engine_canvas_size(state.window, engine);
        resize_dawn_surface(state, engine.options);
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
        ui_runtime = create_ui_rml_runtime(
            engine,
            state.window,
            static_cast<std::uint32_t>(engine.options.width),
            static_cast<std::uint32_t>(engine.options.height));
#endif

        const auto sync_render_textures = [&]() {
            render_textures.resize(
                engine.sprite_render_textures.size(), nullptr);
            render_texture_views.resize(
                engine.sprite_render_textures.size(), nullptr);
            // The one refusal walk covers every disposed record, so it
            // runs once per sync -- at the first disposed record, before
            // any release -- rather than once per record per frame.
            bool disposed_refused = false;
            for (std::size_t index = 0;
                 index < engine.sprite_render_textures.size();
                 ++index) {
                const SpriteRenderTextureRecord& record =
                    engine.sprite_render_textures[index];
                WGPUTexture& texture = render_textures[index];
                WGPUTextureView& view = render_texture_views[index];
                if (record.disposed) {
                    if (!disposed_refused) {
                        refuse_disposed_sprite_render_texture_in_use(
                            engine);
                        disposed_refused = true;
                    }
                    if (view) wgpuTextureViewRelease(view);
                    if (texture) wgpuTextureRelease(texture);
                    view = nullptr;
                    texture = nullptr;
                    continue;
                }
                if (texture) continue;
                WGPUTextureDescriptor descriptor =
                    WGPU_TEXTURE_DESCRIPTOR_INIT;
                descriptor.dimension = WGPUTextureDimension_2D;
                descriptor.format = state.surface_format;
                descriptor.usage =
                    WGPUTextureUsage_RenderAttachment |
                    WGPUTextureUsage_TextureBinding;
                descriptor.size = {record.width, record.height, 1};
                texture = wgpuDeviceCreateTexture(
                    state.device, &descriptor);
                if (!texture) {
                    dawn_error("sprite render texture creation failed.");
                }
                view = wgpuTextureCreateView(texture, nullptr);
                if (!view) {
                    wgpuTextureRelease(texture);
                    dawn_error("sprite render texture view creation failed.");
                }
            }
        };
        const auto sync_renderer_passes = [&]() {
            if (sprite_passes_match_registered(engine, passes)) return;
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

        std::uint32_t width =
            static_cast<std::uint32_t>(engine.options.width);
        std::uint32_t height =
            static_cast<std::uint32_t>(engine.options.height);
        if (width == 0 || height == 0) {
            dawn_error("sprite surface has a zero extent.");
        }
        const long limit = frame_options.frame_budget();
        const bool benchmark = frame_options.benchmarking();
        const bool mem_profile =
            environment_variable("BBLITE_MEM_PROFILE") == "1";
        const bool capture_ui = frame_options.capture_ui;
        const long warmup = frame_options.benchmark_warmup();
        CaptureGate captures(frame_options, limit, &engine);
        std::vector<double> samples;
        bool running = true;
        long frame = 0;
        FrameClock frame_clock;
        PlatformInputReplay input_replay;
        while (captures.keep_running(running, frame)) {
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
            poll_platform_events(
                engine,
                running,
                frame_options.test_pass,
                [&](SDL_Event& event) {
                    return handle_ui_rml_event(*ui_runtime, event);
                });
#else
            poll_platform_events(
                engine, running, frame_options.test_pass);
#endif
            sync_engine_canvas_size(state.window, engine);
            if (resize_dawn_surface(state, engine.options)) {
                width = state.surface_width;
                height = state.surface_height;
            }
            input_replay.dispatch(frame, state.window, engine);
            const float delta_ms = advance_frame(
                engine,
                frame_clock,
                frame_options.frame_delta_ms);
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
            // Browser layout observes DOM changes made by this turn's RAF
            // callbacks before painting the frame.
            update_ui_rml_runtime(*ui_runtime, width, height);
#endif
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
                // `spriteRendererUpdate` runs the renderer's own hooks
                // first, so one that moves a sprite or a layer is seen by
                // this frame's mirror rebuild and upload rather than the
                // next one's.
                run_sprite_renderer_before_update(
                    engine, pass.renderer, delta_ms);
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
                upload_dawn_sprite_pass(
                    state.device,
                    state.queue,
                    engine,
                    pass,
                    width,
                    height,
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
                const std::size_t end_index =
                    sprite_pass_target_run_end(
                        engine, passes, first_index);

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
            captures.maybe_write_standalone_render_capture(
                "dawn", engine, width, height, frame);
            DawnSurfaceCapture capture{};
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
            const UiRenderFrame& ui_frame =
                record_ui_rml_frame(*ui_runtime, width, height);
#endif
            if (capture_frame && !capture_ui) {
                capture = begin_dawn_surface_capture(
                    state.device,
                    encoder,
                    surface_texture.texture,
                    width,
                    height);
            }
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
            render_sprite_ui_dawn_frame(
                state,
                encoder,
                surface_view,
                ui_resources,
                ui_frame);
#endif
            if (capture_frame && capture_ui) {
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
            if (mem_profile && frame % memory_profile_frames == 0) {
                // No scene list and no geometry cache here: a sprite
                // renderer draws from its own layers.
                print_memory_frame_profile(frame, engine, 0, 0, 0, 0);
            }
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

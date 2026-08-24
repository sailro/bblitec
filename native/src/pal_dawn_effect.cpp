// The Dawn frame driver for a scene that registers effect renderers and no
// `SceneContext`.
//
// The drawing is not here — it is in `pal_dawn_effect.hpp`, as the two halves
// of a rendering context, so the frame-graph task composes the same pass into
// a scene's own frame. What is here is only what an engine owns: the window,
// the device, the frame loop, the capture and the present. This translation
// unit exists because a scene registering no `SceneContext` generates no
// camera math and no render plan, so `pal_dawn.cpp` cannot be compiled for it
// at all.
#include <bblite/pal.hpp>
#include <bblite/pal_gpu.hpp>
#include <bblite/runtime.hpp>

#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

#include "pal_gpu_shared.hpp"
#include "pal_render_capture.hpp"

#if BBLITE_HAS_DAWN && BBLITE_HAS_EFFECT_RENDERER
#include "pal_dawn_effect.hpp"
#endif

namespace bbl::pal {

#if BBLITE_HAS_DAWN && BBLITE_HAS_EFFECT_RENDERER

bool run_effect_dawn_engine(Engine& engine) {
    const FrameOptions frame_options = read_frame_options();
    reject_unsupported_frame_options(
        frame_options,
        "Dawn effects",
        /*supports_single_sample=*/true,
        /*supports_copy_task=*/false);
    if (engine.registered_effect_renderers.empty()) {
        throw std::runtime_error(
            "Effect renderer requires a registered EffectRenderer.");
    }

    DawnDevice state;
    std::vector<DawnEffectPass> passes;
    WGPUTexture msaa_texture = nullptr;
    WGPUTextureView msaa_view = nullptr;
    const auto release = [&]() {
        for (DawnEffectPass& pass : passes) {
            release_dawn_effect_pass(pass);
        }
        if (msaa_view) wgpuTextureViewRelease(msaa_view);
        if (msaa_texture) wgpuTextureRelease(msaa_texture);
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

        const std::uint32_t width =
            static_cast<std::uint32_t>(engine.options.width);
        const std::uint32_t height =
            static_cast<std::uint32_t>(engine.options.height);
        // The extent is pinned to the engine options for the whole run
        // (no per-frame resize on this driver), so a zero extent cannot
        // be skipped like the SDL twin skips a minimized frame — refuse.
        if (width == 0 || height == 0) {
            dawn_error("effect surface has a zero extent.");
        }
        // `createEffectRenderer` renders into an MSAA colour target and
        // resolves into the swapchain when the surface is multisampled, and
        // straight into it when it is not. The count is the generated read
        // of the pin's own surface declaration (`msaaSamples === 1 ? 1 :
        // 4`), not a re-typed 4.
        const std::uint32_t samples = frame_options.single_sample
            ? 1u
            : upstream::preferred_sample_count();
        if (samples > 1) {
            WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
            descriptor.usage = WGPUTextureUsage_RenderAttachment;
            descriptor.size = {width, height, 1};
            descriptor.format = state.surface_format;
            descriptor.sampleCount = samples;
            msaa_texture = wgpuDeviceCreateTexture(state.device, &descriptor);
            if (!msaa_texture) {
                dawn_error("effect MSAA target creation failed.");
            }
            msaa_view = wgpuTextureCreateView(msaa_texture, nullptr);
        }

        // Registration order is draw order across renderers, as it is in the
        // pinned `engine._renderingContexts`.
        for (const EffectRendererHandle& handle :
             engine.registered_effect_renderers) {
            const EffectRendererRecord& record =
                engine.effect_renderers[handle.value];
            passes.push_back(create_dawn_effect_pass(
                state,
                engine,
                record.effect,
                state.surface_format,
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
        std::vector<double> samples_ms;
        bool running = true;
        long frame = 0;
        while (captures.keep_running(running, frame)) {
            SDL_Event event;
            while (SDL_PollEvent(&event)) {
                if (event.type == SDL_EVENT_QUIT) running = false;
            }
            // A scene-less driver still serves a queued timeout, so a
            // `stopEngine` from one is not a silent no-op here.
            advance_frame(engine);
            const double frame_start = monotonic_milliseconds();

            WGPUSurfaceTexture surface_texture{};
            wgpuSurfaceGetCurrentTexture(state.surface, &surface_texture);
            if (!surface_texture.texture) {
                continue;
            }
            WGPUTextureView surface_view =
                wgpuTextureCreateView(surface_texture.texture, nullptr);

            // Every context updates before any records, which is the pinned
            // loop's order.
            for (std::size_t index = 0; index < passes.size(); ++index) {
                const EffectRendererRecord& record =
                    engine.effect_renderers
                        [engine.registered_effect_renderers[index].value];
                upload_dawn_effect_pass(
                    state.queue,
                    engine,
                    passes[index],
                    record.effect);
            }

            WGPUCommandEncoder encoder =
                wgpuDeviceCreateCommandEncoder(state.device, nullptr);
            WGPURenderPassColorAttachment color_attachment =
                WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
            color_attachment.view = samples > 1 ? msaa_view : surface_view;
            if (samples > 1) color_attachment.resolveTarget = surface_view;
            color_attachment.loadOp =
                first.clear ? WGPULoadOp_Clear : WGPULoadOp_Load;
            color_attachment.storeOp = WGPUStoreOp_Store;
            color_attachment.clearValue = WGPUColor{
                first.clear_color.r,
                first.clear_color.g,
                first.clear_color.b,
                first.clear_color.a};
            WGPURenderPassDescriptor pass_descriptor =
                WGPU_RENDER_PASS_DESCRIPTOR_INIT;
            pass_descriptor.colorAttachmentCount = 1;
            pass_descriptor.colorAttachments = &color_attachment;
            WGPURenderPassEncoder render_pass =
                wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor);
            for (const DawnEffectPass& pass : passes) {
                record_dawn_effect_pass(render_pass, pass);
            }
            wgpuRenderPassEncoderEnd(render_pass);
            wgpuRenderPassEncoderRelease(render_pass);

            const bool capture_frame =
                frame >= frame_options.screenshot_frame &&
                !captures.screenshot_saved &&
                !frame_options.screenshot_path.empty();
            // The render capture describes CPU state alone — the same
            // records the passes above read — written at the frame the
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
            if (benchmark && frame >= warmup) {
                samples_ms.push_back(
                    monotonic_milliseconds() - frame_start);
            }
            frame += 1;
        }
        if (benchmark) {
            report_benchmark(std::move(samples_ms), "Dawn", "D3D12");
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

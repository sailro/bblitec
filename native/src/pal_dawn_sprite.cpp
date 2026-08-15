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

#include "pal_gpu_shared.hpp"

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
    const auto release = [&]() {
        for (DawnSpritePass& pass : passes) {
            release_dawn_sprite_pass(pass);
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

        // Registration order is draw order across renderers, as it is in
        // the pinned `engine._renderingContexts`.
        for (const SpriteRendererHandle& handle :
             engine.registered_sprite_renderers) {
            passes.push_back(create_dawn_sprite_pass(
                state.device,
                state.queue,
                engine,
                handle,
                state.surface_format));
        }
        // The first registered renderer owns the frame's clear, exactly as
        // the first rendering context does upstream.
        const SpriteRendererRecord& first =
            engine.sprite_renderers
                [engine.registered_sprite_renderers.front().value];

        const std::uint32_t width =
            static_cast<std::uint32_t>(engine.options.width);
        const std::uint32_t height =
            static_cast<std::uint32_t>(engine.options.height);
        const long limit = frame_options.frame_budget();
        const bool benchmark = frame_options.benchmarking();
        const long warmup = frame_options.benchmark_warmup();
        CaptureGate captures(frame_options, limit);
        std::vector<double> samples;
        bool running = true;
        long frame = 0;
        FrameClock frame_clock;
        while (captures.keep_running(running, frame)) {
            SDL_Event event;
            while (SDL_PollEvent(&event)) {
                if (event.type == SDL_EVENT_QUIT) running = false;
            }
            const double frame_start = monotonic_milliseconds();
            static_cast<void>(frame_clock.advance(0.0f));

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
                upload_dawn_sprite_pass(
                    state.queue, engine, pass, width, height);
            }

            WGPUCommandEncoder encoder =
                wgpuDeviceCreateCommandEncoder(state.device, nullptr);
            WGPURenderPassColorAttachment color_attachment =
                WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
            color_attachment.view = surface_view;
            color_attachment.loadOp =
                first.clear ? WGPULoadOp_Clear : WGPULoadOp_Load;
            color_attachment.storeOp = WGPUStoreOp_Store;
            color_attachment.clearValue = WGPUColor{
                first.clear_value.r,
                first.clear_value.g,
                first.clear_value.b,
                first.clear_value.a};
            WGPURenderPassDescriptor pass_descriptor =
                WGPU_RENDER_PASS_DESCRIPTOR_INIT;
            pass_descriptor.colorAttachmentCount = 1;
            pass_descriptor.colorAttachments = &color_attachment;
            WGPURenderPassEncoder render_pass =
                wgpuCommandEncoderBeginRenderPass(
                    encoder,
                    &pass_descriptor);
            for (const DawnSpritePass& pass : passes) {
                record_dawn_sprite_pass(render_pass, engine, pass);
            }
            wgpuRenderPassEncoderEnd(render_pass);
            wgpuRenderPassEncoderRelease(render_pass);

            const bool capture_frame =
                frame >= frame_options.screenshot_frame &&
                !captures.screenshot_saved &&
                !frame_options.screenshot_path.empty();
            WGPUBuffer readback = nullptr;
            const std::uint32_t bytes_per_row = (width * 4 + 255) & ~255u;
            if (capture_frame) {
                WGPUBufferDescriptor readback_descriptor =
                    WGPU_BUFFER_DESCRIPTOR_INIT;
                readback_descriptor.usage =
                    WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
                readback_descriptor.size =
                    static_cast<std::uint64_t>(bytes_per_row) * height;
                readback = wgpuDeviceCreateBuffer(
                    state.device,
                    &readback_descriptor);
                WGPUTexelCopyTextureInfo copy_source =
                    WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
                copy_source.texture = surface_texture.texture;
                WGPUTexelCopyBufferInfo copy_destination =
                    WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
                copy_destination.layout.bytesPerRow = bytes_per_row;
                copy_destination.layout.rowsPerImage = height;
                copy_destination.buffer = readback;
                const WGPUExtent3D copy_size{width, height, 1};
                wgpuCommandEncoderCopyTextureToBuffer(
                    encoder,
                    &copy_source,
                    &copy_destination,
                    &copy_size);
            }

            WGPUCommandBuffer command =
                wgpuCommandEncoderFinish(encoder, nullptr);
            wgpuQueueSubmit(state.queue, 1, &command);
            wgpuCommandBufferRelease(command);
            wgpuCommandEncoderRelease(encoder);

            if (capture_frame) {
                WGPUBufferMapCallbackInfo map_callback =
                    WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
                map_callback.mode = WGPUCallbackMode_WaitAnyOnly;
                map_callback.callback = [](
                                            WGPUMapAsyncStatus status,
                                            WGPUStringView message,
                                            void* userdata1,
                                            void*) {
                    if (status != WGPUMapAsyncStatus_Success) {
                        auto* error =
                            static_cast<std::string*>(userdata1);
                        if (error->empty()) *error = view_text(message);
                    }
                };
                map_callback.userdata1 = &state.uncaptured_error;
                wait_for(
                    state.instance,
                    wgpuBufferMapAsync(
                        readback,
                        WGPUMapMode_Read,
                        0,
                        static_cast<std::size_t>(bytes_per_row) * height,
                        map_callback));
                const void* mapped = wgpuBufferGetConstMappedRange(
                    readback,
                    0,
                    static_cast<std::size_t>(bytes_per_row) * height);
                if (!mapped) dawn_error("buffer map returned no data.");
                std::vector<std::uint8_t> pixels(
                    static_cast<const std::uint8_t*>(mapped),
                    static_cast<const std::uint8_t*>(mapped) +
                        static_cast<std::size_t>(bytes_per_row) * height);
                wgpuBufferUnmap(readback);
                save_capture_png(
                    pixels,
                    width,
                    height,
                    bytes_per_row,
                    state.surface_format == WGPUTextureFormat_BGRA8Unorm,
                    frame_options.screenshot_path);
                captures.screenshot_saved = true;
            }
            if (readback) wgpuBufferRelease(readback);

            wgpuSurfacePresent(state.surface);
            wgpuTextureViewRelease(surface_view);
            wgpuTextureRelease(surface_texture.texture);
            if (!state.uncaptured_error.empty()) {
                dawn_error(state.uncaptured_error);
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

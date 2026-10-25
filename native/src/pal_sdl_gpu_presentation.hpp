// Where an SDL_GPU renderer's frames land.
#pragma once
#include <bblite/features/gpu_retirement.hpp>
#include <bblite/features/offscreen_surfaces.hpp>
#include <bblite/features/workers.hpp>

#include <bblite/pal_offscreen.hpp>
#include <bblite/runtime.hpp>

#include <optional>
#include <string>
#include <utility>

#include "pal_platform_events.hpp"
#include "pal_sdl_gpu_shared.hpp"
#if BBLITE_OFFSCREEN_SURFACES
#include "pal_sdl_gpu_offscreen.hpp"
#endif
#if BBLITE_GPU_RETIREMENT && !BBLITE_WORKERS
#include "pal_sdl_gpu_source_device.hpp"
#endif

namespace bbl::pal {

/**
 * The colour image a renderer (scene, 2D, effect, frame graph) draws each
 * frame: the swapchain of the window its run opens or, while an application
 * realm's presentation endpoint (`offscreen`, which the renderer owns) is
 * bound, a leased image on the Window host's shared device that the host
 * composites.
 */
class SdlFramePresentation {
public:
    /**
     * Bind the endpoint's shared device, or open the run's window and device
     * (the engine's source device when GPU resources retire across runs).
     */
    void open([[maybe_unused]] OffscreenRun* offscreen, Engine& engine,
              const std::string& screenshot_path, const DeviceOptions& options, SdlGpuDevice& gpu) {
        refuse_endpoint_capture(offscreen, screenshot_path);
#if BBLITE_OFFSCREEN_SURFACES
        if (offscreen) {
            bind_sdl_offscreen_device(*offscreen, gpu);
            images_.emplace(gpu.device);
        } else
#endif
#if BBLITE_GPU_RETIREMENT && !BBLITE_WORKERS
            bind_sdl_source_device(engine, options, gpu);
#else
        create_sdl_gpu_device(engine.options, options, gpu);
#endif
        sync_engine_canvas_size(gpu.window, engine);
    }

    /** The frame's pixel extent: the window's, or the endpoint canvas's backing store. */
    std::pair<int, int> extent([[maybe_unused]] OffscreenRun* offscreen, SDL_Window* window,
                               [[maybe_unused]] const Engine& engine) const {
#if BBLITE_OFFSCREEN_SURFACES
        if (offscreen)
            return {static_cast<int>(engine.options.width),
                    static_cast<int>(engine.options.height)};
#endif
        int width = 0, height = 0;
        SDL_GetWindowSizeInPixels(window, &width, &height);
        return {width, height};
    }

    /**
     * Lease the frame's endpoint image before the frame does any work; false
     * when none is free, which skips the frame. A window frame is always ready.
     */
    bool lease([[maybe_unused]] OffscreenRun* offscreen, [[maybe_unused]] const Engine& engine) {
#if BBLITE_OFFSCREEN_SURFACES
        if (offscreen) {
            leased_ =
                images_.value().acquire(static_cast<Uint32>(engine.options.width),
                                        static_cast<Uint32>(engine.options.height), *offscreen);
            return leased_ != nullptr;
        }
#endif
        return true;
    }

    /**
     * The frame's colour target and extent: the leased endpoint image (leased
     * now when the frame did not), or the window's swapchain. False is an SDL
     * failure; a null target skips the frame (a hidden window, or no endpoint
     * image free).
     */
    bool acquire(SdlGpuCommand& command, [[maybe_unused]] OffscreenRun* offscreen,
                 SDL_Window* window, [[maybe_unused]] const Engine& engine,
                 SDL_GPUTexture** texture, Uint32* width, Uint32* height) {
#if BBLITE_OFFSCREEN_SURFACES
        if (offscreen) {
            if (!leased_)
                lease(offscreen, engine);
            *width = static_cast<Uint32>(engine.options.width);
            *height = static_cast<Uint32>(engine.options.height);
            *texture = std::exchange(leased_, nullptr);
            return true;
        }
#endif
        return command.acquire_swapchain(window, texture, width, height);
    }

    /** Submit the frame: the window presents its swapchain, the endpoint publishes its image. */
    bool submit(SdlGpuCommand& command, [[maybe_unused]] OffscreenRun* offscreen) {
#if BBLITE_OFFSCREEN_SURFACES
        if (offscreen) {
            images_.value().publish(command, *offscreen);
            return true;
        }
#endif
        return command.submit();
    }

private:
#if BBLITE_OFFSCREEN_SURFACES
    std::optional<SdlOffscreenTarget> images_;
    SDL_GPUTexture* leased_ = nullptr;
#endif
};

} // namespace bbl::pal

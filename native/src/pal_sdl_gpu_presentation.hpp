// Where a standalone SDL_GPU renderer's frames land.
#pragma once
#include <bblite/features/offscreen_surfaces.hpp>

#include <bblite/pal_offscreen.hpp>
#include <bblite/runtime.hpp>

#include <optional>
#include <utility>

#include "pal_platform_events.hpp"
#include "pal_sdl_gpu_shared.hpp"
#if BBLITE_OFFSCREEN_SURFACES
#include "pal_sdl_gpu_offscreen.hpp"
#endif

namespace bbl::pal {

/**
 * The colour image a standalone renderer (2D, effect, frame graph) draws each
 * frame: the swapchain of the window its run opens or, while an application
 * realm's presentation endpoint is bound, a leased image on the Window host's
 * shared device that the host composites.
 */
class SdlFramePresentation {
public:
    /** Open the run's window and device, or bind the endpoint's shared device. */
    void open([[maybe_unused]] OffscreenRun* offscreen, Engine& engine,
              const DeviceOptions& options, SdlGpuDevice& gpu) {
#if BBLITE_OFFSCREEN_SURFACES
        if (offscreen) {
            bind_sdl_offscreen_device(*offscreen, gpu);
            endpoint_.emplace(*offscreen, gpu.device);
        } else
#endif
            create_sdl_gpu_device(engine.options, options, gpu);
        sync_engine_canvas_size(gpu.window, engine);
    }

    /** The frame's pixel extent: the window's, or the endpoint canvas's backing store. */
    std::pair<int, int> extent(SDL_Window* window, [[maybe_unused]] const Engine& engine) const {
#if BBLITE_OFFSCREEN_SURFACES
        if (endpoint_)
            return {static_cast<int>(engine.options.width),
                    static_cast<int>(engine.options.height)};
#endif
        int width = 0, height = 0;
        SDL_GetWindowSizeInPixels(window, &width, &height);
        return {width, height};
    }

    /**
     * The frame's colour target and extent. False is an SDL failure; a null
     * target skips the frame (a hidden window, or no endpoint image free).
     */
    bool acquire(SdlGpuCommand& command, SDL_Window* window, [[maybe_unused]] const Engine& engine,
                 SDL_GPUTexture** texture, Uint32* width, Uint32* height) {
#if BBLITE_OFFSCREEN_SURFACES
        if (endpoint_) {
            const auto [pixels_wide, pixels_high] = extent(window, engine);
            *width = static_cast<Uint32>(pixels_wide);
            *height = static_cast<Uint32>(pixels_high);
            *texture = endpoint_->images.acquire(*width, *height, endpoint_->run);
            return true;
        }
#endif
        return command.acquire_swapchain(window, texture, width, height);
    }

    /** Submit the frame: the window presents its swapchain, the endpoint publishes its image. */
    bool submit(SdlGpuCommand& command) {
#if BBLITE_OFFSCREEN_SURFACES
        if (endpoint_) {
            endpoint_->images.publish(command, endpoint_->run);
            return true;
        }
#endif
        return command.submit();
    }

private:
#if BBLITE_OFFSCREEN_SURFACES
    struct Endpoint {
        Endpoint(OffscreenRun& offscreen, SDL_GPUDevice* device) : run(offscreen), images(device) {}
        OffscreenRun& run;
        SdlOffscreenTarget images;
    };
    std::optional<Endpoint> endpoint_;
#endif
};

} // namespace bbl::pal

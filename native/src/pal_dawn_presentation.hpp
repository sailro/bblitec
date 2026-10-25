// Where a Dawn renderer's frames land.
#pragma once
#include <bblite/features/gpu_retirement.hpp>
#include <bblite/features/offscreen_surfaces.hpp>
#include <bblite/features/workers.hpp>

#include <bblite/pal_offscreen.hpp>
#include <bblite/runtime.hpp>

#include <memory>
#include <string>
#include <utility>

#include "pal_dawn_shared.hpp"
#include "pal_platform_events.hpp"
#if BBLITE_OFFSCREEN_SURFACES
#include "pal_dawn_offscreen.hpp"
#endif
#if BBLITE_GPU_RETIREMENT && !BBLITE_WORKERS
#include "pal_dawn_source_device.hpp"
#endif

namespace bbl::pal {

/**
 * The colour image a renderer (scene, 2D, effect, frame graph) draws each
 * frame: the surface of the window its run opens or, while an application
 * realm's presentation endpoint (`offscreen`, which the renderer owns) is
 * bound, a leased image on the Window host's shared device that the host
 * composites.
 */
class DawnFramePresentation {
public:
    /**
     * Share the endpoint's device, or open the run's window and device (the
     * engine's source device when GPU resources retire across runs).
     */
    void open([[maybe_unused]] OffscreenRun* offscreen, Engine& engine,
              const std::string& screenshot_path, const DeviceOptions& options, DawnDevice& state) {
        refuse_endpoint_capture(offscreen, screenshot_path);
#if BBLITE_OFFSCREEN_SURFACES
        if (offscreen)
            bind_dawn_offscreen_device(*offscreen, engine.options, options, state);
        else
#endif
#if BBLITE_GPU_RETIREMENT && !BBLITE_WORKERS
            bind_dawn_source_device(engine, options, state);
#else
        create_dawn_device(engine.options, options, state);
#endif
        sync_engine_canvas_size(state.window, engine);
        resize_dawn_surface(state, engine.options);
    }

    /** Whether a frame can draw: always into the endpoint, into a window while it has a surface. */
    bool ready([[maybe_unused]] OffscreenRun* offscreen, const DawnDevice& state) const {
#if BBLITE_OFFSCREEN_SURFACES
        if (offscreen)
            return true;
#endif
        return state.surface != nullptr;
    }

    /**
     * Lease the frame's endpoint image before the frame does any work; false
     * when none is free, which skips the frame. A window frame is always ready.
     */
    bool lease([[maybe_unused]] OffscreenRun* offscreen, [[maybe_unused]] DawnDevice& state) {
#if BBLITE_OFFSCREEN_SURFACES
        if (offscreen) {
            leased_ = images_.acquire(state.surface_width, state.surface_height, *offscreen,
                                      [&](std::uint32_t width, std::uint32_t height) {
                                          return std::make_shared<DawnOffscreenImage>(
                                              state.device, state.surface_format, width, height);
                                      });
            return leased_ != nullptr;
        }
#endif
        return true;
    }

    /**
     * The frame's colour texture, retained by `texture`: the leased endpoint
     * image (leased now when the frame did not), or the window surface's;
     * false when none is available.
     */
    bool acquire([[maybe_unused]] OffscreenRun* offscreen, DawnDevice& state,
                 WGPUSurfaceTexture& texture) {
#if BBLITE_OFFSCREEN_SURFACES
        if (offscreen) {
            if (!leased_ && !lease(offscreen, state))
                return false;
            texture = WGPU_SURFACE_TEXTURE_INIT;
            texture.texture = std::exchange(leased_, nullptr)->texture;
            wgpuTextureAddRef(texture.texture);
            return true;
        }
#endif
        return acquire_dawn_surface_texture(state, texture);
    }

    /** After the frame's submission: present the window's surface, or publish the endpoint image. */
    void present([[maybe_unused]] OffscreenRun* offscreen, DawnDevice& state) {
#if BBLITE_OFFSCREEN_SURFACES
        if (offscreen) {
            images_.publish(*offscreen);
            return;
        }
#endif
        wgpuSurfacePresent(state.surface);
    }

private:
#if BBLITE_OFFSCREEN_SURFACES
    OffscreenImagePool<DawnOffscreenImage> images_;
    DawnOffscreenImage* leased_ = nullptr;
#endif
};

} // namespace bbl::pal

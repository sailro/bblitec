// Where a standalone Dawn renderer's frames land.
#pragma once
#include <bblite/features/offscreen_surfaces.hpp>

#include <bblite/pal_offscreen.hpp>
#include <bblite/runtime.hpp>

#include <memory>

#include "pal_dawn_shared.hpp"
#include "pal_platform_events.hpp"
#if BBLITE_OFFSCREEN_SURFACES
#include "pal_dawn_offscreen.hpp"
#endif

namespace bbl::pal {

/**
 * The colour image a standalone renderer (2D, effect, frame graph) draws each
 * frame: the surface of the window its run opens or, while an application
 * realm's presentation endpoint is bound, a leased image on the Window host's
 * shared device that the host composites.
 */
class DawnFramePresentation {
public:
    /** Open the run's window and device, or share the endpoint's (`create_dawn_device`). */
    void open([[maybe_unused]] OffscreenRun* offscreen, Engine& engine,
              const DeviceOptions& options, DawnDevice& state) {
        create_dawn_device(engine.options, options, state);
        sync_engine_canvas_size(state.window, engine);
        resize_dawn_surface(state, engine.options);
#if BBLITE_OFFSCREEN_SURFACES
        offscreen_ = offscreen;
#endif
    }

    /** Whether a frame can draw: always into the endpoint, into a window while it has a surface. */
    bool ready(const DawnDevice& state) const {
#if BBLITE_OFFSCREEN_SURFACES
        if (offscreen_)
            return true;
#endif
        return state.surface != nullptr;
    }

    /** The frame's colour texture, retained by `texture`; false when none is available. */
    bool acquire(DawnDevice& state, WGPUSurfaceTexture& texture) {
#if BBLITE_OFFSCREEN_SURFACES
        if (offscreen_) {
            texture = WGPU_SURFACE_TEXTURE_INIT;
            const auto* image =
                images_.acquire(state.surface_width, state.surface_height, *offscreen_,
                                [&](std::uint32_t width, std::uint32_t height) {
                                    return std::make_shared<DawnOffscreenImage>(
                                        state.device, state.surface_format, width, height);
                                });
            if (!image)
                return false;
            texture.texture = image->texture;
            wgpuTextureAddRef(texture.texture);
            return true;
        }
#endif
        return acquire_dawn_surface_texture(state, texture);
    }

    /** After the frame's submission: present the window's surface, or publish the endpoint image. */
    void present(DawnDevice& state) {
#if BBLITE_OFFSCREEN_SURFACES
        if (offscreen_) {
            images_.publish(*offscreen_);
            return;
        }
#endif
        wgpuSurfacePresent(state.surface);
    }

private:
#if BBLITE_OFFSCREEN_SURFACES
    OffscreenRun* offscreen_ = nullptr;
    OffscreenImagePool<DawnOffscreenImage> images_;
#endif
};

} // namespace bbl::pal

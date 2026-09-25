#pragma once

#include <bblite/features/has_canvas_renderer.hpp>
#include <bblite/features/has_effect_renderer.hpp>
#include <bblite/features/has_frame_graph_renderer.hpp>
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_sprite_renderer.hpp>
#include <bblite/features/has_text_renderer.hpp>
#include <bblite/features/offscreen_surfaces.hpp>

#include <bblite/pal_gpu.hpp>
#include "pal_gpu_backend.hpp"
#if BBLITE_OFFSCREEN_SURFACES
#include "pal_window_presenter.hpp"
#endif
#include <SDL3/SDL.h>
#include <memory>
#include <string_view>

namespace bbl::pal {
class WindowPresenter;

/**
 * One GPU backend as this build compiled it. A renderer family the build did
 * not compile for the backend, or a Window presenter outside Window builds,
 * is null, so a caller refuses it by name instead of by preprocessor branch.
 */
struct GpuBackend {
    std::string_view name;
    SceneRun (*run_scene)(Engine&);
    /** Sprite, text and Canvas2D renderers share the 2D frame host. */
    void (*run_2d)(Engine&);
    void (*run_effects)(Engine&);
    void (*run_frame_graph)(Engine&);
    std::shared_ptr<WindowPresenter> (*create_window_presenter)(SDL_Window*);
    /** Flags the backend's surface needs on the SDL window it presents to. */
    SDL_WindowFlags window_flags;
};

// A family's units are compiled exactly when its macro is 1 (`featureSources`
// selects the SDL_GPU unit, CMake derives the Dawn twin).
#if BBLITE_HAS_PBR_RENDERER
#define BBLITE_GPU_SCENE_ENTRY(entry) &entry
#else
#define BBLITE_GPU_SCENE_ENTRY(entry) nullptr
#endif
#if BBLITE_HAS_SPRITE_RENDERER || BBLITE_HAS_CANVAS_RENDERER || BBLITE_HAS_TEXT_RENDERER
#define BBLITE_GPU_2D_ENTRY(entry) &entry
#else
#define BBLITE_GPU_2D_ENTRY(entry) nullptr
#endif
#if BBLITE_HAS_EFFECT_RENDERER
#define BBLITE_GPU_EFFECT_ENTRY(entry) &entry
#else
#define BBLITE_GPU_EFFECT_ENTRY(entry) nullptr
#endif
#if BBLITE_HAS_FRAME_GRAPH_RENDERER
#define BBLITE_GPU_FRAME_GRAPH_ENTRY(entry) &entry
#else
#define BBLITE_GPU_FRAME_GRAPH_ENTRY(entry) nullptr
#endif
#if BBLITE_OFFSCREEN_SURFACES
#define BBLITE_GPU_WINDOW_ENTRY(entry) &entry
#else
#define BBLITE_GPU_WINDOW_ENTRY(entry) nullptr
#endif

#if BBLITE_HAS_SDL_GPU
inline constexpr GpuBackend sdl_gpu_backend{
    "sdl_gpu",
    BBLITE_GPU_SCENE_ENTRY(run_gpu_engine),
    BBLITE_GPU_2D_ENTRY(run_sprite_gpu_engine),
    BBLITE_GPU_EFFECT_ENTRY(run_effect_gpu_engine),
    BBLITE_GPU_FRAME_GRAPH_ENTRY(run_frame_graph_gpu_engine),
    BBLITE_GPU_WINDOW_ENTRY(create_window_sdl_presenter),
    0,
};
#endif
#if BBLITE_HAS_DAWN
inline constexpr GpuBackend dawn_gpu_backend{
    "dawn",
    BBLITE_GPU_SCENE_ENTRY(run_dawn_engine),
    BBLITE_GPU_2D_ENTRY(run_sprite_dawn_engine),
    BBLITE_GPU_EFFECT_ENTRY(run_effect_dawn_engine),
    BBLITE_GPU_FRAME_GRAPH_ENTRY(run_frame_graph_dawn_engine),
    BBLITE_GPU_WINDOW_ENTRY(create_window_dawn_presenter),
#ifdef __ANDROID__
    // Marks Dawn's external Vulkan context so SDL does not restore an EGL context on resume.
    SDL_WINDOW_VULKAN,
#else
    0,
#endif
};
#endif

#undef BBLITE_GPU_SCENE_ENTRY
#undef BBLITE_GPU_2D_ENTRY
#undef BBLITE_GPU_EFFECT_ENTRY
#undef BBLITE_GPU_FRAME_GRAPH_ENTRY
#undef BBLITE_GPU_WINDOW_ENTRY

/** The backend BBLITE_GPU_BACKEND selects; `use_dawn_backend` refuses one this build lacks. */
inline const GpuBackend& selected_gpu_backend() {
#if BBLITE_HAS_SDL_GPU && BBLITE_HAS_DAWN
    return use_dawn_backend() ? dawn_gpu_backend : sdl_gpu_backend;
#elif BBLITE_HAS_SDL_GPU || BBLITE_HAS_DAWN
    // Refuses a request for the backend this build did not compile.
    static_cast<void>(use_dawn_backend());
#if BBLITE_HAS_DAWN
    return dawn_gpu_backend;
#else
    return sdl_gpu_backend;
#endif
#else
    // A PAL unit compiled without any renderer (a native fixture): every
    // entry is absent, so each caller refuses by name.
    static constexpr GpuBackend none{"none", nullptr, nullptr, nullptr, nullptr, nullptr, 0};
    return none;
#endif
}

} // namespace bbl::pal

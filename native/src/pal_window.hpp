// The OS window belongs to one engine run, not to a scene's GPU resources.
#pragma once

#include <bblite/runtime.hpp>
#include <SDL3/SDL.h>

#include "pal_runtime_trace.hpp"

namespace bbl::pal {

class SdlWindowRun;
// SDL rendering is thread-affine. Keep this PAL-only context off the public,
// backend-neutral Engine record; nested runs restore their caller's context.
inline thread_local SdlWindowRun* active_window_run = nullptr;

inline void trace_run_window(const char* action, SDL_Window* window) {
    if (!runtime_trace_enabled()) return;
    int x = 0, y = 0, width = 0, height = 0;
    SDL_GetWindowPosition(window, &x, &y);
    SDL_GetWindowSize(window, &width, &height);
    std::cerr << "[bblite trace] window " << action
              << " id=" << SDL_GetWindowID(window)
#ifdef _WIN32
              << " native=" << SDL_GetPointerProperty(SDL_GetWindowProperties(window),
                   SDL_PROP_WINDOW_WIN32_HWND_POINTER, nullptr)
#endif
              << " position=" << x << ',' << y
              << " size=" << width << 'x' << height << '\n';
}

class SdlWindowRun {
  public:
    SdlWindowRun() : previous_(active_window_run) {
        active_window_run = this;
    }
    SdlWindowRun(const SdlWindowRun&) = delete;
    SdlWindowRun& operator=(const SdlWindowRun&) = delete;
    ~SdlWindowRun() {
        if (window_) {
            trace_run_window("destroy", window_);
            SDL_DestroyWindow(window_);
        }
        active_window_run = previous_;
        if (initialized_ && !previous_) SDL_Quit();
    }

    bool initialize(SDL_InitFlags flags) {
        const SDL_InitFlags missing = flags & ~SDL_WasInit(0);
        if (missing && !SDL_Init(missing)) return false;
        // An outer run may not have initialized its own backend yet. It
        // still owns final SDL shutdown if a nested run initialized SDL.
        for (auto* run = this; run; run = run->previous_) {
            run->initialized_ = true;
        }
        return true;
    }

    SDL_Window* acquire(const EngineOptions& options, SDL_WindowFlags flags) {
        if (window_) {
            // Do not reset size, position, maximization or focus when the
            // scene changes. The renderer reads the live canvas size next.
            trace_run_window("reuse", window_);
            return window_;
        }
        window_ = SDL_CreateWindow(options.title.c_str(), options.width,
                                   options.height, flags);
        if (window_) trace_run_window("create", window_);
        return window_;
    }

    bool owns(SDL_Window* window) const {
        return window &&
            (window == window_ || (previous_ && previous_->owns(window)));
    }

  private:
    SdlWindowRun* previous_ = nullptr;
    SDL_Window* window_ = nullptr;
    bool initialized_ = false;
};

inline bool initialize_run_sdl(SDL_InitFlags flags) {
    return active_window_run
        ? active_window_run->initialize(flags) : SDL_Init(flags);
}

inline SDL_Window* acquire_run_window(
    const EngineOptions& options, SDL_WindowFlags flags) {
    return active_window_run
        ? active_window_run->acquire(options, flags)
        : SDL_CreateWindow(options.title.c_str(), options.width,
                           options.height, flags);
}

inline void release_run_window(SDL_Window* window) {
    if (window && (!active_window_run || !active_window_run->owns(window))) {
        SDL_DestroyWindow(window);
    }
}

inline void quit_run_sdl() {
    if (!active_window_run) SDL_Quit();
}

} // namespace bbl::pal

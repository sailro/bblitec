// The OS window belongs to one engine run, not to a scene's GPU resources.
#pragma once

#include <bblite/runtime.hpp>
#include <bblite/pal_offscreen.hpp>
#include <cmath>
#include <cstdio>
#include <limits>
#include <SDL3/SDL.h>
#ifdef __ANDROID__
#include <jni.h>
#endif

#include "pal_runtime_trace.hpp"
#ifdef __ANDROID__
#include "pal_gpu_dispatch.hpp"
#endif

namespace bbl::pal {

class SdlWindowRun;
// SDL rendering is thread-affine. Keep this PAL-only context off the public,
// backend-neutral Engine record; nested runs restore their caller's context.
inline thread_local SdlWindowRun* active_window_run = nullptr;

// stdio, not iostream: the window destructor reports through here and must
// not reach a stream that can be configured to throw.
inline void trace_run_window(const char* action, SDL_Window* window) {
    if (!runtime_trace_enabled())
        return;
    int x = 0, y = 0, width = 0, height = 0;
    SDL_GetWindowPosition(window, &x, &y);
    SDL_GetWindowSize(window, &width, &height);
    std::fprintf(stderr, "[bblite trace] window %s id=%u", action,
                 static_cast<unsigned>(SDL_GetWindowID(window)));
#ifdef _WIN32
    std::fprintf(stderr, " native=%p",
                 SDL_GetPointerProperty(SDL_GetWindowProperties(window),
                                        SDL_PROP_WINDOW_WIN32_HWND_POINTER, nullptr));
#endif
    std::fprintf(stderr, " position=%d,%d size=%dx%d\n", x, y, width, height);
}

// Native windows keep their platform density; `maxDevicePixelRatio` sizes canvases only.
inline void configure_run_surface([[maybe_unused]] const EngineOptions& options) {
#ifdef __ANDROID__
    SDL_SetHint(SDL_HINT_ORIENTATIONS, "LandscapeLeft LandscapeRight");
    auto* env = static_cast<JNIEnv*>(SDL_GetAndroidJNIEnv());
    auto activity = static_cast<jobject>(SDL_GetAndroidActivity());
    if (!env || !activity)
        throw std::runtime_error("Android activity unavailable.");
    const jclass type = env->GetObjectClass(activity);
    const jmethodID configure = env->GetMethodID(type, "configureSurface", "(D)Z");
    const bool configured =
        configure && env->CallBooleanMethod(activity, configure,
                                            std::numeric_limits<double>::infinity());
    const bool exception = env->ExceptionCheck();
    if (exception)
        env->ExceptionClear();
    env->DeleteLocalRef(type);
    env->DeleteLocalRef(activity);
    if (!configured || exception)
        throw std::runtime_error("Android surface configuration failed.");
#endif
}

inline SDL_WindowFlags run_window_flags(SDL_WindowFlags flags,
                                        [[maybe_unused]] const EngineOptions& options) {
#ifdef __ANDROID__
    flags |= SDL_WINDOW_FULLSCREEN | selected_gpu_backend().window_flags;
#elif defined(SDL_PLATFORM_IOS)
    flags |= SDL_WINDOW_FULLSCREEN | SDL_WINDOW_HIGH_PIXEL_DENSITY;
#endif
    return flags;
}

inline float window_render_density(SDL_Window* window,
                                   [[maybe_unused]] const EngineOptions& options) {
    float density = SDL_GetWindowDisplayScale(window);
    if (density <= 0)
        density = 1;
    return density;
}

class SdlWindowRun {
public:
    struct Resources {
        std::shared_ptr<Resources> parent;
        SDL_Window* window = nullptr;
        SDL_InitFlags initialized = 0;
        ~Resources() {
            if (window) {
                trace_run_window("destroy", window);
                SDL_DestroyWindow(window);
            }
            if (initialized && !parent)
                SDL_QuitSubSystem(initialized);
        }
    };

    SdlWindowRun() : previous_(active_window_run), resources_(std::make_shared<Resources>()) {
        if (previous_)
            resources_->parent = previous_->resources_;
        active_window_run = this;
    }
    SdlWindowRun(const SdlWindowRun&) = delete;
    SdlWindowRun& operator=(const SdlWindowRun&) = delete;
    ~SdlWindowRun() { active_window_run = previous_; }
    std::shared_ptr<Resources> retain_resources() const { return resources_; }
    void use_resources(const std::shared_ptr<Resources>& resources) {
        if (resources_->window && resources_->window != resources->window)
            throw std::runtime_error("An engine cannot replace a live GPU window.");
        resources_ = resources;
    }

    bool initialize(SDL_InitFlags flags) {
        const SDL_InitFlags missing = flags & ~SDL_WasInit(0);
        if (missing && !SDL_Init(missing))
            return false;
        // An outer run may not have initialized its own backend yet. It
        // still owns final SDL shutdown if a nested run initialized SDL.
        for (auto* run = this; run; run = run->previous_) {
            run->resources_->initialized |= missing;
        }
        return true;
    }

    SDL_Window* acquire(const EngineOptions& options, SDL_WindowFlags flags) {
#if defined(SDL_PLATFORM_IOS)
        // UIKit has one application window, acquired before source setup reads
        // its canvas extent and borrowed by renderer/recovery scopes.
        if (previous_)
            return previous_->acquire(options, flags);
#endif
        if (resources_->window) {
            // Do not reset size, position, maximization or focus when the
            // scene changes. The renderer reads the live canvas size next.
            trace_run_window("reuse", resources_->window);
            return resources_->window;
        }
        configure_run_surface(options);
        resources_->window = SDL_CreateWindow(options.title.c_str(), options.width, options.height,
                                              run_window_flags(flags, options));
        if (resources_->window)
            trace_run_window("create", resources_->window);
        return resources_->window;
    }

    bool owns(SDL_Window* window) const {
        return window && (window == resources_->window || (previous_ && previous_->owns(window)));
    }

private:
    SdlWindowRun* previous_ = nullptr;
    std::shared_ptr<Resources> resources_;
};

inline bool initialize_run_sdl(SDL_InitFlags flags) {
    // Offscreen producers own no SDL video/event lifecycle. Their host must
    // initialize it on the OS thread before starting them and join them before
    // shutdown; a worker must never initialize video or call SDL_Quit.
    if (OffscreenRun::current())
        return (SDL_WasInit(flags) & flags) == flags;
    return active_window_run ? active_window_run->initialize(flags) : SDL_Init(flags);
}

inline SDL_Window* acquire_run_window(const EngineOptions& options, SDL_WindowFlags flags) {
    if (active_window_run)
        return active_window_run->acquire(options, flags);
    configure_run_surface(options);
    return SDL_CreateWindow(options.title.c_str(), options.width, options.height,
                            run_window_flags(flags, options));
}

inline void release_run_window(SDL_Window* window) {
    if (window && (!active_window_run || !active_window_run->owns(window))) {
        SDL_DestroyWindow(window);
    }
}

/**
 * The one system cursor the canvas surface reaches (`cursor: crosshair`),
 * created on first use and destroyed with the SDL run rather than leaked.
 */
inline SDL_Cursor*& crosshair_cursor() {
    static SDL_Cursor* cursor = nullptr;
    return cursor;
}

inline void release_canvas_cursors() {
    SDL_Cursor*& cursor = crosshair_cursor();
    if (cursor) {
        SDL_DestroyCursor(cursor);
        cursor = nullptr;
    }
}

inline void quit_run_sdl() {
    if (OffscreenRun::current())
        return;
    if (!active_window_run) {
        release_canvas_cursors();
        SDL_Quit();
    }
}

} // namespace bbl::pal

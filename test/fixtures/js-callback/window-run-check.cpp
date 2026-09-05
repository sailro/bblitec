#include "pal_window.hpp"
#include <cassert>
#include <stdexcept>

namespace bbl::pal {
std::string environment_variable(const char*) { return {}; }
}

int main() {
    using namespace bbl::pal;
    bbl::EngineOptions options;
    options.title = "window lifetime test";
    options.width = 200;
    options.height = 100;
    constexpr SDL_WindowFlags flags = SDL_WINDOW_HIDDEN | SDL_WINDOW_RESIZABLE;
    {
        SdlWindowRun run;
        assert(initialize_run_sdl(SDL_INIT_VIDEO | SDL_INIT_EVENTS));
        auto* first = acquire_run_window(options, flags);
        assert(first);
        const auto id = SDL_GetWindowID(first);
        assert(SDL_SetWindowSize(first, 360, 220));
        assert(SDL_SetWindowPosition(first, 17, 25));
        int x = 0, y = 0, width = 0, height = 0;
        assert(SDL_GetWindowPosition(first, &x, &y));
        assert(SDL_GetWindowSize(first, &width, &height));
        // Simulate renderer teardown/recreation without touching a GPU.
        for (int mode = 0; mode < 4; ++mode) {
            release_run_window(first);
            quit_run_sdl();
            assert(SDL_GetWindowFromID(id) == first);
            assert(initialize_run_sdl(SDL_INIT_VIDEO | SDL_INIT_EVENTS));
            assert(acquire_run_window(options, flags) == first);
            int next_x = 0, next_y = 0, next_width = 0, next_height = 0;
            assert(SDL_GetWindowPosition(first, &next_x, &next_y));
            assert(SDL_GetWindowSize(first, &next_width, &next_height));
            assert(next_x == x && next_y == y && next_width == width && next_height == height);
        }
        {
            SdlWindowRun nested;
            assert(initialize_run_sdl(SDL_INIT_VIDEO | SDL_INIT_EVENTS));
            auto* second = acquire_run_window(options, flags);
            assert(second && second != first);
        }
        assert(SDL_GetWindowFromID(id) == first);
        assert(acquire_run_window(options, flags) == first);
    }
    assert(!active_window_run && SDL_WasInit(SDL_INIT_VIDEO) == 0);
    {
        SdlWindowRun unused_outer;
        {
            SdlWindowRun initialized_inner;
            assert(initialize_run_sdl(SDL_INIT_VIDEO | SDL_INIT_EVENTS));
            assert(acquire_run_window(options, flags));
        }
        assert(SDL_WasInit(SDL_INIT_VIDEO) != 0);
    }
    assert(!active_window_run && SDL_WasInit(SDL_INIT_VIDEO) == 0);
    try {
        SdlWindowRun exceptional;
        assert(initialize_run_sdl(SDL_INIT_VIDEO | SDL_INIT_EVENTS));
        assert(acquire_run_window(options, flags));
        throw std::runtime_error("simulated device initialization failure");
    } catch (const std::runtime_error&) {}
    assert(!active_window_run && SDL_WasInit(SDL_INIT_VIDEO) == 0);
    // Direct backend entry points retain their independent cleanup behavior.
    assert(initialize_run_sdl(SDL_INIT_VIDEO | SDL_INIT_EVENTS));
    auto* standalone = acquire_run_window(options, flags);
    assert(standalone);
    const auto standalone_id = SDL_GetWindowID(standalone);
    release_run_window(standalone);
    assert(!SDL_GetWindowFromID(standalone_id));
    quit_run_sdl();
    assert(SDL_WasInit(SDL_INIT_VIDEO) == 0);
    std::cout << "window-run-check: ok\n";
}

#include <SDL3/SDL.h>
#include <bblite/uncaught_error.hpp>
#include <cstdlib>
#include <iostream>
#include "pal_generated_entry.hpp"

#define main bblite_generated_main
#include BBLITE_IOS_ENTRY
#undef main

// SDL supplies UIApplicationMain and enters the generated program on the OS thread.
#include <SDL3/SDL_main.h>
#if defined(SDL_PLATFORM_IOS) && !BBLITE_OFFSCREEN_SURFACES
#include "pal_window.hpp"
#endif

int main(int argc, char** argv) {
    SDL_SetHint(SDL_HINT_ORIENTATIONS, "LandscapeLeft LandscapeRight");
    SDL_SetHint(SDL_HINT_IOS_HIDE_HOME_INDICATOR, "2");
    const int result = [&] {
        try {
#if defined(SDL_PLATFORM_IOS) && !BBLITE_OFFSCREEN_SURFACES
            bbl::pal::SdlWindowRun application_window;
#endif
            return bbl::pal::run_generated_entry(bblite_generated_main, argc, argv);
        } catch (...) {
            return bbl::report_uncaught_error(std::current_exception());
        }
    }();
    const char* run_id = SDL_getenv("BBLITE_RUN_ID");
    std::cerr << "Native exit: " << result << " run=" << (run_id ? run_id : "interactive") << '\n';
#if defined(SDL_PLATFORM_IOS)
    // SDL keeps UIApplication running after SDL_main returns. This entry has
    // finished its native loops, including teardown, so preserve its exit code.
    std::exit(result);
#endif
    return result;
}

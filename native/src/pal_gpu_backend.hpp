#pragma once

#include <bblite/pal.hpp>
#include <stdexcept>

namespace bbl::pal {

inline bool use_dawn_backend() {
#if BBLITE_HAS_SDL_GPU
    constexpr bool has_sdl = true;
#else
    constexpr bool has_sdl = false;
#endif
#if BBLITE_HAS_DAWN
    constexpr bool has_dawn = true;
#else
    constexpr bool has_dawn = false;
#endif
    const auto requested = environment_variable("BBLITE_GPU_BACKEND");
    if (!requested.empty() && requested != "sdl_gpu" && requested != "dawn") {
        throw std::invalid_argument("BBLITE_GPU_BACKEND must be sdl_gpu or dawn.");
    }
    const bool dawn = requested == "dawn" || (requested.empty() && !has_sdl);
    if ((dawn && !has_dawn) || (!dawn && !has_sdl)) {
        throw std::runtime_error(dawn ? "Dawn is not compiled into this build."
                                      : "SDL_GPU is not compiled into this build.");
    }
    return dawn;
}

} // namespace bbl::pal

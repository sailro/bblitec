#pragma once

#include <chrono>
#include <stdexcept>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace bbl::pal {

/** Shared by preference consumers; refreshes without changing the user's setting. */
inline bool system_reduced_motion() {
#if defined(_WIN32)
    using Clock = std::chrono::steady_clock;
    static thread_local Clock::time_point checked{};
    static thread_local bool initialized = false;
    static thread_local bool reduced = false;
    const auto now = Clock::now();
    if (!initialized || now - checked >= std::chrono::seconds(1)) {
        BOOL animations = TRUE;
        if (!SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &animations, 0))
            throw std::runtime_error("Could not read the platform animation preference.");
        reduced = animations == FALSE;
        checked = now;
        initialized = true;
    }
    return reduced;
#else
    throw std::runtime_error("Platform motion preferences are not implemented on this platform.");
#endif
}

} // namespace bbl::pal

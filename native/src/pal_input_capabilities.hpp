// The platform's pointing devices, as the pointer and hover media features report them.
#pragma once

#include <bblite/pal_window_objects.hpp>

#include <SDL3/SDL.h>

#include <stdexcept>
#include <string>

namespace bbl::pal {
/** How many touch devices SDL reports. */
[[nodiscard]] inline int touch_device_count() {
    int count = 0;
    auto* touches = SDL_GetTouchDevices(&count);
    if (!touches)
        throw std::runtime_error(std::string("SDL_GetTouchDevices: ") + SDL_GetError());
    SDL_free(touches);
    return count;
}

/**
 * The primary pointing device, as the browser on this device reports it: a
 * mouse points finely and hovers (desktop), touch alone points coarsely and
 * cannot hover (a touch phone), and without either nothing points.
 */
[[nodiscard]] inline InputCapabilities platform_input_capabilities() {
    if (SDL_HasMouse())
        return {PointerPrecision::Fine, true};
    return {touch_device_count() > 0 ? PointerPrecision::Coarse : PointerPrecision::None, false};
}
} // namespace bbl::pal

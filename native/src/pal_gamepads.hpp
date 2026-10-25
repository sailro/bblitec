// The Window's gamepads, kept from SDL's gamepad events (pal_sdl.cpp).
#pragma once

#include <bblite/features/has_gamepad.hpp>

#if BBLITE_HAS_GAMEPAD
#include <bblite/runtime.hpp>

#include <SDL3/SDL.h>

#include <vector>

namespace bbl {

/**
 * Applies one SDL event to the Window's gamepads (W3C Gamepad): a device
 * added or removed, or the first gamepad user gesture, which exposes every
 * connected pad. Returns the connections the Window announces, in order.
 */
std::vector<GamepadConnection> apply_gamepad_event(const SDL_Event& event);

} // namespace bbl
#endif

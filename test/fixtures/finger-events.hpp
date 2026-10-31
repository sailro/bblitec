// An SDL finger event as a touch device reports it, for fixtures that inject touches.
#pragma once
#include <SDL3/SDL.h>

/** Finger `finger` of touch device `touch` at window-normalized (x, y), `timestamp` in SDL
 * nanoseconds. */
inline SDL_Event finger_event(Uint32 type, SDL_TouchID touch, SDL_FingerID finger, float x, float y,
                              SDL_WindowID window = 0, Uint64 timestamp = 0) {
    SDL_Event event{};
    event.type = type;
    event.tfinger.timestamp = timestamp;
    event.tfinger.windowID = window;
    event.tfinger.touchID = touch;
    event.tfinger.fingerID = finger;
    event.tfinger.x = x;
    event.tfinger.y = y;
    return event;
}

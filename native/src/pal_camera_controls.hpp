// Camera input controls shared by the SDL_Renderer, SDL_GPU, and
// Dawn frame loops (moved verbatim from pal_sdl.cpp so every backend
// applies identical pointer, wheel, and keyboard semantics).
#pragma once

#include <bblite/runtime.hpp>

#if defined(BBLITE_HAS_SDL) && BBLITE_HAS_SDL

#include <bblite/upstream/camera_controls.hpp>

#include <SDL3/SDL.h>

#include <algorithm>

namespace bbl::pal {

struct CameraPointerState {
    bool orbiting = false;
    bool panning = false;
};

inline void handle_camera_pointer_event(
    const SDL_Event& event,
    CameraRecord& camera,
    CameraPointerState& state) {
    if (!camera.controls_enabled) {
        return;
    }

    if (event.type == SDL_EVENT_MOUSE_BUTTON_DOWN || event.type == SDL_EVENT_MOUSE_BUTTON_UP) {
        const bool pressed = event.type == SDL_EVENT_MOUSE_BUTTON_DOWN;
        if (event.button.button == SDL_BUTTON_LEFT) {
            state.orbiting = pressed;
        } else if (event.button.button == SDL_BUTTON_RIGHT || event.button.button == SDL_BUTTON_MIDDLE) {
            state.panning = pressed;
        }
        return;
    }

    if (event.type == SDL_EVENT_MOUSE_MOTION) {
        if (camera.kind == CameraKind::free) {
            if (state.orbiting) {
                camera.inertial_yaw_offset +=
                    event.motion.xrel / camera.angular_sensibility;
                camera.inertial_pitch_offset -=
                    event.motion.yrel / camera.angular_sensibility;
            }
            return;
        }
        if (state.orbiting) {
            camera.inertial_alpha_offset -= event.motion.xrel / camera.angular_sensibility;
            camera.inertial_beta_offset -= event.motion.yrel / camera.angular_sensibility;
        }
        if (state.panning) {
            camera.inertial_panning_x += -event.motion.xrel / camera.panning_sensibility;
            camera.inertial_panning_y += event.motion.yrel / camera.panning_sensibility;
        }
        return;
    }

    if (event.type == SDL_EVENT_MOUSE_WHEEL) {
        float delta = event.wheel.y;
        if (event.wheel.direction == SDL_MOUSEWHEEL_FLIPPED) {
            delta = -delta;
        }
        camera.inertial_radius_offset -=
            (delta * camera.radius) / std::max(camera.wheel_precision * 10.0f, 1.0f);
    }
}

inline void update_camera(CameraRecord& camera) {
    if (!camera.controls_enabled) {
        return;
    }
    int key_count = 0;
    const bool* keys = SDL_GetKeyboardState(&key_count);
    const auto pressed = [keys, key_count](SDL_Scancode scancode) {
        const int index = static_cast<int>(scancode);
        return index >= 0 && index < key_count && keys[index];
    };
    if (camera.kind == CameraKind::free) {
        constexpr float nominal_frame_scale = 0.05270463f;
        const float movement = camera.speed * nominal_frame_scale;
        if (pressed(SDL_SCANCODE_W) || pressed(SDL_SCANCODE_UP)) {
            camera.inertial_direction.z += movement;
        }
        if (pressed(SDL_SCANCODE_S) || pressed(SDL_SCANCODE_DOWN)) {
            camera.inertial_direction.z -= movement;
        }
        if (pressed(SDL_SCANCODE_A) || pressed(SDL_SCANCODE_LEFT)) {
            camera.inertial_direction.x -= movement;
        }
        if (pressed(SDL_SCANCODE_D) || pressed(SDL_SCANCODE_RIGHT)) {
            camera.inertial_direction.x += movement;
        }
        if (pressed(SDL_SCANCODE_SPACE) || pressed(SDL_SCANCODE_PAGEUP)) {
            camera.inertial_direction.y += movement;
        }
        if (
            pressed(SDL_SCANCODE_LSHIFT) ||
            pressed(SDL_SCANCODE_RSHIFT) ||
            pressed(SDL_SCANCODE_PAGEDOWN)) {
            camera.inertial_direction.y -= movement;
        }
        upstream::apply_free_camera_inertia(camera);
        return;
    }
    upstream::apply_arc_rotate_inertia(camera);
    if (pressed(SDL_SCANCODE_LEFT)) camera.alpha -= 0.02f;
    if (pressed(SDL_SCANCODE_RIGHT)) camera.alpha += 0.02f;
    if (pressed(SDL_SCANCODE_UP)) camera.beta = std::max(0.1f, camera.beta - 0.02f);
    if (pressed(SDL_SCANCODE_DOWN)) camera.beta = std::min(pi - 0.1f, camera.beta + 0.02f);
    if (pressed(SDL_SCANCODE_W)) camera.radius = std::max(0.25f, camera.radius - 0.08f);
    if (pressed(SDL_SCANCODE_S)) camera.radius += 0.08f;
}

} // namespace bbl::pal

#endif

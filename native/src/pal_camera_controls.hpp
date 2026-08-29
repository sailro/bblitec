// Camera controls layered over the application event bridge. Scene-less
// drivers include pal_platform_events.hpp directly and pull no camera code.
#pragma once

#include <bblite/runtime.hpp>

#include <bblite/upstream/camera_controls.hpp>

#include <SDL3/SDL.h>

#include <algorithm>

#include "pal_platform_events.hpp"

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

    if (
        event.type == SDL_EVENT_MOUSE_BUTTON_DOWN ||
        event.type == SDL_EVENT_MOUSE_BUTTON_UP) {
        const bool pressed = event.type == SDL_EVENT_MOUSE_BUTTON_DOWN;
        if (event.button.button == SDL_BUTTON_LEFT) {
            state.orbiting = pressed;
        } else if (
            event.button.button == SDL_BUTTON_RIGHT ||
            event.button.button == SDL_BUTTON_MIDDLE) {
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
            camera.inertial_alpha_offset -=
                event.motion.xrel / camera.angular_sensibility;
            camera.inertial_beta_offset -=
                event.motion.yrel / camera.angular_sensibility;
        }
        if (state.panning) {
            camera.inertial_panning_x +=
                -event.motion.xrel / camera.panning_sensibility;
            camera.inertial_panning_y +=
                event.motion.yrel / camera.panning_sensibility;
        }
        return;
    }

    if (event.type == SDL_EVENT_MOUSE_WHEEL) {
        double delta = event.wheel.y;
        if (event.wheel.direction == SDL_MOUSEWHEEL_FLIPPED) {
            delta = -delta;
        }
        camera.inertial_radius_offset -=
            (delta * camera.radius) /
            std::max(camera.wheel_precision * 10.0, 1.0);
    }
}

inline void update_camera(CameraRecord& camera) {
    if (!camera.controls_enabled) {
        return;
    }
    if (camera.kind != CameraKind::free) {
        // The pinned ArcRotate attachControl surface is pointer-only. In
        // particular, it does not claim arrows or W/S from an application
        // that installs its own window keyboard handlers.
        upstream::apply_arc_rotate_inertia(camera);
        return;
    }

    int key_count = 0;
    const bool* keys = SDL_GetKeyboardState(&key_count);
    const auto pressed = [keys, key_count](SDL_Scancode scancode) {
        const int index = static_cast<int>(scancode);
        return index >= 0 && index < key_count && keys[index];
    };
    // The pin's per-frame move scale, evaluated at the fixed 60 FPS
    // step this loop runs: free-camera-controls.ts computes
    // moveSpeed = speed * sqrt(dt * dt / 1e5) each frame, and
    // dt = 1000/60 ms gives (1000/60) / sqrt(1e5) = 0.05270463.
    constexpr double nominal_frame_scale = 0.05270463;
    const double movement = camera.speed * nominal_frame_scale;
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
}

} // namespace bbl::pal

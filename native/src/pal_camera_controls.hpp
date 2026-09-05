// Camera controls layered over the application event bridge. Scene-less
// drivers include pal_platform_events.hpp directly and pull no camera code.
//
// Every control formula lives in the generated camera_controls TU
// (bblite/upstream/camera_controls.hpp), lowered from the pinned
// attachControl/attachFreeControl declarations. This header only
// translates SDL buttons, motion deltas, wheel detents, and scancodes
// into the pinned units and calls the generated accumulators.
#pragma once

#include <bblite/runtime.hpp>

#include <bblite/upstream/camera_controls.hpp>

#include <SDL3/SDL.h>

#include "pal_platform_events.hpp"

namespace bbl::pal {

struct CameraPointerState {
    bool orbiting = false;
    bool panning = false;
};

// The fixed frame step this loop runs at, handed to the generated
// free_camera_move_speed so the pin's own formula computes the per-frame
// move scale at full precision. The cadence is the platform's fact; the
// formula is the pin's.
inline constexpr double nominal_frame_milliseconds = 1000.0 / 60.0;

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
        if (pressed && camera.should_handle_pointer_down &&
            !camera.should_handle_pointer_down()) {
            state = {};
            return;
        }
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
        if ((state.orbiting || state.panning) &&
            camera.external_drag_active && camera.external_drag_active()) {
            state = {};
            camera.inertial_alpha_offset = 0.0;
            camera.inertial_beta_offset = 0.0;
            camera.inertial_panning_x = 0.0;
            camera.inertial_panning_y = 0.0;
            return;
        }
        if (camera.external_pick_pending && camera.external_pick_pending()) return;
        if (camera.kind == CameraKind::free) {
            if (state.orbiting) {
                upstream::apply_free_camera_pointer_rotation(
                    camera, event.motion.xrel, event.motion.yrel);
            }
            return;
        }
        if (state.orbiting) {
            upstream::apply_arc_rotate_pointer_rotation(
                camera, event.motion.xrel, event.motion.yrel);
        }
        if (state.panning) {
            upstream::apply_arc_rotate_pointer_pan(
                camera, event.motion.xrel, event.motion.yrel);
        }
        return;
    }

    if (event.type == SDL_EVENT_MOUSE_WHEEL) {
        // The pinned onWheel consumes a DOM WheelEvent deltaY; the one
        // translation of SDL's detents into that convention (sign and the
        // 100-pixel notch) is the application bridge's, so both wheel
        // consumers cannot disagree on it.
        upstream::apply_arc_rotate_wheel(
            camera, dom_wheel_delta_y(event.wheel));
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
    // The pin's per-frame move scale (free-camera-controls.ts computes
    // moveSpeed from the frame's delta milliseconds), evaluated by the
    // generated formula at the fixed step this loop runs.
    const double movement = upstream::free_camera_move_speed(
        camera, nominal_frame_milliseconds);
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

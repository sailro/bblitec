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
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
#include <bblite/pal_ui.hpp>
#endif

#include <bblite/upstream/camera_controls.hpp>

#include <SDL3/SDL.h>

#include "pal_platform_events.hpp"

namespace bbl::pal {

struct CameraPointerState {
    bool orbiting = false;
    bool panning = false;
    std::map<std::pair<std::uint64_t, std::uint64_t>, std::array<double, 2>> touches;
};

struct SurfaceCameraPointerState {
    CameraPointerState pointer;
    CameraHandle captured{};
};

// The fixed frame step this loop runs at, handed to the generated
// free_camera_move_speed so the pin's own formula computes the per-frame
// move scale at full precision. The cadence is the platform's fact; the
// formula is the pin's.
inline constexpr double nominal_frame_milliseconds = 1000.0 / 60.0;

inline void handle_camera_pointer_event(const SDL_Event& event, CameraRecord& camera,
                                        CameraPointerState& state, double touch_width = 1,
                                        double touch_height = 1) {
    if (event.type == SDL_EVENT_WINDOW_FOCUS_LOST) {
        state = {};
        return;
    }
    if (!camera.controls_enabled) {
        return;
    }

    if (is_touch_event(event)) {
        const auto key = std::pair{event.tfinger.touchID, event.tfinger.fingerID};
        const std::array<double, 2> point{event.tfinger.x * touch_width,
                                          event.tfinger.y * touch_height};
        const auto span = [&] {
            auto first = state.touches.begin(), second = std::next(first);
            return std::hypot(first->second[0] - second->second[0],
                              first->second[1] - second->second[1]);
        };
        if (event.type == SDL_EVENT_FINGER_DOWN) {
            if (camera.should_handle_pointer_down && !camera.should_handle_pointer_down()) {
                state = {};
                return;
            }
            state.touches.insert_or_assign(key, point);
            state.orbiting = state.touches.size() == 1;
            state.panning = false;
            return;
        }
        const auto found = state.touches.find(key);
        if (found == state.touches.end())
            return;
        if (event.type == SDL_EVENT_FINGER_UP || event.type == SDL_EVENT_FINGER_CANCELED) {
            state.touches.erase(found);
            state.orbiting = state.touches.size() == 1;
            return;
        }
        SDL_Event translated{};
        if (state.touches.size() == 1) {
            translated.type = SDL_EVENT_MOUSE_MOTION;
            translated.motion.xrel = static_cast<float>(point[0] - found->second[0]);
            translated.motion.yrel = static_cast<float>(point[1] - found->second[1]);
        } else if (state.touches.size() == 2) {
            const double previous = span();
            found->second = point;
            const double current = span();
            if (previous <= 0 || current <= 0)
                return;
            translated.type = SDL_EVENT_MOUSE_WHEEL;
            // A proportional gesture produces the same zoom at every DPI.
            translated.wheel.y = static_cast<float>(touch_wheel_delta_y(previous, current) / -100);
        }
        found->second = point;
        handle_camera_pointer_event(translated, camera, state);
        return;
    }

    if (event.type == SDL_EVENT_MOUSE_BUTTON_DOWN || event.type == SDL_EVENT_MOUSE_BUTTON_UP) {
        const bool pressed = event.type == SDL_EVENT_MOUSE_BUTTON_DOWN;
        if (pressed && camera.should_handle_pointer_down && !camera.should_handle_pointer_down()) {
            state = {};
            return;
        }
        if (event.button.button == SDL_BUTTON_LEFT) {
            state.orbiting = pressed;
        } else if (event.button.button == SDL_BUTTON_RIGHT ||
                   event.button.button == SDL_BUTTON_MIDDLE) {
            state.panning = pressed;
        }
        return;
    }

    if (event.type == SDL_EVENT_MOUSE_MOTION) {
        if ((state.orbiting || state.panning) && camera.external_drag_active &&
            camera.external_drag_active()) {
            state = {};
            camera.inertial_alpha_offset = 0.0;
            camera.inertial_beta_offset = 0.0;
            camera.inertial_panning_x = 0.0;
            camera.inertial_panning_y = 0.0;
            return;
        }
        if (camera.external_pick_pending && camera.external_pick_pending())
            return;
        if (camera.kind == CameraKind::geospatial) {
            // The pinned geospatial pointer input reaches its own
            // accumulators, not the ArcRotate ones below.
            return;
        }
        if (camera.kind == CameraKind::free) {
            if (state.orbiting) {
                upstream::apply_free_camera_pointer_rotation(camera, event.motion.xrel,
                                                             event.motion.yrel);
            }
            return;
        }
        if (state.orbiting) {
            upstream::apply_arc_rotate_pointer_rotation(camera, event.motion.xrel,
                                                        event.motion.yrel);
        }
        if (state.panning) {
            upstream::apply_arc_rotate_pointer_pan(camera, event.motion.xrel, event.motion.yrel);
        }
        return;
    }

    if (event.type == SDL_EVENT_MOUSE_WHEEL) {
        // The pinned onWheel consumes a DOM WheelEvent deltaY; the one
        // translation of SDL's detents into that convention (sign and the
        // 100-pixel notch) is the application bridge's, so both wheel
        // consumers cannot disagree on it.
        upstream::apply_arc_rotate_wheel(camera, dom_wheel_delta_y(event.wheel));
    }
}

inline void dispatch_surface_camera_pointer([[maybe_unused]] Engine& engine, const SDL_Event& event,
                                            CameraRecord& primary,
                                            CameraPointerState& primary_state,
                                            SurfaceCameraPointerState& surfaces) {
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
    if (engine.surface_canvas) {
        if (surfaces.captured.value < engine.cameras.size()) {
            const auto index = surfaces.captured.value;
            handle_camera_pointer_event(event, engine.cameras[index], surfaces.pointer,
                                        engine.canvas_client_width, engine.canvas_client_height);
            if (!surfaces.pointer.orbiting && !surfaces.pointer.panning &&
                surfaces.pointer.touches.empty())
                surfaces.captured = {};
            return;
        }
        double x = 0, y = 0;
        if (event.type == SDL_EVENT_MOUSE_BUTTON_DOWN) {
            x = event.button.x * engine.canvas_window_to_client_scale;
            y = event.button.y * engine.canvas_window_to_client_scale;
        } else if (event.type == SDL_EVENT_MOUSE_WHEEL) {
            x = event.wheel.mouse_x * engine.canvas_window_to_client_scale;
            y = event.wheel.mouse_y * engine.canvas_window_to_client_scale;
        } else if (event.type == SDL_EVENT_FINGER_DOWN) {
            x = event.tfinger.x * engine.canvas_client_width;
            y = event.tfinger.y * engine.canvas_client_height;
        } else
            return;
        for (const auto& scene : engine.registered_scenes) {
            if (!scene || !scene->surface_canvas || scene->camera.value >= engine.cameras.size())
                continue;
            const auto rect = ui_get_client_rect(engine, *scene->surface_canvas);
            if (x < rect.left || y < rect.top || x >= rect.left + rect.width ||
                y >= rect.top + rect.height)
                continue;
            const auto index = scene->camera.value;
            handle_camera_pointer_event(event, engine.cameras[index], surfaces.pointer,
                                        engine.canvas_client_width, engine.canvas_client_height);
            if (surfaces.pointer.orbiting || surfaces.pointer.panning ||
                !surfaces.pointer.touches.empty())
                surfaces.captured = scene->camera;
            return;
        }
        return;
    }
#endif
    (void)surfaces;
    handle_camera_pointer_event(event, primary, primary_state, engine.canvas_client_width,
                                engine.canvas_client_height);
}

inline void update_camera(CameraRecord& camera) {
    if (!camera.controls_enabled) {
        return;
    }
    if (camera.kind == CameraKind::geospatial) {
        // The pinned geospatial per-frame hook is its own module and the
        // ArcRotate inertia below is not it; a geospatial camera integrates
        // pan/rotation/zoom velocities against yaw, pitch, radius and centre
        // instead of alpha/beta/target.
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
    const double movement = upstream::free_camera_move_speed(camera, nominal_frame_milliseconds);
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
    if (pressed(SDL_SCANCODE_LSHIFT) || pressed(SDL_SCANCODE_RSHIFT) ||
        pressed(SDL_SCANCODE_PAGEDOWN)) {
        camera.inertial_direction.y -= movement;
    }
    upstream::apply_free_camera_inertia(camera);
}

inline void update_surface_cameras([[maybe_unused]] Engine& engine, CameraRecord& primary) {
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
    if (engine.surface_canvas) {
        for (std::size_t i = 0; i < engine.cameras.size(); ++i) {
            const bool attached =
                std::any_of(engine.registered_scenes.begin(), engine.registered_scenes.end(),
                            [i](const auto& scene) { return scene && scene->camera.value == i; });
            if (attached)
                update_camera(engine.cameras[i]);
        }
        return;
    }
#endif
    update_camera(primary);
}

} // namespace bbl::pal

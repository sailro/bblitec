// Camera controls layered over the application event bridge. Scene-less
// drivers include pal_platform_events.hpp directly and pull no camera code.
//
// Every control handler lives in the generated camera_controls TU
// (bblite/upstream/camera_controls.hpp), lowered from the pinned
// attachControl/attachFreeControl closures. This header only translates
// SDL buttons, motion deltas, wheel detents, scancodes and the frame delta
// into the DOM units those handlers take, and holds the closures' drag
// flags.
#pragma once

#include <bblite/features/has_ui.hpp>

#include <bblite/runtime.hpp>
#if BBLITE_HAS_UI
#include <bblite/pal_ui.hpp>
#endif

#include <bblite/upstream/camera_controls.hpp>

#include <SDL3/SDL.h>

#include "pal_platform_events.hpp"

namespace bbl::pal {

struct CameraPointerState {
    // The pinned closures' drag flags: attachControl's isDragging and
    // isPanning, attachFreeControl's isDragging.
    bool dragging = false;
    bool panning = false;
    // The SDL mouse buttons held. A browser fires pointerdown for the first
    // button of a chord and pointerup when the last one is released, so the
    // handlers see one gesture per chord.
    SDL_MouseButtonFlags buttons = 0;
    std::map<std::pair<std::uint64_t, std::uint64_t>, std::array<double, 2>> touches;
};

struct SurfaceCameraPointerState {
    CameraPointerState pointer;
    CameraHandle captured{};
};

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
    // The pinned geospatial pointer input reaches its own accumulators.
    if (camera.kind == CameraKind::geospatial) {
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
            state.dragging = state.touches.size() == 1;
            state.panning = false;
            return;
        }
        const auto found = state.touches.find(key);
        if (found == state.touches.end())
            return;
        if (event.type == SDL_EVENT_FINGER_UP || event.type == SDL_EVENT_FINGER_CANCELED) {
            state.touches.erase(found);
            state.dragging = state.touches.size() == 1;
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
        const bool idle = state.buttons == 0;
        if (pressed) {
            state.buttons |= SDL_BUTTON_MASK(event.button.button);
        } else {
            state.buttons &= ~SDL_BUTTON_MASK(event.button.button);
        }
        // SDL numbers the buttons from one; PointerEvent.button from zero.
        const double button = static_cast<double>(event.button.button - 1);
        const bool free = camera.kind == CameraKind::free;
        if (pressed && idle) {
            if (free) {
                upstream::free_camera_pointer_down(state.dragging, button);
            } else {
                upstream::arc_rotate_pointer_down(camera, state.dragging, state.panning, button,
                                                  false);
            }
        } else if (!pressed && state.buttons == 0) {
            if (free) {
                upstream::free_camera_pointer_up(state.dragging);
            } else {
                upstream::arc_rotate_pointer_up(state.dragging, state.panning);
            }
        }
        return;
    }

    if (event.type == SDL_EVENT_MOUSE_MOTION) {
        if (camera.kind == CameraKind::free) {
            if (!camera.configurable_free_pointer) {
                upstream::free_camera_pointer_move(camera, state.dragging, event.motion.xrel,
                                                   event.motion.yrel);
            } else if (state.dragging) {
                camera.configurable_free_pointer(camera, event.motion.xrel, event.motion.yrel);
            }
            return;
        }
        upstream::arc_rotate_pointer_move(camera, state.dragging, state.panning,
                                          static_cast<double>(state.touches.size()),
                                          event.motion.xrel, event.motion.yrel);
        return;
    }

    // Only attachControl listens for the wheel. It consumes a DOM WheelEvent
    // deltaY; the one translation of SDL's detents into that convention
    // (sign and the 100-pixel notch) is the application bridge's, so both
    // wheel consumers cannot disagree on it.
    if (event.type == SDL_EVENT_MOUSE_WHEEL && camera.kind == CameraKind::arc_rotate) {
        upstream::apply_arc_rotate_wheel(camera, dom_wheel_delta_y(event.wheel));
    }
}

// `primary` is the scene's active camera, null when it has none.
inline void dispatch_surface_camera_pointer([[maybe_unused]] Engine& engine, const SDL_Event& event,
                                            CameraRecord* primary,
                                            CameraPointerState& primary_state,
                                            SurfaceCameraPointerState& surfaces) {
#if BBLITE_HAS_UI
    if (engine.surface_canvas) {
        if (surfaces.captured.value < engine.cameras.size()) {
            const auto index = surfaces.captured.value;
            handle_camera_pointer_event(event, engine.cameras[index], surfaces.pointer,
                                        engine.canvas_client_width, engine.canvas_client_height);
            if (!surfaces.pointer.dragging && !surfaces.pointer.panning &&
                surfaces.pointer.buttons == 0 && surfaces.pointer.touches.empty())
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
            if (surfaces.pointer.dragging || surfaces.pointer.panning ||
                surfaces.pointer.buttons != 0 || !surfaces.pointer.touches.empty())
                surfaces.captured = scene->camera;
            return;
        }
        return;
    }
#endif
    (void)surfaces;
    if (primary) {
        handle_camera_pointer_event(event, *primary, primary_state, engine.canvas_client_width,
                                    engine.canvas_client_height);
    }
}

// One frame of a camera's pinned before-render hook, at the frame's own
// delta: attachControl's applyInertia, or the free controls' update(deltaMs).
inline void update_camera(CameraRecord& camera, double delta_ms) {
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
    // The free controls ask for the KeyboardEvent.code values held down;
    // SDL's keyboard state answers for the portable scancodes.
    int key_count = 0;
    const bool* keys = SDL_GetKeyboardState(&key_count);
    std::vector<std::string_view> pressed_codes;
    for (int index = 0; index < key_count; ++index) {
        if (keys[index])
            pressed_codes.push_back(keyboard_event_code(static_cast<SDL_Scancode>(index)));
    }
    const std::function<bool(std::string_view)> pressed = [&pressed_codes](std::string_view code) {
        return std::find(pressed_codes.begin(), pressed_codes.end(), code) != pressed_codes.end();
    };
    if (camera.configurable_free_update) {
        camera.configurable_free_update(camera, delta_ms, pressed);
        return;
    }
    upstream::free_camera_update(camera, delta_ms, pressed);
}

/**
 * One frame of `camera`'s control hook at the delta the pin hands it: the
 * hook lives in the `_beforeRender` list of the scene `attachControl` was
 * given, whose `_update` passes `fixedDeltaMs > 0 ? fixedDeltaMs :
 * _currentDelta` (`scene_callback_delta`). A control installed without a
 * scene has no per-frame hook there.
 */
inline void update_attached_camera(const Engine& engine, CameraRecord& camera) {
    const std::shared_ptr<SceneState> scene = camera.controls_scene.lock();
    if (!scene)
        return;
    update_camera(camera, scene_callback_delta(Scene::from_state(scene), engine.current_delta_ms));
}

// `primary` is the scene's active camera, null when it has none.
inline void update_surface_cameras([[maybe_unused]] Engine& engine, CameraRecord* primary) {
#if BBLITE_HAS_UI
    if (engine.surface_canvas) {
        for (std::size_t i = 0; i < engine.cameras.size(); ++i) {
            const bool attached =
                std::any_of(engine.registered_scenes.begin(), engine.registered_scenes.end(),
                            [i](const auto& scene) { return scene && scene->camera.value == i; });
            if (attached)
                update_attached_camera(engine, engine.cameras[i]);
        }
        return;
    }
#endif
    if (primary) {
        update_attached_camera(engine, *primary);
    }
}

} // namespace bbl::pal

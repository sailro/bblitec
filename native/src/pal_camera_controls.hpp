// Camera input controls shared by the SDL_GPU and Dawn frame loops, so
// both backends apply identical pointer, wheel, and keyboard semantics.
#pragma once

#include <bblite/runtime.hpp>

#include <bblite/upstream/camera_controls.hpp>

#include <SDL3/SDL.h>

#include <algorithm>
#include <string>
#include <string_view>
#include <vector>

#include "pal_runtime_trace.hpp"

namespace bbl::pal {

struct CameraPointerState {
    bool orbiting = false;
    bool panning = false;
};

/**
 * Opt-in frame-indexed keyboard input for deterministic native diagnostics.
 *
 * BBLITE_INPUT_REPLAY is a comma-separated sequence of DOM KeyboardEvent.code
 * values. A plain entry is dispatched as a down/up pair in one frame, `+Code`
 * dispatches key-down only, `-Code` dispatches key-up only, and `-` is an idle
 * frame. The split form deterministically exercises held-input behaviour. All
 * forms reach the application's ordinary callbacks and do not mutate generated
 * source or camera state directly.
 */
class KeyboardReplay {
public:
    KeyboardReplay() {
        const std::string source =
            environment_variable("BBLITE_INPUT_REPLAY");
        std::size_t begin = 0;
        while (begin <= source.size()) {
            const std::size_t end = source.find(',', begin);
            const std::size_t length =
                end == std::string::npos
                    ? source.size() - begin
                    : end - begin;
            codes_.push_back(source.substr(begin, length));
            if (end == std::string::npos) break;
            begin = end + 1;
        }
        if (source.empty()) codes_.clear();
    }

    void dispatch(long frame, Engine& engine) const {
        if (
            frame < 0 ||
            static_cast<std::size_t>(frame) >= codes_.size()) {
            return;
        }
        const std::string& code =
            codes_[static_cast<std::size_t>(frame)];
        if (code.empty() || code == "-") return;
        const bool down_only = code.size() > 1 && code.front() == '+';
        const bool up_only = code.size() > 1 && code.front() == '-';
        const std::string_view event_code =
            down_only || up_only
                ? std::string_view(code).substr(1)
                : std::string_view(code);
        const PlatformKeyboardEvent event{
            .code = std::string(event_code),
            .repeat = false,
        };
        if (!up_only) {
            trace_keyboard_event(event_code, true, false);
            for (const auto& callback : engine.key_down_callbacks) {
                callback(event);
            }
        }
        if (!down_only) {
            trace_keyboard_event(event_code, false, false);
            for (const auto& callback : engine.key_up_callbacks) {
                callback(event);
            }
        }
    }

private:
    std::vector<std::string> codes_;
};

/** DOM-compatible `KeyboardEvent.code` for the portable SDL scancodes. */
inline std::string_view keyboard_event_code(SDL_Scancode scancode) {
    switch (scancode) {
        case SDL_SCANCODE_LEFT: return "ArrowLeft";
        case SDL_SCANCODE_RIGHT: return "ArrowRight";
        case SDL_SCANCODE_UP: return "ArrowUp";
        case SDL_SCANCODE_DOWN: return "ArrowDown";
        case SDL_SCANCODE_SPACE: return "Space";
        case SDL_SCANCODE_ESCAPE: return "Escape";
        case SDL_SCANCODE_RETURN: return "Enter";
        case SDL_SCANCODE_TAB: return "Tab";
        case SDL_SCANCODE_BACKSPACE: return "Backspace";
        case SDL_SCANCODE_LSHIFT: return "ShiftLeft";
        case SDL_SCANCODE_RSHIFT: return "ShiftRight";
        case SDL_SCANCODE_LCTRL: return "ControlLeft";
        case SDL_SCANCODE_RCTRL: return "ControlRight";
        case SDL_SCANCODE_LALT: return "AltLeft";
        case SDL_SCANCODE_RALT: return "AltRight";
        case SDL_SCANCODE_A: return "KeyA";
        case SDL_SCANCODE_B: return "KeyB";
        case SDL_SCANCODE_C: return "KeyC";
        case SDL_SCANCODE_D: return "KeyD";
        case SDL_SCANCODE_E: return "KeyE";
        case SDL_SCANCODE_F: return "KeyF";
        case SDL_SCANCODE_G: return "KeyG";
        case SDL_SCANCODE_H: return "KeyH";
        case SDL_SCANCODE_I: return "KeyI";
        case SDL_SCANCODE_J: return "KeyJ";
        case SDL_SCANCODE_K: return "KeyK";
        case SDL_SCANCODE_L: return "KeyL";
        case SDL_SCANCODE_M: return "KeyM";
        case SDL_SCANCODE_N: return "KeyN";
        case SDL_SCANCODE_O: return "KeyO";
        case SDL_SCANCODE_P: return "KeyP";
        case SDL_SCANCODE_Q: return "KeyQ";
        case SDL_SCANCODE_R: return "KeyR";
        case SDL_SCANCODE_S: return "KeyS";
        case SDL_SCANCODE_T: return "KeyT";
        case SDL_SCANCODE_U: return "KeyU";
        case SDL_SCANCODE_V: return "KeyV";
        case SDL_SCANCODE_W: return "KeyW";
        case SDL_SCANCODE_X: return "KeyX";
        case SDL_SCANCODE_Y: return "KeyY";
        case SDL_SCANCODE_Z: return "KeyZ";
        case SDL_SCANCODE_0: return "Digit0";
        case SDL_SCANCODE_1: return "Digit1";
        case SDL_SCANCODE_2: return "Digit2";
        case SDL_SCANCODE_3: return "Digit3";
        case SDL_SCANCODE_4: return "Digit4";
        case SDL_SCANCODE_5: return "Digit5";
        case SDL_SCANCODE_6: return "Digit6";
        case SDL_SCANCODE_7: return "Digit7";
        case SDL_SCANCODE_8: return "Digit8";
        case SDL_SCANCODE_9: return "Digit9";
        case SDL_SCANCODE_COMMA: return "Comma";
        case SDL_SCANCODE_PERIOD: return "Period";
        default: return {};
    }
}

inline void handle_platform_event(
    const SDL_Event& event,
    Engine& engine) {
    if (
        event.type == SDL_EVENT_KEY_DOWN ||
        event.type == SDL_EVENT_KEY_UP) {
        const std::string_view code =
            keyboard_event_code(event.key.scancode);
        if (code.empty()) return;
        trace_keyboard_event(
            code,
            event.type == SDL_EVENT_KEY_DOWN,
            event.key.repeat);
        const PlatformKeyboardEvent keyboard_event{
            .code = std::string(code),
            .repeat = event.key.repeat,
        };
        const auto& callbacks = event.type == SDL_EVENT_KEY_DOWN
            ? engine.key_down_callbacks
            : engine.key_up_callbacks;
        for (const auto& callback : callbacks) {
            callback(keyboard_event);
        }
        return;
    }
    if (event.type == SDL_EVENT_MOUSE_BUTTON_DOWN) {
        for (const auto& callback : engine.pointer_down_callbacks) {
            callback();
        }
    }
    if (
        event.type == SDL_EVENT_MOUSE_BUTTON_DOWN ||
        event.type == SDL_EVENT_MOUSE_BUTTON_UP) {
        const PlatformMouseEvent mouse_event{
            .button = static_cast<double>(event.button.button - 1),
        };
        const auto& callbacks =
            event.type == SDL_EVENT_MOUSE_BUTTON_DOWN
                ? engine.mouse_down_callbacks
                : engine.mouse_up_callbacks;
        for (const auto& callback : callbacks) {
            callback(mouse_event);
        }
        return;
    }
    const bool hidden =
        event.type == SDL_EVENT_WINDOW_HIDDEN ||
        event.type == SDL_EVENT_WINDOW_MINIMIZED;
    const bool visible =
        event.type == SDL_EVENT_WINDOW_SHOWN ||
        event.type == SDL_EVENT_WINDOW_RESTORED;
    if (hidden || visible) {
        for (const auto& callback : engine.visibility_change_callbacks) {
            callback(hidden);
        }
    }
}

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
        double delta = event.wheel.y;
        if (event.wheel.direction == SDL_MOUSEWHEEL_FLIPPED) {
            delta = -delta;
        }
        camera.inertial_radius_offset -=
            (delta * camera.radius) / std::max(camera.wheel_precision * 10.0, 1.0);
    }
}

inline void update_camera(CameraRecord& camera) {
    if (!camera.controls_enabled) {
        return;
    }
    if (camera.kind != CameraKind::free) {
        // The pinned ArcRotate attachControl surface is pointer-only.  In
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
    {
        // The pin's per-frame move scale, evaluated at the fixed 60 FPS
        // step this loop runs: free-camera-controls.ts computes
        // moveSpeed = speed * sqrt(dt * dt / 1e5) each frame, and
        // dt = 1000/60 ms gives (1000/60) / sqrt(1e5) = 0.05270463.
        // A variable-dt loop would re-derive this from its own dt.
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
}

} // namespace bbl::pal

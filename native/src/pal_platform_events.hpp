// DOM-compatible application events shared by every SDL-backed frame loop.
#pragma once

#include <bblite/runtime.hpp>

#include <SDL3/SDL.h>

#include <string>
#include <string_view>
#include <vector>

#include "pal_runtime_trace.hpp"

namespace bbl::pal {

inline std::string keyboard_event_key(std::string_view code) {
    if (code.size() == 4u && code.substr(0u, 3u) == "Key") {
        const char letter = code[3];
        return std::string(1u, static_cast<char>(
            letter >= 'A' && letter <= 'Z' ? letter - 'A' + 'a' : letter));
    }
    if (code.size() == 6u && code.substr(0u, 5u) == "Digit") {
        return std::string(1u, code[5]);
    }
    if (code == "Space") return " ";
    return std::string(code);
}

inline void dispatch_platform_keyboard_event(
    Engine& engine,
    std::string_view code,
    bool down,
    bool repeat) {
    trace_keyboard_event(code, down, repeat);
    const PlatformKeyboardEvent event{
        .code = std::string(code),
        .key = keyboard_event_key(code),
        .repeat = repeat,
    };
    const auto& callbacks = down
        ? engine.key_down_callbacks
        : engine.key_up_callbacks;
    for (const auto& callback : callbacks) {
        callback(event);
    }
}

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
        if (!up_only) {
            dispatch_platform_keyboard_event(
                engine, event_code, true, false);
        }
        if (!down_only) {
            dispatch_platform_keyboard_event(
                engine, event_code, false, false);
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
        dispatch_platform_keyboard_event(
            engine,
            code,
            event.type == SDL_EVENT_KEY_DOWN,
            event.key.repeat);
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

} // namespace bbl::pal

// DOM-compatible application events shared by every SDL-backed frame loop.
#pragma once

#include <bblite/runtime.hpp>

#include <SDL3/SDL.h>

#include <charconv>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "pal_runtime_trace.hpp"

namespace bbl::pal {

/** True for live user input that must not leak into deterministic test runs. */
inline bool is_platform_input_event(const SDL_Event& event) {
    return
        event.type == SDL_EVENT_KEY_DOWN ||
        event.type == SDL_EVENT_KEY_UP ||
        event.type == SDL_EVENT_TEXT_EDITING ||
        event.type == SDL_EVENT_TEXT_INPUT ||
        event.type == SDL_EVENT_MOUSE_MOTION ||
        event.type == SDL_EVENT_MOUSE_BUTTON_DOWN ||
        event.type == SDL_EVENT_MOUSE_BUTTON_UP ||
        event.type == SDL_EVENT_MOUSE_WHEEL;
}

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

inline bool dispatch_platform_keyboard_event(
    Engine& engine,
    std::string_view code,
    bool down,
    bool repeat,
    bool shift_key = false,
    bool ctrl_key = false,
    bool alt_key = false,
    bool meta_key = false) {
    trace_keyboard_event(code, down, repeat);
    const PlatformKeyboardEvent event{
        .code = std::string(code),
        .key = keyboard_event_key(code),
        .repeat = repeat,
        .shift_key = shift_key,
        .ctrl_key = ctrl_key,
        .alt_key = alt_key,
        .meta_key = meta_key,
    };
    auto& callbacks = down
        ? engine.key_down_callbacks
        : engine.key_up_callbacks;
    callbacks.dispatch(event);
    return event.default_prevented;
}

inline bool canvas_contains_client_point(
    const Engine& engine,
    const PlatformMouseEvent& event);

inline void dispatch_platform_wheel_event(
    Engine& engine,
    double delta_y,
    double client_x,
    double client_y,
    double buttons = 0.0) {
    const PlatformMouseEvent event{
        .button = -1.0,
        .buttons = buttons,
        .client_x = client_x,
        .client_y = client_y,
        .delta_y = delta_y,
    };
    if (!canvas_contains_client_point(engine, event)) return;
    engine.mouse_wheel_callbacks.dispatch(event);
}

/** Browser events never expose clicks on the host window's decorations. */
inline bool canvas_contains_client_point(
    const Engine& engine,
    const PlatformMouseEvent& event) {
    return
        event.client_x >= 0.0 &&
        event.client_y >= 0.0 &&
        event.client_x < engine.canvas_client_width &&
        event.client_y < engine.canvas_client_height;
}

inline void dispatch_platform_pointer_down(
    Engine& engine,
    const PlatformMouseEvent& event) {
    if (!canvas_contains_client_point(engine, event)) return;
    engine.pointer_down_callbacks.dispatch();
    if (event.button == 0.0) engine.canvas_click_armed = true;
}

inline void dispatch_canvas_click(
    Engine& engine,
    const PlatformMouseEvent& event) {
    if (event.button != 0.0) return;
    const bool dispatch =
        engine.canvas_click_armed &&
        canvas_contains_client_point(engine, event);
    engine.canvas_click_armed = false;
    if (!dispatch) return;
    engine.canvas_click_callbacks.dispatch();
}

inline void dispatch_platform_mouse_button(
    Engine& engine,
    const PlatformMouseEvent& event,
    bool down) {
    const bool inside = canvas_contains_client_point(engine, event);
    if (down) {
        if (!inside) return;
        dispatch_platform_pointer_down(engine, event);
        engine.mouse_down_callbacks.dispatch(event);
        return;
    }
    if (inside) engine.mouse_up_callbacks.dispatch(event);
    dispatch_canvas_click(engine, event);
}

/**
 * Opt-in frame-indexed input for deterministic native diagnostics.
 *
 * BBLITE_INPUT_REPLAY is a comma-separated sequence of DOM KeyboardEvent.code
 * values. `Ctrl+Code` sets the control modifier. A plain entry is dispatched
 * as a down/up pair in one frame, `+Code` dispatches key-down only, `-Code`
 * dispatches key-up only, and `-` is an idle frame. Mouse buttons follow the
 * same prefix convention; `MouseLeftOutsideCanvas` exercises host-decoration
 * rejection. `MouseMoveRight` dispatches one relative-motion packet,
 * `MouseMove@x:y` moves to an exact client point, and a mouse button may
 * carry the same suffix (for example `+MouseLeft@320:180`).
 * `UiClick@x:y` queues an SDL motion/press/release triplet so retained UI
 * receives the same host events as a physical click without moving the
 * user's pointer or foreground focus.
 * `UiMove@x:y` and `+UiMouseLeft@x:y`/`-UiMouseLeft@x:y` use that same
 * SDL path for hover and held drags, including camera controls.
 * `WheelUp`/`WheelDown` dispatch a browser-sized wheel notch, and
 * `WindowClose` queues the host close request. All forms reach the ordinary
 * platform callbacks without mutating generated source or scene state.
 * The engine owns the tape position and held buttons so a scene replacement
 * resumes the same recording instead of replaying it from the beginning.
 */
inline void sync_pointer_lock(SDL_Window* window, Engine& engine);

inline void release_pointer_lock_on_escape(
    SDL_Window* window,
    Engine& engine,
    std::string_view code,
    bool key_down) {
    if (!key_down || code != "Escape" || !engine.pointer_locked) return;
    engine.pointer_lock_requested = false;
    sync_pointer_lock(window, engine);
}

inline constexpr SDL_MouseID replay_ui_mouse_id =
    static_cast<SDL_MouseID>(~0u);

class PlatformInputReplay {
public:
    PlatformInputReplay() {
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

    void dispatch(long frame, SDL_Window* window, Engine& engine) {
        if (codes_.empty() || frame < 0 || frame == last_frame_) return;
        last_frame_ = frame;
        const std::size_t index = engine.input_replay_next_frame;
        if (index >= codes_.size()) return;
        ++engine.input_replay_next_frame;
        unsigned int& mouse_buttons_ = engine.input_replay_mouse_buttons;
        const std::string& code = codes_[index];
        if (code.empty() || code == "-") return;
        if (code == "WindowClose") {
            SDL_Event close_event{};
            close_event.type = SDL_EVENT_WINDOW_CLOSE_REQUESTED;
            close_event.window.type = SDL_EVENT_WINDOW_CLOSE_REQUESTED;
            close_event.window.windowID = window ? SDL_GetWindowID(window) : 0;
            if (!SDL_PushEvent(&close_event)) {
                throw std::runtime_error(
                    "Unable to queue deterministic window-close input.");
            }
            return;
        }
        if (code == "MouseMoveRight") {
            const PlatformMouseEvent event{
                .button = -1.0,
                .buttons = static_cast<double>(mouse_buttons_),
                .client_x = engine.canvas_client_width / 2.0,
                .client_y = engine.canvas_client_height / 2.0,
                .movement_x = 100.0,
            };
            engine.mouse_move_callbacks.dispatch(event);
            return;
        }
        if (const auto point = pointer_position(code, "MouseMove@")) {
            const PlatformMouseEvent event{
                .button = -1.0,
                .buttons = static_cast<double>(mouse_buttons_),
                .client_x = point->first,
                .client_y = point->second,
            };
            engine.mouse_move_callbacks.dispatch(event);
            return;
        }
        const auto ui_click = pointer_position(code, "UiClick@");
        const auto ui_move = pointer_position(code, "UiMove@");
        const auto ui_down = pointer_position(code, "+UiMouseLeft@");
        const auto ui_up = pointer_position(code, "-UiMouseLeft@");
        if (const auto point = ui_click ? ui_click : ui_move ? ui_move : ui_down ? ui_down : ui_up) {
            const std::uint32_t window_id =
                window ? SDL_GetWindowID(window) : 0;
            SDL_Event motion{};
            motion.type = SDL_EVENT_MOUSE_MOTION;
            motion.motion.type = SDL_EVENT_MOUSE_MOTION;
            motion.motion.windowID = window_id;
            motion.motion.which = replay_ui_mouse_id;
            motion.motion.x = static_cast<float>(point->first);
            motion.motion.y = static_cast<float>(point->second);
            motion.motion.xrel = static_cast<float>(point->first - engine.input_replay_pointer_x);
            motion.motion.yrel = static_cast<float>(point->second - engine.input_replay_pointer_y);
            motion.motion.state = mouse_buttons_;
            engine.input_replay_pointer_x = point->first;
            engine.input_replay_pointer_y = point->second;
            SDL_Event down{};
            down.type = SDL_EVENT_MOUSE_BUTTON_DOWN;
            down.button.type = SDL_EVENT_MOUSE_BUTTON_DOWN;
            down.button.windowID = window_id;
            down.button.which = replay_ui_mouse_id;
            down.button.button = SDL_BUTTON_LEFT;
            down.button.down = true;
            down.button.x = static_cast<float>(point->first);
            down.button.y = static_cast<float>(point->second);
            SDL_Event up = down;
            up.type = SDL_EVENT_MOUSE_BUTTON_UP;
            up.button.type = SDL_EVENT_MOUSE_BUTTON_UP;
            up.button.down = false;
            const auto queue = [](SDL_Event& event) {
                if (!SDL_PushEvent(&event)) {
                    throw std::runtime_error(
                        "Unable to queue deterministic pointer input.");
                }
            };
            queue(motion);
            if (ui_click || ui_down) {
                mouse_buttons_ |= SDL_BUTTON_LMASK;
                queue(down);
            }
            if (ui_click || ui_up) {
                mouse_buttons_ &= ~SDL_BUTTON_LMASK;
                queue(up);
            }
            return;
        }
        if (code == "WheelUp" || code == "WheelDown") {
            dispatch_platform_wheel_event(
                engine,
                code == "WheelUp" ? -100.0 : 100.0,
                engine.canvas_client_width / 2.0,
                engine.canvas_client_height / 2.0,
                static_cast<double>(mouse_buttons_));
            return;
        }
        const bool down_only = code.size() > 1 && code.front() == '+';
        const bool up_only = code.size() > 1 && code.front() == '-';
        std::string_view event_code =
            down_only || up_only
                ? std::string_view(code).substr(1)
                : std::string_view(code);
        bool ctrl_key = false;
        if (event_code.starts_with("Ctrl+")) {
            ctrl_key = true;
            event_code.remove_prefix(5);
        }
        double mouse_button = -1.0;
        double mouse_mask = 0.0;
        const auto left_point =
            pointer_position(event_code, "MouseLeft@");
        const bool outside_canvas =
            event_code == "MouseLeftOutsideCanvas";
        if (event_code == "MouseLeft" || left_point || outside_canvas) {
            mouse_button = 0.0;
            mouse_mask = 1.0;
        } else if (event_code == "MouseMiddle") {
            mouse_button = 1.0;
            mouse_mask = 4.0;
        } else if (event_code == "MouseRight") {
            mouse_button = 2.0;
            mouse_mask = 2.0;
        }
        if (mouse_button >= 0.0) {
            const auto dispatch_mouse = [&](bool down) {
                const auto mask =
                    static_cast<unsigned int>(mouse_mask);
                if (down) {
                    mouse_buttons_ |= mask;
                } else {
                    mouse_buttons_ &= ~mask;
                }
                const PlatformMouseEvent event{
                    .button = mouse_button,
                    .buttons = static_cast<double>(mouse_buttons_),
                    .client_x = outside_canvas
                        ? -1.0
                        : left_point
                          ? left_point->first
                        : engine.canvas_client_width / 2.0,
                    .client_y = outside_canvas
                        ? -1.0
                        : left_point
                          ? left_point->second
                        : engine.canvas_client_height / 2.0,
                };
                dispatch_platform_mouse_button(engine, event, down);
                sync_pointer_lock(window, engine);
            };
            if (!up_only) dispatch_mouse(true);
            if (!down_only) dispatch_mouse(false);
            return;
        }
        if (!up_only) {
            dispatch_platform_keyboard_event(
                engine, event_code, true, false, false, ctrl_key);
            release_pointer_lock_on_escape(
                window,
                engine,
                event_code,
                true);
        }
        if (!down_only) {
            dispatch_platform_keyboard_event(
                engine, event_code, false, false, false, ctrl_key);
        }
    }

private:
    static std::optional<std::pair<double, double>> pointer_position(
        std::string_view value,
        std::string_view prefix) {
        if (!value.starts_with(prefix)) return std::nullopt;
        value.remove_prefix(prefix.size());
        const std::size_t separator = value.find(':');
        if (separator == std::string_view::npos) {
            throw std::runtime_error(
                "A coordinate input replay action requires @x:y.");
        }
        const auto parse = [](std::string_view component) {
            int result = 0;
            const char* begin = component.data();
            const char* end = begin + component.size();
            const auto parsed = std::from_chars(begin, end, result);
            if (parsed.ec != std::errc{} || parsed.ptr != end) {
                throw std::runtime_error(
                    "A coordinate input replay action requires integer x:y values.");
            }
            return static_cast<double>(result);
        };
        return std::pair{
            parse(value.substr(0, separator)),
            parse(value.substr(separator + 1))};
    }

    std::vector<std::string> codes_;
    long last_frame_ = -1;
};

inline bool is_replayed_ui_event(const SDL_Event& event) {
    if (event.type == SDL_EVENT_MOUSE_MOTION) {
        return event.motion.which == replay_ui_mouse_id;
    }
    if (
        event.type == SDL_EVENT_MOUSE_BUTTON_DOWN ||
        event.type == SDL_EVENT_MOUSE_BUTTON_UP) {
        return event.button.which == replay_ui_mouse_id;
    }
    return false;
}

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
        case SDL_SCANCODE_F1: return "F1";
        case SDL_SCANCODE_F2: return "F2";
        case SDL_SCANCODE_F3: return "F3";
        case SDL_SCANCODE_F4: return "F4";
        case SDL_SCANCODE_F5: return "F5";
        case SDL_SCANCODE_F6: return "F6";
        case SDL_SCANCODE_F7: return "F7";
        case SDL_SCANCODE_F8: return "F8";
        case SDL_SCANCODE_F9: return "F9";
        case SDL_SCANCODE_F10: return "F10";
        case SDL_SCANCODE_F11: return "F11";
        case SDL_SCANCODE_F12: return "F12";
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

/**
 * Keep the native drawing-buffer dimensions behind `canvas.width` and
 * `canvas.height` live.
 *
 * SDL's window-resized event reports logical window coordinates while the
 * renderer and an HTML canvas both expose backing-store pixels. Querying the
 * window here therefore also preserves the right contract on a high-density
 * display. Every native loop drains events before advancing the application,
 * so a frame triggered by maximize/restore sees the new size in its callbacks.
 */
inline bool sync_engine_canvas_size(
    SDL_Window* window,
    Engine& engine) {
    int client_width = 0;
    int client_height = 0;
    int width = 0;
    int height = 0;
    if (
        window &&
        SDL_GetWindowSize(window, &client_width, &client_height) &&
        SDL_GetWindowSizeInPixels(window, &width, &height) &&
        client_width > 0 &&
        client_height > 0 &&
        width > 0 &&
        height > 0) {
        const bool changed =
            engine.options.width != width ||
            engine.options.height != height ||
            engine.canvas_client_width != client_width ||
            engine.canvas_client_height != client_height;
        engine.options.width = width;
        engine.options.height = height;
        engine.canvas_client_width = client_width;
        engine.canvas_client_height = client_height;
        return changed;
    }
    return false;
}

// TODO(window-move): adopt SDL's main-callback loop for interactive builds.
// Conventional SDL_PollEvent loops stall application iteration during the
// Win32 move/resize modal loop. Do not work around that with re-entrant event
// watchers, compositor flushes, or temporary window-style changes.

/** Translate SDL's button masks to PointerEvent.buttons. */
inline double dom_mouse_buttons(SDL_MouseButtonFlags pressed) {
    return
        ((pressed & SDL_BUTTON_LMASK) != 0 ? 1.0 : 0.0) +
        ((pressed & SDL_BUTTON_RMASK) != 0 ? 2.0 : 0.0) +
        ((pressed & SDL_BUTTON_MMASK) != 0 ? 4.0 : 0.0) +
        ((pressed & SDL_BUTTON_X1MASK) != 0 ? 8.0 : 0.0) +
        ((pressed & SDL_BUTTON_X2MASK) != 0 ? 16.0 : 0.0);
}

/**
 * Preserve physical button state across SDL relative-mode motion packets.
 *
 * On Windows, switching to relative mode while a button is held can produce
 * motion events whose `state` mask is empty even though no button-up event
 * occurred. PointerEvent.buttons follows button transitions, so use the SDL
 * down/up events as the source of truth instead of treating such a motion
 * packet as a release.
 */
inline SDL_MouseButtonFlags& tracked_mouse_buttons() {
    static SDL_MouseButtonFlags buttons = 0;
    return buttons;
}

inline void update_tracked_mouse_button(const SDL_MouseButtonEvent& event) {
    SDL_MouseButtonFlags& buttons = tracked_mouse_buttons();
    const SDL_MouseButtonFlags changed = SDL_BUTTON_MASK(event.button);
    if (event.down) {
        buttons |= changed;
    } else {
        buttons &= ~changed;
    }
}

/**
 * Translate SDL's wheel distance into the pixel-mode delta a browser reports.
 *
 * SDL exposes wheel motion in scroll increments (one ordinary Windows mouse
 * notch is `1`), while Chromium's `WheelEvent.deltaY` for the same notch is
 * 100 CSS pixels with `deltaMode === DOM_DELTA_PIXEL`. Application code uses
 * that pixel value directly, so forwarding SDL's raw increment makes native
 * wheel controls roughly one hundred times less sensitive.
 */
inline double dom_wheel_delta_y(const SDL_MouseWheelEvent& event) {
    constexpr double browser_pixels_per_scroll_increment = 100.0;
    const double increment =
        event.direction == SDL_MOUSEWHEEL_FLIPPED
            ? static_cast<double>(event.y)
            : -static_cast<double>(event.y);
    return increment * browser_pixels_per_scroll_increment;
}

inline void apply_pointer_lock_cursor(bool locked) {
    if (locked) {
        SDL_HideCursor();
        return;
    }
    SDL_ShowCursor();
}

/** Apply the small reached CSS cursor surface of the engine canvas. */
inline void apply_canvas_cursor(const Engine& engine) {
    if (engine.pointer_locked) return;
    if (engine.canvas_cursor == "none") {
        SDL_HideCursor();
        return;
    }
    SDL_ShowCursor();
    if (engine.canvas_cursor == "crosshair") {
        // One process-lifetime system cursor avoids allocating on each move.
        static SDL_Cursor* crosshair =
            SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_CROSSHAIR);
        if (crosshair) SDL_SetCursor(crosshair);
        return;
    }
    SDL_SetCursor(SDL_GetDefaultCursor());
}

inline const char* pointer_lock_hint(const char* name) {
    const char* value = SDL_GetHint(name);
    return value ? value : "<unset>";
}

inline void trace_pointer_lock_state(
    std::string_view phase,
    SDL_Window* window,
    const Engine& engine) {
    if (!runtime_trace_enabled()) return;
    std::cerr
        << "[bblite trace] pointer-lock phase=" << phase
        << " requested=" << (engine.pointer_lock_requested ? 1 : 0)
        << " locked=" << (engine.pointer_locked ? 1 : 0)
        << " relative="
        << (window && SDL_GetWindowRelativeMouseMode(window) ? 1 : 0)
        << " cursor-visible=" << (SDL_CursorVisible() ? 1 : 0)
        << " relative-cursor-hint="
        << pointer_lock_hint(SDL_HINT_MOUSE_RELATIVE_CURSOR_VISIBLE)
        << " system-scale-hint="
        << pointer_lock_hint(SDL_HINT_MOUSE_RELATIVE_SYSTEM_SCALE)
        << " speed-scale-hint="
        << pointer_lock_hint(SDL_HINT_MOUSE_RELATIVE_SPEED_SCALE)
        << '\n';
}

inline void dispatch_pointer_lock_change(Engine& engine) {
    engine.pointer_lock_change_callbacks.dispatch();
}

/**
 * Apply a pointer-lock request made from an application event callback.
 *
 * SDL relative mode is the desktop counterpart of browser pointer lock: it
 * hides and confines the cursor while reporting unbounded relative motion.
 * The change callback runs only after SDL accepted the transition, matching
 * `pointerlockchange` rather than treating a request as immediate success.
 */
inline void sync_pointer_lock(SDL_Window* window, Engine& engine) {
    if (!window) {
        return;
    }
    if (engine.pointer_lock_requested == engine.pointer_locked) {
        if (engine.pointer_locked) {
            apply_pointer_lock_cursor(true);
        }
        return;
    }
    trace_pointer_lock_state("sync-enter", window, engine);
    if (engine.pointer_lock_requested) {
        // Browser pointer lock uses the system-adjusted mouse movement unless
        // unadjustedMovement is explicitly requested. Preserve that contract
        // and pin SDL's independent speed scale to neutral.
        SDL_SetHintWithPriority(
            SDL_HINT_MOUSE_AUTO_CAPTURE,
            "0",
            SDL_HINT_OVERRIDE);
        SDL_SetHintWithPriority(
            SDL_HINT_MOUSE_RELATIVE_SYSTEM_SCALE,
            "1",
            SDL_HINT_OVERRIDE);
        SDL_SetHintWithPriority(
            SDL_HINT_MOUSE_RELATIVE_SPEED_SCALE,
            "1.0",
            SDL_HINT_OVERRIDE);
        SDL_SetHintWithPriority(
            SDL_HINT_MOUSE_RELATIVE_CURSOR_VISIBLE,
            "0",
            SDL_HINT_OVERRIDE);
    }
    if (!SDL_SetWindowRelativeMouseMode(
            window,
            engine.pointer_lock_requested)) {
        if (runtime_trace_enabled()) {
            std::cerr
                << "[bblite trace] pointer-lock SDL error=\""
                << SDL_GetError() << "\"\n";
        }
        trace_pointer_lock_state("sync-rejected", window, engine);
        return;
    }
    engine.pointer_locked = engine.pointer_lock_requested;
    apply_pointer_lock_cursor(engine.pointer_locked);
    trace_pointer_lock_state("sync-applied", window, engine);
    dispatch_pointer_lock_change(engine);
}

inline void handle_platform_event(
    const SDL_Event& event,
    Engine& engine) {
    if (
        event.type == SDL_EVENT_WINDOW_RESIZED ||
        event.type == SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED) {
        if (sync_engine_canvas_size(
                SDL_GetWindowFromID(event.window.windowID),
                engine)) {
            engine.window_resize_callbacks.dispatch();
        }
        return;
    }
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
            event.key.repeat,
            (event.key.mod & SDL_KMOD_SHIFT) != 0,
            (event.key.mod & SDL_KMOD_CTRL) != 0,
            (event.key.mod & SDL_KMOD_ALT) != 0,
            (event.key.mod & SDL_KMOD_GUI) != 0);
        // Escape is reserved by the browser host to leave pointer lock; the
        // application does not need to register document.exitPointerLock()
        // for that affordance. SDL relative mode has no corresponding
        // default, so project the host behavior here for every scene that
        // explicitly opted into pointer lock.
        release_pointer_lock_on_escape(
            SDL_GetWindowFromID(event.key.windowID),
            engine,
            code,
            event.type == SDL_EVENT_KEY_DOWN);
        return;
    }
    if (
        event.type == SDL_EVENT_MOUSE_BUTTON_DOWN ||
        event.type == SDL_EVENT_MOUSE_BUTTON_UP) {
        update_tracked_mouse_button(event.button);
        const SDL_MouseButtonFlags pressed = tracked_mouse_buttons();
        const PlatformMouseEvent mouse_event{
            .button = static_cast<double>(event.button.button - 1),
            .buttons = dom_mouse_buttons(pressed),
            .client_x = static_cast<double>(event.button.x),
            .client_y = static_cast<double>(event.button.y),
        };
        if (runtime_trace_enabled()) {
            std::cerr
                << "[bblite trace] input mouse-button state="
                << (event.type == SDL_EVENT_MOUSE_BUTTON_DOWN
                        ? "down"
                        : "up")
                << " sdl-button=" << static_cast<int>(event.button.button)
                << " dom-button=" << mouse_event.button
                << " sdl-mask=" << static_cast<unsigned long long>(pressed)
                << " dom-buttons=" << mouse_event.buttons
                << " requested-before="
                << (engine.pointer_lock_requested ? 1 : 0)
                << " locked-before=" << (engine.pointer_locked ? 1 : 0)
                << '\n';
        }
        dispatch_platform_mouse_button(
            engine,
            mouse_event,
            event.type == SDL_EVENT_MOUSE_BUTTON_DOWN);
        if (runtime_trace_enabled()) {
            std::cerr
                << "[bblite trace] input mouse-button callbacks-complete"
                << " requested-after="
                << (engine.pointer_lock_requested ? 1 : 0)
                << " locked-after=" << (engine.pointer_locked ? 1 : 0)
                << '\n';
        }
        sync_pointer_lock(
            SDL_GetWindowFromID(event.button.windowID),
            engine);
        return;
    }
    if (event.type == SDL_EVENT_MOUSE_MOTION) {
        const PlatformMouseEvent mouse_event{
            .button = -1.0,
            .buttons = dom_mouse_buttons(tracked_mouse_buttons()),
            .client_x = static_cast<double>(event.motion.x),
            .client_y = static_cast<double>(event.motion.y),
            .movement_x = static_cast<double>(event.motion.xrel),
            .movement_y = static_cast<double>(event.motion.yrel),
        };
        static std::size_t traced_motion_count = 0;
        if (
            runtime_trace_enabled() &&
            traced_motion_count < 32 &&
            (engine.pointer_lock_requested ||
             engine.pointer_locked ||
             event.motion.state != 0)) {
            ++traced_motion_count;
            std::cerr
                << "[bblite trace] input mouse-motion"
                << " xrel=" << mouse_event.movement_x
                << " yrel=" << mouse_event.movement_y
                << " sdl-mask="
                << static_cast<unsigned long long>(event.motion.state)
                << " dom-buttons=" << mouse_event.buttons
                << " requested=" << (engine.pointer_lock_requested ? 1 : 0)
                << " locked=" << (engine.pointer_locked ? 1 : 0)
                << '\n';
        }
        if (canvas_contains_client_point(engine, mouse_event)) {
            engine.mouse_move_callbacks.dispatch(mouse_event);
        }
        sync_pointer_lock(
            SDL_GetWindowFromID(event.motion.windowID),
            engine);
        return;
    }
    if (event.type == SDL_EVENT_MOUSE_WHEEL) {
        // DOM deltaY is positive when scrolling down. SDL's normalized Y is
        // positive away from the user; natural-scroll devices mark FLIPPED.
        const double delta_y = dom_wheel_delta_y(event.wheel);
        dispatch_platform_wheel_event(
            engine,
            delta_y,
            static_cast<double>(event.wheel.mouse_x),
            static_cast<double>(event.wheel.mouse_y),
            dom_mouse_buttons(tracked_mouse_buttons()));
        return;
    }
    if (event.type == SDL_EVENT_WINDOW_FOCUS_LOST) {
        tracked_mouse_buttons() = 0;
        engine.canvas_click_armed = false;
        const PlatformMouseEvent mouse_event{
            .button = -1.0,
            .buttons = 0.0,
        };
        engine.mouse_cancel_callbacks.dispatch(mouse_event);
        engine.pointer_lock_requested = false;
        sync_pointer_lock(
            SDL_GetWindowFromID(event.window.windowID),
            engine);
        return;
    }
    const bool hidden =
        event.type == SDL_EVENT_WINDOW_HIDDEN ||
        event.type == SDL_EVENT_WINDOW_MINIMIZED;
    const bool visible =
        event.type == SDL_EVENT_WINDOW_SHOWN ||
        event.type == SDL_EVENT_WINDOW_RESTORED;
    if (hidden || visible) {
        engine.visibility_change_callbacks.dispatch(hidden);
    }
}

/**
 * One drain of the SDL event queue, shared by every frame loop so no
 * loop can hold a partial copy of the contract: quit flips `running`, a
 * deterministic test pass drops live user input, and a drain that
 * delivered a pointer packet to the canvas refreshes its cursor. UI and
 * canvas share SDL's cursor: applying the canvas cursor after the whole
 * drain (including keyboard/controller/window events) would overwrite
 * RmlUi's hand even while the pointer remains over a button.
 *
 * `ui_filter` sees each event that survives the test-pass filter and
 * returns whether it still propagates to the scene — the retained-UI
 * loops pass `handle_ui_rml_event`, which consumes what the document
 * captured. `dispatched` runs after each event the scene received — the
 * two scene renderers pass their camera-controls dispatch, so that
 * contract lives here rather than in a hand-rolled copy of the drain.
 * Loops without one use the overloads below.
 */
template <typename UiEventFilter, typename DispatchedHook>
inline void poll_platform_events(
    Engine& engine,
    bool& running,
    bool test_pass,
    UiEventFilter&& ui_filter,
    DispatchedHook&& dispatched) {
    SDL_Event event;
    while (SDL_PollEvent(&event)) {
        if (
            event.type == SDL_EVENT_QUIT ||
            event.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED) {
            running = false;
        }
        if (
            test_pass &&
            is_platform_input_event(event) &&
            !is_replayed_ui_event(event)) {
            continue;
        }
        if (event.type == SDL_EVENT_KEY_DOWN || event.type == SDL_EVENT_KEY_UP) {
            // Window listeners receive keyboard events bubbling from focused
            // controls too. Run them before RmlUi's default actions so a
            // source preventDefault suppresses scrolling/activation, not the
            // application listener itself. Camera controls still yield to UI.
            const auto code = keyboard_event_code(event.key.scancode);
            const bool prevented = !code.empty() && dispatch_platform_keyboard_event(
                engine, code, event.type == SDL_EVENT_KEY_DOWN, event.key.repeat,
                (event.key.mod & SDL_KMOD_SHIFT) != 0, (event.key.mod & SDL_KMOD_CTRL) != 0,
                (event.key.mod & SDL_KMOD_ALT) != 0, (event.key.mod & SDL_KMOD_GUI) != 0);
            release_pointer_lock_on_escape(SDL_GetWindowFromID(event.key.windowID), engine,
                code, event.type == SDL_EVENT_KEY_DOWN);
            if (!prevented && ui_filter(event)) dispatched(event);
            continue;
        }
        if (!ui_filter(event)) continue;
        handle_platform_event(event, engine);
        dispatched(event);
        if (event.type == SDL_EVENT_MOUSE_MOTION ||
            event.type == SDL_EVENT_MOUSE_BUTTON_DOWN ||
            event.type == SDL_EVENT_MOUSE_BUTTON_UP ||
            event.type == SDL_EVENT_MOUSE_WHEEL) {
            apply_canvas_cursor(engine);
        }
    }
}

template <typename UiEventFilter>
inline void poll_platform_events(
    Engine& engine,
    bool& running,
    bool test_pass,
    UiEventFilter&& ui_filter) {
    poll_platform_events(
        engine,
        running,
        test_pass,
        std::forward<UiEventFilter>(ui_filter),
        [](const SDL_Event&) {});
}

inline void poll_platform_events(
    Engine& engine,
    bool& running,
    bool test_pass) {
    poll_platform_events(
        engine,
        running,
        test_pass,
        [](const SDL_Event&) { return true; });
}

} // namespace bbl::pal

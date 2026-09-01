// DOM-compatible application events shared by every SDL-backed frame loop.
#pragma once

#include <bblite/runtime.hpp>

#include <SDL3/SDL.h>

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
    for (const auto& callback : engine.mouse_wheel_callbacks) {
        callback(event);
    }
}

/**
 * Opt-in frame-indexed input for deterministic native diagnostics.
 *
 * BBLITE_INPUT_REPLAY is a comma-separated sequence of DOM KeyboardEvent.code
 * values. A plain entry is dispatched as a down/up pair in one frame, `+Code`
 * dispatches key-down only, `-Code` dispatches key-up only, and `-` is an idle
 * frame. `MouseLeft`, `MouseMiddle`, and `MouseRight` follow the same prefix
 * convention. `WheelUp` and `WheelDown` dispatch one browser-sized wheel notch
 * at the canvas centre. All forms reach the application's ordinary callbacks
 * and do not mutate generated source or camera state directly.
 */
inline void sync_pointer_lock(SDL_Window* window, Engine& engine);

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

    void dispatch(long frame, SDL_Window* window, Engine& engine) const {
        if (
            frame < 0 ||
            static_cast<std::size_t>(frame) >= codes_.size()) {
            return;
        }
        const std::string& code =
            codes_[static_cast<std::size_t>(frame)];
        if (code.empty() || code == "-") return;
        if (code == "WheelUp" || code == "WheelDown") {
            dispatch_platform_wheel_event(
                engine,
                code == "WheelUp" ? -100.0 : 100.0,
                static_cast<double>(engine.options.width) / 2.0,
                static_cast<double>(engine.options.height) / 2.0);
            return;
        }
        const bool down_only = code.size() > 1 && code.front() == '+';
        const bool up_only = code.size() > 1 && code.front() == '-';
        const std::string_view event_code =
            down_only || up_only
                ? std::string_view(code).substr(1)
                : std::string_view(code);
        double mouse_button = -1.0;
        double mouse_mask = 0.0;
        if (event_code == "MouseLeft") {
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
                const PlatformMouseEvent event{
                    .button = mouse_button,
                    .buttons = down ? mouse_mask : 0.0,
                    .client_x = static_cast<double>(engine.options.width) / 2.0,
                    .client_y = static_cast<double>(engine.options.height) / 2.0,
                };
                const auto& callbacks = down
                    ? engine.mouse_down_callbacks
                    : engine.mouse_up_callbacks;
                for (const auto& callback : callbacks) callback(event);
                sync_pointer_lock(window, engine);
            };
            if (!up_only) dispatch_mouse(true);
            if (!down_only) dispatch_mouse(false);
            return;
        }
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
    for (const auto& callback : engine.pointer_lock_change_callbacks) {
        callback();
    }
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
            for (const auto& callback : engine.window_resize_callbacks) {
                callback();
            }
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
        const auto& callbacks =
            event.type == SDL_EVENT_MOUSE_BUTTON_DOWN
                ? engine.mouse_down_callbacks
                : engine.mouse_up_callbacks;
        for (const auto& callback : callbacks) {
            callback(mouse_event);
        }
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
        for (const auto& callback : engine.mouse_move_callbacks) {
            callback(mouse_event);
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
        const PlatformMouseEvent mouse_event{
            .button = -1.0,
            .buttons = 0.0,
        };
        for (const auto& callback : engine.mouse_cancel_callbacks) {
            callback(mouse_event);
        }
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
        for (const auto& callback : engine.visibility_change_callbacks) {
            callback(hidden);
        }
    }
}

/**
 * One drain of the SDL event queue, shared by every frame loop so no
 * loop can hold a partial copy of the contract: quit flips `running`, a
 * deterministic test pass drops live user input, and a drain that
 * dispatched anything refreshes the reached canvas-cursor surface once
 * at its end -- the cursor is pure engine state, so applying it per
 * event only repeated the same answer. The cursor arm used to be
 * per-driver and one driver forgot it; composing the loop here is what
 * makes that class of asymmetry impossible.
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
    bool any_dispatched = false;
    while (SDL_PollEvent(&event)) {
        if (event.type == SDL_EVENT_QUIT) running = false;
        if (test_pass && is_platform_input_event(event)) {
            continue;
        }
        if (!ui_filter(event)) continue;
        handle_platform_event(event, engine);
        any_dispatched = true;
        dispatched(event);
    }
    if (any_dispatched) apply_canvas_cursor(engine);
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

// DOM-compatible application events shared by every SDL-backed frame loop.
#pragma once

#include <bblite/features/device_recovery.hpp>
#include <bblite/features/has_browser_file.hpp>
#include <bblite/features/has_gamepad.hpp>
#include <bblite/features/workers.hpp>

#include <bblite/runtime.hpp>
#include <bblite/pal_offscreen.hpp>
#include <bblite/pal_dom_events.hpp>

#include <SDL3/SDL.h>

#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "pal_input_capabilities.hpp"
#include "pal_runtime_trace.hpp"

#if BBLITE_HAS_BROWSER_FILE
#include "pal_file_dialog.hpp"
#endif
#if BBLITE_HAS_GAMEPAD
#include <bblite/pal_dom_gamepads.hpp>
#include "pal_gamepads.hpp"
#endif
#include "pal_window.hpp"
#include "pal_sdl_application.hpp"

namespace bbl::pal {

inline bool is_touch_event(const SDL_Event& event) {
    return event.type == SDL_EVENT_FINGER_DOWN || event.type == SDL_EVENT_FINGER_MOTION ||
           event.type == SDL_EVENT_FINGER_UP || event.type == SDL_EVENT_FINGER_CANCELED;
}

inline bool is_emulated_touch_mouse(const SDL_Event& event) {
    return (event.type == SDL_EVENT_MOUSE_MOTION && event.motion.which == SDL_TOUCH_MOUSEID) ||
           ((event.type == SDL_EVENT_MOUSE_BUTTON_DOWN ||
             event.type == SDL_EVENT_MOUSE_BUTTON_UP) &&
            event.button.which == SDL_TOUCH_MOUSEID);
}

inline bool is_emulated_pointer_event(const SDL_Event& event) {
    return is_emulated_touch_mouse(event) ||
           (is_touch_event(event) && (event.tfinger.touchID == SDL_MOUSE_TOUCHID ||
                                      event.tfinger.touchID == SDL_PEN_TOUCHID));
}

/**
 * Moves one platform event into the page viewport (`Engine::ui_page_viewport`), the coordinates
 * every consumer reads input in -- a pointer or drop position from the viewport's origin, a touch
 * position and motion as fractions of the viewport -- and tells whether the page receives it. A
 * browser delivers no pointer press, touch or wheel in the letterbox a page without
 * `viewport-fit=cover` leaves around its safe rectangle. A press the page received keeps its moves
 * and its release wherever they land, as Chromium's pointer capture and implicit touch capture
 * keep them; a press it never received keeps neither (`Engine::ui_page_capture`).
 */
inline bool page_platform_event(Engine& engine, SDL_Event& event) {
    const PageViewport& page = engine.ui_page_viewport;
    PageInputCapture& capture = engine.ui_page_capture;
    const bool letterboxed = page.laid_out() && !page.whole_window();
    const auto x = static_cast<float>(page.window_x), y = static_cast<float>(page.window_y);
    const auto move = [&](float& px, float& py) {
        if (letterboxed) {
            px -= x;
            py -= y;
        }
    };
    // Whether a moved position lies in the page; a locked pointer has no position.
    const auto inside = [&](float px, float py) {
        return !letterboxed || engine.pointer_locked ||
               (px >= 0 && py >= 0 && px < page.window_width && py < page.window_height);
    };
    switch (event.type) {
    case SDL_EVENT_MOUSE_MOTION:
        move(event.motion.x, event.motion.y);
        return !capture.buttons.received.empty() || inside(event.motion.x, event.motion.y);
    case SDL_EVENT_MOUSE_BUTTON_DOWN:
        move(event.button.x, event.button.y);
        return capture.buttons.press(event.button.button, inside(event.button.x, event.button.y));
    case SDL_EVENT_MOUSE_BUTTON_UP:
        move(event.button.x, event.button.y);
        return capture.buttons.follow(event.button.button, inside(event.button.x, event.button.y),
                                      true);
    case SDL_EVENT_MOUSE_WHEEL:
        move(event.wheel.mouse_x, event.wheel.mouse_y);
        return inside(event.wheel.mouse_x, event.wheel.mouse_y);
    case SDL_EVENT_DROP_BEGIN:
    case SDL_EVENT_DROP_POSITION:
    case SDL_EVENT_DROP_FILE:
    case SDL_EVENT_DROP_TEXT:
    case SDL_EVENT_DROP_COMPLETE:
        move(event.drop.x, event.drop.y);
        return true;
    case SDL_EVENT_WINDOW_FOCUS_LOST:
        // Focus loss cancels every press.
        capture = {};
        return true;
    default:
        break;
    }
    if (!is_touch_event(event))
        return true;
    int width = 0, height = 0;
    const bool moved =
        letterboxed &&
        SDL_GetWindowSize(SDL_GetWindowFromID(event.tfinger.windowID), &width, &height) &&
        width > 0 && height > 0;
    if (moved) {
        event.tfinger.x = (event.tfinger.x * static_cast<float>(width) - x) /
                          static_cast<float>(page.window_width);
        event.tfinger.y = (event.tfinger.y * static_cast<float>(height) - y) /
                          static_cast<float>(page.window_height);
        event.tfinger.dx *= static_cast<float>(width / page.window_width);
        event.tfinger.dy *= static_cast<float>(height / page.window_height);
    }
    const std::pair<std::uint64_t, std::uint64_t> key{event.tfinger.touchID,
                                                      event.tfinger.fingerID};
    const bool in = !moved || (event.tfinger.x >= 0 && event.tfinger.y >= 0 &&
                               event.tfinger.x < 1 && event.tfinger.y < 1);
    if (event.type == SDL_EVENT_FINGER_DOWN)
        return capture.touches.press(key, in);
    return capture.touches.follow(key, in, event.type != SDL_EVENT_FINGER_MOTION);
}

/** True for live user input that must not leak into deterministic test runs. */
inline bool is_platform_input_event(const SDL_Event& event) {
    return event.type == SDL_EVENT_KEY_DOWN || event.type == SDL_EVENT_KEY_UP ||
           event.type == SDL_EVENT_TEXT_EDITING || event.type == SDL_EVENT_TEXT_INPUT ||
           event.type == SDL_EVENT_MOUSE_MOTION || event.type == SDL_EVENT_MOUSE_BUTTON_DOWN ||
           event.type == SDL_EVENT_MOUSE_BUTTON_UP || event.type == SDL_EVENT_MOUSE_WHEEL ||
           event.type == SDL_EVENT_GAMEPAD_BUTTON_DOWN ||
           event.type == SDL_EVENT_GAMEPAD_BUTTON_UP ||
           event.type == SDL_EVENT_GAMEPAD_AXIS_MOTION || is_touch_event(event);
}

inline std::string keyboard_event_key(std::string_view code) {
    if (code.size() == 4u && code.substr(0u, 3u) == "Key") {
        const char letter = code[3];
        return std::string(
            1u, static_cast<char>(letter >= 'A' && letter <= 'Z' ? letter - 'A' + 'a' : letter));
    }
    if (code.size() == 6u && code.substr(0u, 5u) == "Digit") {
        return std::string(1u, code[5]);
    }
    if (code == "Space")
        return " ";
    return std::string(code);
}

/** The modifier keys an SDL modifier state holds. */
inline PlatformModifierKeys dom_modifiers(SDL_Keymod modifiers) {
    return {
        .shift_key = (modifiers & SDL_KMOD_SHIFT) != 0,
        .ctrl_key = (modifiers & SDL_KMOD_CTRL) != 0,
        .alt_key = (modifiers & SDL_KMOD_ALT) != 0,
        .meta_key = (modifiers & SDL_KMOD_GUI) != 0,
    };
}

/**
 * Tracks `Engine::text_composing` from every event a Window loop takes, ahead of the key events
 * that read it: a keydown opening a composition precedes its first edit, and the commit's keyup
 * follows its text, as browsers order `isComposing`.
 */
inline void observe_text_composition(Engine& engine, const SDL_Event& event) {
    if (event.type == SDL_EVENT_TEXT_EDITING)
        engine.text_composing = event.edit.text != nullptr && *event.edit.text != '\0';
    else if (event.type == SDL_EVENT_TEXT_INPUT || event.type == SDL_EVENT_WINDOW_FOCUS_LOST)
        engine.text_composing = false;
    else if (engine.text_composing &&
             (event.type == SDL_EVENT_KEY_DOWN || event.type == SDL_EVENT_KEY_UP)) {
        auto* window = SDL_GetWindowFromID(event.key.windowID);
        engine.text_composing = window != nullptr && SDL_TextInputActive(window);
    }
}

/** The keyboard event a platform key reports, with the engine's composition state. */
inline PlatformKeyboardEvent platform_keyboard_event(const Engine& engine, std::string_view code,
                                                     bool repeat, PlatformModifierKeys modifiers) {
    PlatformKeyboardEvent event{
        .code = std::string(code),
        .key = keyboard_event_key(code),
        .repeat = repeat,
        .is_composing = engine.text_composing,
    };
    static_cast<PlatformModifierKeys&>(event) = modifiers;
    return event;
}

inline bool dispatch_platform_keyboard_event(Engine& engine, std::string_view code, bool down,
                                             bool repeat, PlatformModifierKeys modifiers = {},
                                             bool include_dom = true) {
    trace_keyboard_event(code, down, repeat);
    const auto event = platform_keyboard_event(engine, code, repeat, modifiers);
    bool prevented = false;
    if (include_dom && engine.dom_input) {
        const auto& input = *engine.dom_input;
        auto batch = std::make_shared<DomEventBatch>();
        batch->add(dom_event(event, down ? "keydown" : "keyup",
                             input.focus_path ? input.focus_path() : dom_canvas_path()),
                   true);
        dispatch_dom_batch(engine, batch);
        if (!batch->ready())
            throw std::logic_error("Direct keyboard dispatch cannot defer callbacks.");
        prevented = batch->default_prevented;
    }
    auto& callbacks = down ? engine.key_down_callbacks : engine.key_up_callbacks;
    callbacks.dispatch(event);
    return prevented || event.default_prevented;
}

inline bool canvas_contains_client_point(const Engine& engine, const PlatformMouseEvent& event);

inline bool dispatch_dom_platform_pointer(Engine& engine, DomPointerAction action,
                                          const PlatformMouseEvent& event) {
    if (!engine.dom_input)
        return false;
    const auto& input = *engine.dom_input;
    auto path =
        input.hit_path ? input.hit_path(event.client_x, event.client_y)
        : canvas_contains_client_point(engine, event)
            ? dom_canvas_path()
            : std::vector<DomEventTarget>{DomEventTarget::document(), DomEventTarget::window()};
    const auto batch = dom_pointer_input(engine, action, event, std::move(path));
    dispatch_dom_batch(engine, batch);
    if (!batch->ready())
        throw std::logic_error("Direct pointer dispatch cannot defer callbacks.");
    return batch->default_prevented;
}

inline void dispatch_platform_mouse_move(Engine& engine, const PlatformMouseEvent& event,
                                         bool include_dom = true) {
    if (include_dom && dispatch_dom_platform_pointer(engine, DomPointerAction::Move, event))
        return;
    if (canvas_contains_client_point(engine, event))
        engine.mouse_move_callbacks.dispatch(event);
}

inline void dispatch_platform_wheel_event(Engine& engine, double delta_y, double client_x,
                                          double client_y, double buttons = 0.0,
                                          bool include_dom = true) {
    const PlatformMouseEvent event{
        .button = -1.0,
        .buttons = buttons,
        .client_x = client_x,
        .client_y = client_y,
        .delta_y = delta_y,
    };
    if (include_dom && dispatch_dom_platform_pointer(engine, DomPointerAction::Wheel, event))
        return;
    if (!canvas_contains_client_point(engine, event))
        return;
    engine.mouse_wheel_callbacks.dispatch(event);
}

/** Browser events never expose clicks on the host window's decorations. */
inline bool canvas_contains_client_point(const Engine& engine, const PlatformMouseEvent& event) {
    return event.client_x >= 0.0 && event.client_y >= 0.0 &&
           event.client_x < engine.canvas_client_width &&
           event.client_y < engine.canvas_client_height;
}

inline void dispatch_platform_pointer_down(Engine& engine, const PlatformMouseEvent& event) {
    if (!canvas_contains_client_point(engine, event))
        return;
    engine.pointer_down_callbacks.dispatch();
    if (event.button == 0.0)
        engine.canvas_click_armed = true;
}

inline void dispatch_canvas_click(Engine& engine, const PlatformMouseEvent& event) {
    if (event.button != 0.0)
        return;
    const bool dispatch = engine.canvas_click_armed && canvas_contains_client_point(engine, event);
    engine.canvas_click_armed = false;
    if (!dispatch)
        return;
    engine.canvas_click_callbacks.dispatch();
}

inline void dispatch_platform_mouse_button(Engine& engine, const PlatformMouseEvent& event,
                                           bool down, bool include_dom = true) {
    if (include_dom && dispatch_dom_platform_pointer(
                           engine, down ? DomPointerAction::Down : DomPointerAction::Up, event)) {
        if (!down)
            engine.canvas_click_armed = false;
        return;
    }
    const bool inside = canvas_contains_client_point(engine, event);
    if (down) {
        if (!inside)
            return;
        dispatch_platform_pointer_down(engine, event);
        engine.mouse_down_callbacks.dispatch(event);
        return;
    }
    if (inside)
        engine.mouse_up_callbacks.dispatch(event);
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
 * `UiMove@x:y` and `+UiMouseLeft@x:y`/`-UiMouseLeft@x:y` (also MouseRight)
 * use that same SDL path for hover and held drags, including camera controls.
 * `UiKey@Ctrl+A` (SDL key names, optional Ctrl+) queues a key press/release;
 * `UiText@hex` queues UTF-8 bytes as an SDL text input event.
 * `UiWheelUp`/`UiWheelDown` queue SDL wheel packets at the canvas center.
 * `WheelUp`/`WheelDown` dispatch a browser-sized wheel notch, and
 * `WindowResize@width:height` resizes this application's window, while
 * `WindowClose` queues the host close request. All forms reach the ordinary
 * platform callbacks without mutating generated source or scene state.
 * The engine owns the tape position and held buttons so a scene replacement
 * resumes the same recording instead of replaying it from the beginning.
 * Recovery builds also accept `Dataset@key=value`, `GlobalCall@name`, and
 * `DeviceLoss` for the source's dataset handshake, retained hooks, and loss API.
 */
inline void sync_pointer_lock(SDL_Window* window, Engine& engine);
inline double dom_mouse_buttons(SDL_MouseButtonFlags pressed);

inline void release_pointer_lock_on_escape(SDL_Window* window, Engine& engine,
                                           std::string_view code, bool key_down) {
    if (!key_down || code != "Escape" || !engine.pointer_locked)
        return;
    engine.pointer_lock_requested = false;
    sync_pointer_lock(window, engine);
}

// SDL reserves -1 and -2 for touch/pen mouse emulation.
inline constexpr SDL_MouseID replay_ui_mouse_id = static_cast<SDL_MouseID>(~0u - 2u);

class PlatformInputReplay {
public:
    PlatformInputReplay() {
        const std::string source = environment_variable("BBLITE_INPUT_REPLAY");
        std::size_t begin = 0;
        while (begin <= source.size()) {
            const std::size_t end = source.find(',', begin);
            const std::size_t length =
                end == std::string::npos ? source.size() - begin : end - begin;
            codes_.push_back(source.substr(begin, length));
            if (end == std::string::npos)
                break;
            begin = end + 1;
        }
        if (source.empty())
            codes_.clear();
    }

    void dispatch(long frame, SDL_Window* window, Engine& engine) {
#if BBLITE_WORKERS
        if (OffscreenRun::current())
            return; // The Window owns the input tape.
#endif
        if (codes_.empty() || frame < 0 || frame == last_frame_)
            return;
        last_frame_ = frame;
        const std::size_t index = engine.input_replay_next_frame;
        if (index >= codes_.size())
            return;
        ++engine.input_replay_next_frame;
        unsigned int& mouse_buttons_ = engine.input_replay_mouse_buttons;
        const std::string& code = codes_[index];
        if (code.empty() || code == "-")
            return;
        if (code.starts_with("Dataset@")) {
            const auto equal = code.find('=', 8);
            if (equal == std::string::npos || equal == 8)
                throw std::runtime_error("Dataset replay requires a key and value.");
            set_canvas_dataset(engine, code.substr(8, equal - 8), code.substr(equal + 1));
            return;
        }
#if BBLITE_DEVICE_RECOVERY
        if (code.starts_with("GlobalCall@")) {
            if (!engine.device_recovery)
                throw std::runtime_error("Global replay callback is not registered.");
            const auto callback = engine.device_recovery->globals.at(code.substr(11));
            callback();
            return;
        }
        if (code == "DeviceLoss") {
            force_device_loss(engine);
            return;
        }
#endif
        if (code == "UiWheelUp" || code == "UiWheelDown") {
            SDL_Event wheel{};
            wheel.type = SDL_EVENT_MOUSE_WHEEL;
            wheel.wheel.windowID = window ? SDL_GetWindowID(window) : 0;
            wheel.wheel.which = replay_ui_mouse_id;
            wheel.wheel.y = code == "UiWheelUp" ? 1.f : -1.f;
            wheel.wheel.mouse_x = static_cast<float>(engine.canvas_client_width / 2);
            wheel.wheel.mouse_y = static_cast<float>(engine.canvas_client_height / 2);
            if (!SDL_PushEvent(&wheel))
                throw std::runtime_error("Unable to queue deterministic UI wheel input.");
            return;
        }
        if (code.starts_with("UiText@")) {
            const auto hex = std::string_view(code).substr(7);
            if (hex.size() % 2)
                throw std::runtime_error("Text input replay requires pairs of hexadecimal digits.");
            replay_text_.clear();
            for (std::size_t i = 0; i < hex.size(); i += 2) {
                unsigned int byte = 0;
                const auto parsed = std::from_chars(hex.data() + i, hex.data() + i + 2, byte, 16);
                if (parsed.ec != std::errc{} || parsed.ptr != hex.data() + i + 2 || byte == 0)
                    throw std::runtime_error(
                        "Text input replay contains invalid UTF-8 byte encoding.");
                replay_text_.push_back(static_cast<char>(byte));
            }
            SDL_Event input{};
            input.type = SDL_EVENT_TEXT_INPUT;
            input.text.reserved = ~0u;
            input.text.windowID = window ? SDL_GetWindowID(window) : 0;
            input.text.text = replay_text_.c_str();
            if (!SDL_PushEvent(&input))
                throw std::runtime_error("Unable to queue deterministic text input.");
            return;
        }
        // `UiKey@Name` presses and releases a key; `+UiKey@Name` holds it, `-UiKey@Name`
        // releases it, frames apart.
        const bool key_hold = code.starts_with("+UiKey@");
        const bool key_release = code.starts_with("-UiKey@");
        if (code.starts_with("UiKey@") || key_hold || key_release) {
            std::string name = code.substr(key_hold || key_release ? 7 : 6);
            const bool control = name.starts_with("Ctrl+");
            if (control)
                name.erase(0, 5);
            const auto scancode = SDL_GetScancodeFromName(name.c_str());
            if (scancode == SDL_SCANCODE_UNKNOWN)
                throw std::runtime_error("Unknown SDL key name in UI input replay.");
            SDL_Event key{};
            key.type = SDL_EVENT_KEY_DOWN;
            key.key.windowID = window ? SDL_GetWindowID(window) : 0;
            key.key.which = ~0u;
            key.key.scancode = scancode;
            key.key.mod = control ? SDL_KMOD_CTRL : SDL_KMOD_NONE;
            key.key.key = SDL_GetKeyFromScancode(scancode, key.key.mod, false);
            key.key.down = true;
            if (!key_release && !SDL_PushEvent(&key))
                throw std::runtime_error("Unable to queue deterministic UI key down.");
            key.type = SDL_EVENT_KEY_UP;
            key.key.down = false;
            if (!key_hold && !SDL_PushEvent(&key))
                throw std::runtime_error("Unable to queue deterministic UI key up.");
            return;
        }
        if (const auto size = pointer_position(code, "WindowResize@")) {
            if (!window || size->first <= 0 || size->second <= 0 || size->first > 16384 ||
                size->second > 16384 ||
                !SDL_SetWindowSize(window, static_cast<int>(size->first),
                                   static_cast<int>(size->second))) {
                throw std::runtime_error("Unable to apply deterministic window resize.");
            }
            return;
        }
        if (code == "WindowClose") {
            SDL_Event close_event{};
            close_event.type = SDL_EVENT_WINDOW_CLOSE_REQUESTED;
            close_event.window.type = SDL_EVENT_WINDOW_CLOSE_REQUESTED;
            close_event.window.windowID = window ? SDL_GetWindowID(window) : 0;
            if (!SDL_PushEvent(&close_event)) {
                throw std::runtime_error("Unable to queue deterministic window-close input.");
            }
            return;
        }
        if (code == "MouseMoveRight") {
            const PlatformMouseEvent event{
                .button = -1.0,
                .buttons = dom_mouse_buttons(mouse_buttons_),
                .client_x = engine.canvas_client_width / 2.0,
                .client_y = engine.canvas_client_height / 2.0,
                .movement_x = 100.0,
            };
            dispatch_platform_mouse_move(engine, event);
            return;
        }
        if (const auto point = pointer_position(code, "MouseMove@")) {
            const PlatformMouseEvent event{
                .button = -1.0,
                .buttons = dom_mouse_buttons(mouse_buttons_),
                .client_x = point->first,
                .client_y = point->second,
            };
            dispatch_platform_mouse_move(engine, event);
            return;
        }
        const auto ui_click = pointer_position(code, "UiClick@");
        const auto ui_move = pointer_position(code, "UiMove@");
        const bool right = code.starts_with("+UiMouseRight@") || code.starts_with("-UiMouseRight@");
        const auto ui_down = pointer_position(code, right ? "+UiMouseRight@" : "+UiMouseLeft@");
        const auto ui_up = pointer_position(code, right ? "-UiMouseRight@" : "-UiMouseLeft@");
        if (const auto point = ui_click  ? ui_click
                               : ui_move ? ui_move
                               : ui_down ? ui_down
                                         : ui_up) {
            const std::uint32_t window_id = window ? SDL_GetWindowID(window) : 0;
            SDL_Event motion{};
            motion.type = SDL_EVENT_MOUSE_MOTION;
            motion.motion.type = SDL_EVENT_MOUSE_MOTION;
            motion.motion.windowID = window_id;
            motion.motion.which = replay_ui_mouse_id;
            motion.motion.x = static_cast<float>(point->first);
            motion.motion.y = static_cast<float>(point->second);
            motion.motion.xrel = static_cast<float>(point->first - engine.input_replay_pointer_x);
            motion.motion.yrel = static_cast<float>(point->second - engine.input_replay_pointer_y);
            // Windows relative packets can omit held buttons; transitions remain authoritative.
            motion.motion.state =
                window && SDL_GetWindowRelativeMouseMode(window) ? 0 : mouse_buttons_;
            engine.input_replay_pointer_x = point->first;
            engine.input_replay_pointer_y = point->second;
            SDL_Event down{};
            down.type = SDL_EVENT_MOUSE_BUTTON_DOWN;
            down.button.type = SDL_EVENT_MOUSE_BUTTON_DOWN;
            down.button.windowID = window_id;
            down.button.which = replay_ui_mouse_id;
            down.button.button = right ? SDL_BUTTON_RIGHT : SDL_BUTTON_LEFT;
            down.button.down = true;
            down.button.x = static_cast<float>(point->first);
            down.button.y = static_cast<float>(point->second);
            SDL_Event up = down;
            up.type = SDL_EVENT_MOUSE_BUTTON_UP;
            up.button.type = SDL_EVENT_MOUSE_BUTTON_UP;
            up.button.down = false;
            const auto queue = [](SDL_Event& event) {
                if (!SDL_PushEvent(&event)) {
                    throw std::runtime_error("Unable to queue deterministic pointer input.");
                }
            };
            queue(motion);
            if (ui_click || ui_down) {
                mouse_buttons_ |= SDL_BUTTON_MASK(down.button.button);
                queue(down);
            }
            if (ui_click || ui_up) {
                mouse_buttons_ &= ~SDL_BUTTON_MASK(down.button.button);
                queue(up);
            }
            return;
        }
        if (code == "WheelUp" || code == "WheelDown") {
            dispatch_platform_wheel_event(
                engine, code == "WheelUp" ? -100.0 : 100.0, engine.canvas_client_width / 2.0,
                engine.canvas_client_height / 2.0, dom_mouse_buttons(mouse_buttons_));
            return;
        }
        const bool down_only = code.size() > 1 && code.front() == '+';
        const bool up_only = code.size() > 1 && code.front() == '-';
        std::string_view event_code =
            down_only || up_only ? std::string_view(code).substr(1) : std::string_view(code);
        bool ctrl_key = false;
        if (event_code.starts_with("Ctrl+")) {
            ctrl_key = true;
            event_code.remove_prefix(5);
        }
        double mouse_button = -1.0;
        SDL_MouseButtonFlags mouse_mask = 0;
        const auto left_point = pointer_position(event_code, "MouseLeft@");
        const bool outside_canvas = event_code == "MouseLeftOutsideCanvas";
        if (event_code == "MouseLeft" || left_point || outside_canvas) {
            mouse_button = 0.0;
            mouse_mask = SDL_BUTTON_LMASK;
        } else if (event_code == "MouseMiddle") {
            mouse_button = 1.0;
            mouse_mask = SDL_BUTTON_MMASK;
        } else if (event_code == "MouseRight") {
            mouse_button = 2.0;
            mouse_mask = SDL_BUTTON_RMASK;
        }
        if (mouse_button >= 0.0) {
            const auto dispatch_mouse = [&](bool down) {
                if (down) {
                    mouse_buttons_ |= mouse_mask;
                } else {
                    mouse_buttons_ &= ~mouse_mask;
                }
                const PlatformMouseEvent event{
                    .button = mouse_button,
                    .buttons = dom_mouse_buttons(mouse_buttons_),
                    .client_x = outside_canvas ? -1.0
                                : left_point   ? left_point->first
                                               : engine.canvas_client_width / 2.0,
                    .client_y = outside_canvas ? -1.0
                                : left_point   ? left_point->second
                                               : engine.canvas_client_height / 2.0,
                };
                dispatch_platform_mouse_button(engine, event, down);
                sync_pointer_lock(window, engine);
            };
            if (!up_only)
                dispatch_mouse(true);
            if (!down_only)
                dispatch_mouse(false);
            return;
        }
        if (!up_only) {
            dispatch_platform_keyboard_event(engine, event_code, true, false,
                                             {.ctrl_key = ctrl_key});
            release_pointer_lock_on_escape(window, engine, event_code, true);
        }
        if (!down_only) {
            dispatch_platform_keyboard_event(engine, event_code, false, false,
                                             {.ctrl_key = ctrl_key});
        }
    }

private:
    static std::optional<std::pair<double, double>> pointer_position(std::string_view value,
                                                                     std::string_view prefix) {
        if (!value.starts_with(prefix))
            return std::nullopt;
        value.remove_prefix(prefix.size());
        const std::size_t separator = value.find(':');
        if (separator == std::string_view::npos) {
            throw std::runtime_error("A coordinate input replay action requires @x:y.");
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
        return std::pair{parse(value.substr(0, separator)), parse(value.substr(separator + 1))};
    }

    std::vector<std::string> codes_;
    std::string replay_text_;
    long last_frame_ = -1;
};

inline bool is_replayed_ui_event(const SDL_Event& event) {
    if (event.type == SDL_EVENT_MOUSE_WHEEL)
        return event.wheel.which == replay_ui_mouse_id;
    if (event.type == SDL_EVENT_TEXT_INPUT)
        return event.text.reserved == ~0u;
    if (event.type == SDL_EVENT_KEY_DOWN || event.type == SDL_EVENT_KEY_UP)
        return event.key.which == ~0u;
    if (event.type == SDL_EVENT_MOUSE_MOTION) {
        return event.motion.which == replay_ui_mouse_id;
    }
    if (event.type == SDL_EVENT_MOUSE_BUTTON_DOWN || event.type == SDL_EVENT_MOUSE_BUTTON_UP) {
        return event.button.which == replay_ui_mouse_id;
    }
    return false;
}

/** DOM-compatible `KeyboardEvent.code` for the portable SDL scancodes. */
inline std::string_view keyboard_event_code(SDL_Scancode scancode) {
    switch (scancode) {
    case SDL_SCANCODE_LEFT:
        return "ArrowLeft";
    case SDL_SCANCODE_RIGHT:
        return "ArrowRight";
    case SDL_SCANCODE_UP:
        return "ArrowUp";
    case SDL_SCANCODE_DOWN:
        return "ArrowDown";
    case SDL_SCANCODE_SPACE:
        return "Space";
    case SDL_SCANCODE_ESCAPE:
        return "Escape";
    case SDL_SCANCODE_RETURN:
        return "Enter";
    case SDL_SCANCODE_TAB:
        return "Tab";
    case SDL_SCANCODE_BACKSPACE:
        return "Backspace";
    case SDL_SCANCODE_PAGEUP:
        return "PageUp";
    case SDL_SCANCODE_PAGEDOWN:
        return "PageDown";
    case SDL_SCANCODE_HOME:
        return "Home";
    case SDL_SCANCODE_END:
        return "End";
    case SDL_SCANCODE_INSERT:
        return "Insert";
    case SDL_SCANCODE_DELETE:
        return "Delete";
    case SDL_SCANCODE_F1:
        return "F1";
    case SDL_SCANCODE_F2:
        return "F2";
    case SDL_SCANCODE_F3:
        return "F3";
    case SDL_SCANCODE_F4:
        return "F4";
    case SDL_SCANCODE_F5:
        return "F5";
    case SDL_SCANCODE_F6:
        return "F6";
    case SDL_SCANCODE_F7:
        return "F7";
    case SDL_SCANCODE_F8:
        return "F8";
    case SDL_SCANCODE_F9:
        return "F9";
    case SDL_SCANCODE_F10:
        return "F10";
    case SDL_SCANCODE_F11:
        return "F11";
    case SDL_SCANCODE_F12:
        return "F12";
    case SDL_SCANCODE_LSHIFT:
        return "ShiftLeft";
    case SDL_SCANCODE_RSHIFT:
        return "ShiftRight";
    case SDL_SCANCODE_LCTRL:
        return "ControlLeft";
    case SDL_SCANCODE_RCTRL:
        return "ControlRight";
    case SDL_SCANCODE_LALT:
        return "AltLeft";
    case SDL_SCANCODE_RALT:
        return "AltRight";
    case SDL_SCANCODE_A:
        return "KeyA";
    case SDL_SCANCODE_B:
        return "KeyB";
    case SDL_SCANCODE_C:
        return "KeyC";
    case SDL_SCANCODE_D:
        return "KeyD";
    case SDL_SCANCODE_E:
        return "KeyE";
    case SDL_SCANCODE_F:
        return "KeyF";
    case SDL_SCANCODE_G:
        return "KeyG";
    case SDL_SCANCODE_H:
        return "KeyH";
    case SDL_SCANCODE_I:
        return "KeyI";
    case SDL_SCANCODE_J:
        return "KeyJ";
    case SDL_SCANCODE_K:
        return "KeyK";
    case SDL_SCANCODE_L:
        return "KeyL";
    case SDL_SCANCODE_M:
        return "KeyM";
    case SDL_SCANCODE_N:
        return "KeyN";
    case SDL_SCANCODE_O:
        return "KeyO";
    case SDL_SCANCODE_P:
        return "KeyP";
    case SDL_SCANCODE_Q:
        return "KeyQ";
    case SDL_SCANCODE_R:
        return "KeyR";
    case SDL_SCANCODE_S:
        return "KeyS";
    case SDL_SCANCODE_T:
        return "KeyT";
    case SDL_SCANCODE_U:
        return "KeyU";
    case SDL_SCANCODE_V:
        return "KeyV";
    case SDL_SCANCODE_W:
        return "KeyW";
    case SDL_SCANCODE_X:
        return "KeyX";
    case SDL_SCANCODE_Y:
        return "KeyY";
    case SDL_SCANCODE_Z:
        return "KeyZ";
    case SDL_SCANCODE_0:
        return "Digit0";
    case SDL_SCANCODE_1:
        return "Digit1";
    case SDL_SCANCODE_2:
        return "Digit2";
    case SDL_SCANCODE_3:
        return "Digit3";
    case SDL_SCANCODE_4:
        return "Digit4";
    case SDL_SCANCODE_5:
        return "Digit5";
    case SDL_SCANCODE_6:
        return "Digit6";
    case SDL_SCANCODE_7:
        return "Digit7";
    case SDL_SCANCODE_8:
        return "Digit8";
    case SDL_SCANCODE_9:
        return "Digit9";
    case SDL_SCANCODE_COMMA:
        return "Comma";
    case SDL_SCANCODE_PERIOD:
        return "Period";
    default:
        return {};
    }
}

/** A window's safe rectangle and its size, in window coordinates. */
struct WindowSafeArea {
    SDL_Rect safe{};
    int width = 0, height = 0;
};

/**
 * `BBLITE_SAFE_AREA_INSETS`, read once: top, right, bottom and left window-coordinate insets that
 * give a desktop window unsafe edges, as a notched phone's, to diagnose a page laid out inside
 * them.
 */
inline const std::optional<std::array<int, 4>>& diagnostic_safe_area_insets(Engine& engine) {
    if (engine.ui_diagnostic_safe_area_read)
        return engine.ui_diagnostic_safe_area;
    engine.ui_diagnostic_safe_area = []() -> std::optional<std::array<int, 4>> {
        const std::string text = environment_variable("BBLITE_SAFE_AREA_INSETS");
        if (text.empty())
            return std::nullopt;
        const auto refuse = [] {
            throw std::invalid_argument("BBLITE_SAFE_AREA_INSETS needs four comma-separated "
                                        "nonnegative integers: top,right,bottom,left.");
        };
        std::array<int, 4> read{};
        std::istringstream values(text);
        std::string value;
        for (int& inset : read) {
            if (!std::getline(values, value, ',') || value.empty() ||
                value.find_first_not_of("0123456789") != std::string::npos)
                refuse();
            inset = std::stoi(value);
        }
        if (text.back() == ',' || std::getline(values, value, ','))
            refuse();
        return read;
    }();
    engine.ui_diagnostic_safe_area_read = true;
    return engine.ui_diagnostic_safe_area;
}

/** The window's safe area: SDL's, or the diagnostic insets' (`diagnostic_safe_area_insets`). */
inline WindowSafeArea window_safe_area(SDL_Window* window, Engine& engine) {
    WindowSafeArea area;
    if (!SDL_GetWindowSize(window, &area.width, &area.height) ||
        !SDL_GetWindowSafeArea(window, &area.safe))
        throw std::runtime_error(std::string("SDL window safe area: ") + SDL_GetError());
    if (const auto& insets = diagnostic_safe_area_insets(engine)) {
        const auto [top, right, bottom, left] = *insets;
        area.safe = {left, top, std::max(0, area.width - left - right),
                     std::max(0, area.height - top - bottom)};
    }
    return area;
}

/**
 * Apply one SDL size/density snapshot to the browser canvas metrics and lay the page viewport
 * (`Engine::ui_page_viewport`) out in the `width` x `height` drawable of a window with `area`
 * (none: the drawable spans a window without insets). A browser keeps a page without
 * `viewport-fit=cover` inside the window's safe rectangle and lays a `cover` page out over the
 * whole window; the client extent is the page's. True when the canvas extent changed.
 */
inline bool update_engine_canvas_metrics(Engine& engine, int width, int height,
                                         double display_scale, double pixel_density,
                                         const std::optional<WindowSafeArea>& area = std::nullopt) {
    const WindowSafeArea window = area && area->width > 0 && area->height > 0
                                      ? *area
                                      : WindowSafeArea{{0, 0, width, height}, width, height};
    PageViewport page;
    page.pixels = {0, 0, width, height};
    page.drawable_width = width;
    page.drawable_height = height;
    const double scale_x = static_cast<double>(width) / window.width;
    const double scale_y = static_cast<double>(height) / window.height;
    const SDL_Rect& safe = window.safe;
    if (!engine.ui_viewport_fit_cover) {
        const auto edge = [](double value, int limit) {
            return std::clamp(static_cast<int>(std::lround(value)), 0, limit);
        };
        const int left = edge(safe.x * scale_x, width), top = edge(safe.y * scale_y, height);
        const int right = edge((safe.x + safe.w) * scale_x, width);
        const int bottom = edge((safe.y + safe.h) * scale_y, height);
        if (right > left && bottom > top)
            page.pixels = {left, top, right - left, bottom - top};
    }
    page.window_x = page.pixels.x / scale_x;
    page.window_y = page.pixels.y / scale_y;
    page.window_width = page.pixels.width / scale_x;
    page.window_height = page.pixels.height / scale_y;
    // CSS px per window coordinate.
    const double to_client = pixel_density / display_scale;
    page.inset_top = safe.y * to_client;
    page.inset_right = (window.width - safe.x - safe.w) * to_client;
    page.inset_bottom = (window.height - safe.y - safe.h) * to_client;
    page.inset_left = safe.x * to_client;
    const double client_width = page.pixels.width / display_scale;
    const double client_height = page.pixels.height / display_scale;
    const bool changed = engine.options.width != width || engine.options.height != height ||
                         engine.canvas_client_width != client_width ||
                         engine.canvas_client_height != client_height;
    engine.options.width = width;
    engine.options.height = height;
    engine.canvas_client_width = client_width;
    engine.canvas_client_height = client_height;
    engine.canvas_window_to_client_scale = to_client;
    engine.ui_page_viewport = page;
    return changed;
}

/**
 * Keep drawing-buffer pixels and CSS client extents live before callbacks.
 * SDL window coordinates are physical pixels on Windows and logical points
 * on macOS. Neither universally equals CSS pixels: those follow the window's
 * display scale, just like the retained UI's density-independent pixels.
 */
inline bool sync_engine_canvas_size(SDL_Window* window, Engine& engine) {
    if (const auto* offscreen = OffscreenRun::current()) {
        // The pin's render loop resizes each surface at the head of every frame.
        if (engine.update_surface_layout)
            engine.update_surface_layout(engine);
        else if (engine.resize_surface)
            engine.resize_surface(engine);
        const auto extent = offscreen->extent();
        const int width = static_cast<int>(extent.width);
        const int height = static_cast<int>(extent.height);
        const bool changed = engine.options.width != width || engine.options.height != height;
        engine.options.width = width;
        engine.options.height = height;
        if (runtime_trace_enabled()) {
            thread_local std::pair<int, int> traced{};
            if (traced != std::pair{width, height}) {
                traced = {width, height};
                std::cerr << "[bblite trace] canvas backing " << width << 'x' << height << '\n';
            }
        }
        return changed;
    }
    int width = 0;
    int height = 0;
    if (window && SDL_GetWindowSizeInPixels(window, &width, &height) && width > 0 && height > 0) {
        const float display_scale = window_render_density(window, engine.options);
        const float pixel_density = SDL_GetWindowPixelDensity(window);
        // A retained page lays out in the window's safe area.
        const bool changed = update_engine_canvas_metrics(
            engine, width, height, display_scale, pixel_density > 0.0f ? pixel_density : 1.0f,
            engine.ui_lays_out_page ? std::optional(window_safe_area(window, engine))
                                    : std::nullopt);
        if (changed && engine.dom_input)
            engine.dom_input->pending_resize = true;
        return changed;
    }
    return false;
}

/** Translate SDL's button masks to PointerEvent.buttons. */
inline double dom_mouse_buttons(SDL_MouseButtonFlags pressed) {
    return ((pressed & SDL_BUTTON_LMASK) != 0 ? 1.0 : 0.0) +
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
 * End the mouse capture a press requested before anything decides where its
 * release goes. RmlUi's SDL backend and the textarea resize grip request
 * SDL_CaptureMouse on a press; a prevented default or the pointer-lock filter
 * can withhold the release from them, and SDL applies a request left standing
 * whenever relative mode is off, sending every click, the window frame's
 * included, to the client area.
 */
inline void end_press_mouse_capture(const SDL_Event& event) {
    if (event.type == SDL_EVENT_MOUSE_BUTTON_UP)
        SDL_CaptureMouse(false);
}

/**
 * A captured mouse keeps its drag beyond the window, as the browser's does:
 * SDL captures the mouse while a pointer capture target holds it, whatever
 * SDL_HINT_MOUSE_AUTO_CAPTURE says (pointer lock turns it off). Where SDL has
 * no global capture (Wayland, mobile) the press's implicit grab still holds.
 */
inline void sync_dom_mouse_capture(DomInput& input) {
    const bool captured = input.capture_overrides.contains(dom_mouse_pointer_id);
    if (!captured && !input.platform_mouse_capture)
        return;
    static_cast<void>(SDL_CaptureMouse(captured));
    input.platform_mouse_capture = captured;
}

/** A release whose default was prevented never reaches retained UI; end its press there. */
inline void end_withheld_ui_press(Engine& engine, const SDL_Event& event) {
    if (event.type == SDL_EVENT_MOUSE_BUTTON_UP && engine.dom_input &&
        engine.dom_input->end_withheld_press)
        engine.dom_input->end_withheld_press();
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
    const double increment = event.direction == SDL_MOUSEWHEEL_FLIPPED
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
    if (engine.pointer_locked)
        return;
    if (engine.canvas_cursor == "none") {
        SDL_HideCursor();
        return;
    }
    SDL_ShowCursor();
    if (engine.canvas_cursor == "crosshair") {
        // One system cursor per run avoids allocating on each move; the
        // run's quit destroys it.
        SDL_Cursor*& crosshair = crosshair_cursor();
        if (!crosshair) {
            crosshair = SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_CROSSHAIR);
        }
        if (crosshair)
            SDL_SetCursor(crosshair);
        return;
    }
    SDL_SetCursor(SDL_GetDefaultCursor());
}

inline const char* pointer_lock_hint(const char* name) {
    const char* value = SDL_GetHint(name);
    return value ? value : "<unset>";
}

inline void trace_pointer_lock_state(std::string_view phase, SDL_Window* window,
                                     const Engine& engine) {
    if (!runtime_trace_enabled())
        return;
    std::cerr << "[bblite trace] pointer-lock phase=" << phase
              << " requested=" << (engine.pointer_lock_requested ? 1 : 0)
              << " locked=" << (engine.pointer_locked ? 1 : 0)
              << " relative=" << (window && SDL_GetWindowRelativeMouseMode(window) ? 1 : 0)
              << " cursor-visible=" << (SDL_CursorVisible() ? 1 : 0) << " relative-cursor-hint="
              << pointer_lock_hint(SDL_HINT_MOUSE_RELATIVE_CURSOR_VISIBLE)
              << " system-scale-hint=" << pointer_lock_hint(SDL_HINT_MOUSE_RELATIVE_SYSTEM_SCALE)
              << " speed-scale-hint=" << pointer_lock_hint(SDL_HINT_MOUSE_RELATIVE_SPEED_SCALE)
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
        SDL_SetHintWithPriority(SDL_HINT_MOUSE_AUTO_CAPTURE, "0", SDL_HINT_OVERRIDE);
        SDL_SetHintWithPriority(SDL_HINT_MOUSE_RELATIVE_SYSTEM_SCALE, "1", SDL_HINT_OVERRIDE);
        SDL_SetHintWithPriority(SDL_HINT_MOUSE_RELATIVE_SPEED_SCALE, "1.0", SDL_HINT_OVERRIDE);
        SDL_SetHintWithPriority(SDL_HINT_MOUSE_RELATIVE_CURSOR_VISIBLE, "0", SDL_HINT_OVERRIDE);
    }
    if (!SDL_SetWindowRelativeMouseMode(window, engine.pointer_lock_requested)) {
        if (runtime_trace_enabled()) {
            std::cerr << "[bblite trace] pointer-lock SDL error=\"" << SDL_GetError() << "\"\n";
        }
        trace_pointer_lock_state("sync-rejected", window, engine);
        return;
    }
    engine.pointer_locked = engine.pointer_lock_requested;
    apply_pointer_lock_cursor(engine.pointer_locked);
    trace_pointer_lock_state("sync-applied", window, engine);
    dispatch_pointer_lock_change(engine);
}

/** Whether a listener names a file drag event. */
inline bool listens_dom_drag(const DomInput& input) {
    return std::any_of(input.event_types.begin(), input.event_types.end(), [](const auto& type) {
        return type == "dragenter" || type == "dragover" || type == "dragleave" || type == "drop";
    });
}

/**
 * File drags over the window: dragenter and dragleave as the element under the
 * drag changes, dragover while it moves, and drop with the files read at the
 * drop; a drag that leaves or ends without files ends with dragleave.
 */
inline std::shared_ptr<DomEventBatch> dom_drag_input(Engine& engine, const SDL_Event& event) {
    auto& input = *engine.dom_input;
    const auto reset = [&] {
        input.drag_path.clear();
        input.dropped_files = {};
        input.drag_acceptance.reset();
    };
    if (event.type == SDL_EVENT_DROP_BEGIN || !listens_dom_drag(input)) {
        reset();
        return {};
    }
    auto batch = std::make_shared<DomEventBatch>();
    const auto add = [&](std::string type, const std::vector<DomEventTarget>& path, bool cancelable,
                         std::shared_ptr<const DroppedFiles> files) {
        PlatformDragEvent payload;
        payload.client_x = input.drag_x;
        payload.client_y = input.drag_y;
        payload.files = std::move(files);
        if (type == "dragover")
            payload.acceptance = input.drag_acceptance;
        batch->add(dom_event(std::move(payload), std::move(type), path, true, cancelable), true);
    };
    const auto move_to = [&](float x, float y) {
        input.drag_x = x * engine.canvas_window_to_client_scale;
        input.drag_y = y * engine.canvas_window_to_client_scale;
        auto path = input.hit_path ? input.hit_path(input.drag_x, input.drag_y) : dom_canvas_path();
        if (path.empty())
            throw std::logic_error("A file drag requires a DOM target path.");
        if (!input.drag_path.empty() && path.front() == input.drag_path.front())
            return false;
        add("dragenter", path, true, {});
        if (!input.drag_path.empty())
            add("dragleave", input.drag_path, false, {});
        input.drag_path = std::move(path);
        input.drag_acceptance = std::make_shared<std::atomic<bool>>(false);
        return true;
    };
    if (event.type == SDL_EVENT_DROP_POSITION) {
        move_to(event.drop.x, event.drop.y);
        add("dragover", input.drag_path, true, {});
        return batch;
    }
    if (event.type == SDL_EVENT_DROP_FILE) {
        // Platforms without drag positions report the drop's own coordinates.
        if (move_to(event.drop.x, event.drop.y))
            add("dragover", input.drag_path, true, {});
        if (!event.drop.data)
            throw std::runtime_error("A dropped file has no path.");
        if (input.dropped_files.count >= maximum_browser_file_snapshots)
            throw std::runtime_error("A file drop exceeds its 4096-file bound.");
#if BBLITE_HAS_BROWSER_FILE
        if (input.dropped_files.count == 0) {
            const std::u8string path(reinterpret_cast<const char8_t*>(event.drop.data));
            auto snapshot = detail::selected_file_snapshot(std::filesystem::path(path));
            input.dropped_files.bytes = std::move(snapshot.bytes);
            input.dropped_files.name = std::move(snapshot.display_name);
        }
#endif
        ++input.dropped_files.count;
        return batch;
    }
    if (event.type != SDL_EVENT_DROP_COMPLETE)
        return {};
    if (!input.drag_path.empty()) {
        if (input.dropped_files.count == 0 ||
            !input.drag_acceptance->load(std::memory_order_acquire))
            add("dragleave", input.drag_path, false, {});
        else
            add("drop", input.drag_path, true,
                std::make_shared<const DroppedFiles>(std::move(input.dropped_files)));
    }
    reset();
    return batch;
}

/** The page visibility a window event reports: hidden or minimized, or shown again. */
inline std::optional<bool> window_visibility(const SDL_Event& event) {
    if (event.type == SDL_EVENT_WINDOW_HIDDEN || event.type == SDL_EVENT_WINDOW_MINIMIZED)
        return true;
    if (event.type == SDL_EVENT_WINDOW_SHOWN || event.type == SDL_EVENT_WINDOW_RESTORED)
        return false;
    return std::nullopt;
}

/** Records document.hidden and dispatches visibilitychange when it changed. */
inline void set_document_hidden(Engine& engine, bool hidden) {
    if (engine.document_hidden == hidden)
        return;
    engine.document_hidden = hidden;
    engine.visibility_change_callbacks.dispatch(hidden);
}

inline void trace_pointer_motion(const Engine& engine, const SDL_MouseMotionEvent& event,
                                 const PlatformMouseEvent& pointer) {
    static thread_local std::size_t count = 0;
    if (runtime_trace_enabled() && count < 32 &&
        (engine.pointer_lock_requested || engine.pointer_locked || event.state != 0)) {
        ++count;
        std::cerr << "[bblite trace] input mouse-motion"
                  << " xrel=" << pointer.movement_x << " yrel=" << pointer.movement_y
                  << " sdl-mask=" << static_cast<unsigned long long>(event.state)
                  << " dom-buttons=" << pointer.buttons
                  << " requested=" << (engine.pointer_lock_requested ? 1 : 0)
                  << " locked=" << (engine.pointer_locked ? 1 : 0) << '\n';
    }
}

inline void handle_platform_event(const SDL_Event& event, Engine& engine, bool include_dom = true) {
    if (event.type == SDL_EVENT_WINDOW_RESIZED ||
        event.type == SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED ||
        event.type == SDL_EVENT_WINDOW_DISPLAY_SCALE_CHANGED) {
        if (sync_engine_canvas_size(SDL_GetWindowFromID(event.window.windowID), engine)) {
            engine.window_resize_callbacks.dispatch();
        }
        return;
    }
    if (event.type == SDL_EVENT_KEY_DOWN || event.type == SDL_EVENT_KEY_UP) {
        const std::string_view code = keyboard_event_code(event.key.scancode);
        if (code.empty())
            return;
        dispatch_platform_keyboard_event(engine, code, event.type == SDL_EVENT_KEY_DOWN,
                                         event.key.repeat, dom_modifiers(event.key.mod),
                                         include_dom);
        // Escape is reserved by the browser host to leave pointer lock; the
        // application does not need to register document.exitPointerLock()
        // for that affordance. SDL relative mode has no corresponding
        // default, so project the host behavior here for every scene that
        // explicitly opted into pointer lock.
        release_pointer_lock_on_escape(SDL_GetWindowFromID(event.key.windowID), engine, code,
                                       event.type == SDL_EVENT_KEY_DOWN);
        return;
    }
    if (event.type == SDL_EVENT_MOUSE_BUTTON_DOWN || event.type == SDL_EVENT_MOUSE_BUTTON_UP) {
        update_tracked_mouse_button(event.button);
        const SDL_MouseButtonFlags pressed = tracked_mouse_buttons();
        const PlatformMouseEvent mouse_event{
            .button = static_cast<double>(event.button.button - 1),
            .buttons = dom_mouse_buttons(pressed),
            .client_x = event.button.x * engine.canvas_window_to_client_scale,
            .client_y = event.button.y * engine.canvas_window_to_client_scale,
        };
        if (runtime_trace_enabled()) {
            std::cerr << "[bblite trace] input mouse-button state="
                      << (event.type == SDL_EVENT_MOUSE_BUTTON_DOWN ? "down" : "up")
                      << " sdl-button=" << static_cast<int>(event.button.button)
                      << " dom-button=" << mouse_event.button
                      << " sdl-mask=" << static_cast<unsigned long long>(pressed)
                      << " dom-buttons=" << mouse_event.buttons
                      << " requested-before=" << (engine.pointer_lock_requested ? 1 : 0)
                      << " locked-before=" << (engine.pointer_locked ? 1 : 0) << '\n';
        }
        dispatch_platform_mouse_button(engine, mouse_event,
                                       event.type == SDL_EVENT_MOUSE_BUTTON_DOWN, include_dom);
        if (runtime_trace_enabled()) {
            std::cerr << "[bblite trace] input mouse-button callbacks-complete"
                      << " requested-after=" << (engine.pointer_lock_requested ? 1 : 0)
                      << " locked-after=" << (engine.pointer_locked ? 1 : 0) << '\n';
        }
        sync_pointer_lock(SDL_GetWindowFromID(event.button.windowID), engine);
        return;
    }
    if (event.type == SDL_EVENT_MOUSE_MOTION) {
        const PlatformMouseEvent mouse_event{
            .button = -1.0,
            .buttons = dom_mouse_buttons(tracked_mouse_buttons()),
            .client_x = event.motion.x * engine.canvas_window_to_client_scale,
            .client_y = event.motion.y * engine.canvas_window_to_client_scale,
            .movement_x = static_cast<double>(event.motion.xrel),
            .movement_y = static_cast<double>(event.motion.yrel),
        };
        trace_pointer_motion(engine, event.motion, mouse_event);
        dispatch_platform_mouse_move(engine, mouse_event, include_dom);
        sync_pointer_lock(SDL_GetWindowFromID(event.motion.windowID), engine);
        return;
    }
    if (event.type == SDL_EVENT_MOUSE_WHEEL) {
        // DOM deltaY is positive when scrolling down. SDL's normalized Y is
        // positive away from the user; natural-scroll devices mark FLIPPED.
        const double delta_y = dom_wheel_delta_y(event.wheel);
        dispatch_platform_wheel_event(engine, delta_y,
                                      event.wheel.mouse_x * engine.canvas_window_to_client_scale,
                                      event.wheel.mouse_y * engine.canvas_window_to_client_scale,
                                      dom_mouse_buttons(tracked_mouse_buttons()), include_dom);
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
        sync_pointer_lock(SDL_GetWindowFromID(event.window.windowID), engine);
        return;
    }
    if (const auto hidden = window_visibility(event))
        set_document_hidden(engine, *hidden);
}

inline void append_touch_cancel(Engine& engine, DomEventBatch& batch, DomTouchContact contact) {
    contact.pointer.buttons = 0;
    batch.append(std::move(*dom_touch_input(engine, DomPointerAction::Cancel, contact)));
}

/** What the platform reports beside a pointer packet: the keyboard modifiers and, from the
 * window's position, the screen coordinates. */
inline void set_dom_pointer_context(const Engine& engine, PlatformMouseEvent& pointer,
                                    SDL_WindowID window_id) {
    static_cast<PlatformModifierKeys&>(pointer) = dom_modifiers(SDL_GetModState());
    if (auto* window = SDL_GetWindowFromID(window_id)) {
        int x = 0, y = 0;
        if (SDL_GetWindowPosition(window, &x, &y)) {
            pointer.screen_x = x * engine.canvas_window_to_client_scale + pointer.client_x;
            pointer.screen_y = y * engine.canvas_window_to_client_scale + pointer.client_y;
        }
    }
}

/** Build an owned script input transaction before running native defaults.
 * Retained UI installs hit/focus path providers; canvas-only scenes use the
 * same dispatch contract without pulling in RmlUi. */
inline std::shared_ptr<DomEventBatch> prepare_dom_platform_input(Engine& engine,
                                                                 const SDL_Event& event) {
    observe_text_composition(engine, event);
#if BBLITE_HAS_GAMEPAD
    // Every gamepad event reaches the Window's gamepads, listened to or not.
    if (event.type == SDL_EVENT_GAMEPAD_ADDED || event.type == SDL_EVENT_GAMEPAD_REMOVED ||
        event.type == SDL_EVENT_GAMEPAD_BUTTON_DOWN || event.type == SDL_EVENT_GAMEPAD_AXIS_MOTION)
        return dom_gamepad_input(engine, apply_gamepad_event(event));
#endif
    if (is_touch_event(event))
        static_cast<void>(dom_input(engine));
    if (!engine.dom_input)
        return {};
    const bool resize = event.type == SDL_EVENT_WINDOW_RESIZED ||
                        event.type == SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED ||
                        event.type == SDL_EVENT_WINDOW_DISPLAY_SCALE_CHANGED;
    const auto previous_width = engine.options.width, previous_height = engine.options.height;
    if (resize)
        handle_platform_event(event, engine, false);
    if (is_touch_event(event)) {
        auto& input = *engine.dom_input;
        const auto key = std::pair{event.tfinger.touchID, event.tfinger.fingerID};
        const bool down = event.type == SDL_EVENT_FINGER_DOWN;
        const bool released =
            event.type == SDL_EVENT_FINGER_UP || event.type == SDL_EVENT_FINGER_CANCELED;
        auto found = input.touches.find(key);
        if (down && found == input.touches.end()) {
            double id = dom_first_touch_pointer_id;
            while (std::any_of(input.touches.begin(), input.touches.end(), [id](const auto& item) {
                return item.second.pointer.pointer_id == id;
            }))
                ++id;
            DomTouchContact contact;
            contact.pointer.pointer_type = "touch";
            contact.pointer.pointer_id = id;
            contact.pointer.is_primary = input.touches.empty();
            contact.order = ++input.touch_presses;
            contact.pressed_at = event.tfinger.timestamp;
            // A second contact ends every tap: Chromium taps with one finger.
            contact.tap = contact.pointer.is_primary;
            for (auto& [held, other] : input.touches) {
                (void)held;
                other.tap = false;
            }
            found = input.touches.emplace(key, std::move(contact)).first;
        }
        if (found == input.touches.end())
            return std::make_shared<DomEventBatch>();
        auto& contact = found->second;
        auto& pointer = contact.pointer;
        const auto canvas_span = [&]() -> double {
            if (input.touches.size() != 2)
                return 0;
            const auto& first = input.touches.begin()->second;
            const auto& second = std::next(input.touches.begin())->second;
            if (first.path.empty() || second.path.empty() ||
                first.path.front() != second.path.front() ||
                first.path.front().kind != DomEventTargetKind::Canvas)
                return 0;
            return std::hypot(first.pointer.client_x - second.pointer.client_x,
                              first.pointer.client_y - second.pointer.client_y);
        };
        const double previous_span = canvas_span();
        pointer.button = event.type == SDL_EVENT_FINGER_MOTION ? -1 : 0;
        pointer.buttons = released ? 0 : 1;
        pointer.client_x = event.tfinger.x * engine.canvas_client_width;
        pointer.client_y = event.tfinger.y * engine.canvas_client_height;
        pointer.movement_x = event.tfinger.dx * engine.canvas_client_width;
        pointer.movement_y = event.tfinger.dy * engine.canvas_client_height;
        pointer.pressure = released ? 0 : event.tfinger.pressure;
        set_dom_pointer_context(engine, pointer, event.tfinger.windowID);
        if (down) {
            contact.path = input.hit_path ? input.hit_path(pointer.client_x, pointer.client_y)
                                          : dom_canvas_path();
            contact.start_x = pointer.client_x;
            contact.start_y = pointer.client_y;
        } else if (event.type == SDL_EVENT_FINGER_CANCELED ||
                   std::hypot(pointer.client_x - contact.start_x,
                              pointer.client_y - contact.start_y) > dom_touch_tap_slop ||
                   event.tfinger.timestamp - contact.pressed_at > dom_touch_long_press_ns)
            contact.tap = false;
        if (down && !contact.path.empty() &&
            contact.path.front().kind == DomEventTargetKind::Canvas &&
            std::any_of(input.touches.begin(), input.touches.end(),
                        [](const auto& item) { return item.second.gesture; }))
            contact.gesture = true;
        std::shared_ptr<DomEventBatch> batch;
        const double current_span = canvas_span();
        const auto action = down                                      ? DomPointerAction::Down
                            : event.type == SDL_EVENT_FINGER_UP       ? DomPointerAction::Up
                            : event.type == SDL_EVENT_FINGER_CANCELED ? DomPointerAction::Cancel
                                                                      : DomPointerAction::Move;
        if (down && current_span > 0 && input.event_types.contains("wheel")) {
            batch = std::make_shared<DomEventBatch>();
            for (auto& [id, item] : input.touches) {
                (void)id;
                if (!item.gesture && &item != &contact) {
                    append_touch_cancel(engine, *batch, item);
                }
                item.gesture = true;
            }
        } else if (contact.gesture) {
            batch = std::make_shared<DomEventBatch>();
            if (event.type == SDL_EVENT_FINGER_MOTION && current_span > 0) {
                const auto& first = input.touches.begin()->second.pointer;
                const auto& second = std::next(input.touches.begin())->second.pointer;
                const PlatformMouseEvent wheel{
                    .button = -1,
                    .client_x = (first.client_x + second.client_x) / 2,
                    .client_y = (first.client_y + second.client_y) / 2,
                    .delta_y = touch_wheel_delta_y(previous_span, current_span)};
                batch->add(dom_event(wheel, "wheel", contact.path), true);
            }
        } else {
            batch = dom_touch_input(engine, action, contact);
        }
        // Touch events follow every contact's pointer events, a wheel gesture's contacts too.
        append_dom_touch_event(*batch, input, action,
                               [&](const DomTouchContact& each) { return &each == &contact; });
        if (action == DomPointerAction::Up)
            append_dom_touch_tap(engine, *batch, contact);
        if (released) {
            // dom_touch_input releases the pointer of a contact outside a wheel gesture.
            if (contact.gesture)
                batch->released_pointers.push_back(pointer.pointer_id);
            input.touches.erase(found);
        }
        return batch;
    }
    auto& input = *engine.dom_input;
    auto batch = std::make_shared<DomEventBatch>();
    if (event.type == SDL_EVENT_KEY_DOWN || event.type == SDL_EVENT_KEY_UP) {
        const auto code = keyboard_event_code(event.key.scancode);
        const auto key =
            platform_keyboard_event(engine, code, event.key.repeat, dom_modifiers(event.key.mod));
        auto path = input.focus_path ? input.focus_path() : dom_canvas_path();
        batch->add(
            dom_event(key, event.type == SDL_EVENT_KEY_DOWN ? "keydown" : "keyup", std::move(path)),
            true);
    } else if (event.type == SDL_EVENT_MOUSE_MOTION || event.type == SDL_EVENT_MOUSE_BUTTON_DOWN ||
               event.type == SDL_EVENT_MOUSE_BUTTON_UP || event.type == SDL_EVENT_MOUSE_WHEEL) {
        const bool move = event.type == SDL_EVENT_MOUSE_MOTION,
                   wheel = event.type == SDL_EVENT_MOUSE_WHEEL;
        if (!move && !wheel)
            update_tracked_mouse_button(event.button);
        PlatformMouseEvent pointer{
            .button = move || wheel ? -1.0 : static_cast<double>(event.button.button - 1),
            .buttons = dom_mouse_buttons(tracked_mouse_buttons()),
            .client_x = (move    ? event.motion.x
                         : wheel ? event.wheel.mouse_x
                                 : event.button.x) *
                        engine.canvas_window_to_client_scale,
            .client_y = (move    ? event.motion.y
                         : wheel ? event.wheel.mouse_y
                                 : event.button.y) *
                        engine.canvas_window_to_client_scale,
            .movement_x = move ? static_cast<double>(event.motion.xrel) : 0,
            .movement_y = move ? static_cast<double>(event.motion.yrel) : 0,
            .delta_y = wheel ? dom_wheel_delta_y(event.wheel) : 0,
            .pressure = tracked_mouse_buttons() == 0 ? 0.0 : 0.5,
        };
        if (move && engine.pointer_lock_canvas)
            trace_pointer_motion(engine, event.motion, pointer);
        set_dom_pointer_context(engine, pointer,
                                move    ? event.motion.windowID
                                : wheel ? event.wheel.windowID
                                        : event.button.windowID);
        auto path =
            input.hit_path ? input.hit_path(pointer.client_x, pointer.client_y)
            : canvas_contains_client_point(engine, pointer)
                ? dom_canvas_path()
                : std::vector<DomEventTarget>{DomEventTarget::document(), DomEventTarget::window()};
        batch =
            dom_pointer_input(engine,
                              move                                        ? DomPointerAction::Move
                              : wheel                                     ? DomPointerAction::Wheel
                              : event.type == SDL_EVENT_MOUSE_BUTTON_DOWN ? DomPointerAction::Down
                                                                          : DomPointerAction::Up,
                              pointer, path);
        if (event.type == SDL_EVENT_MOUSE_BUTTON_UP && event.button.button == SDL_BUTTON_LEFT &&
            event.button.clicks == 2)
            batch->add(dom_event(pointer, "dblclick", path), true);
        if (event.type == SDL_EVENT_MOUSE_BUTTON_UP && event.button.button == SDL_BUTTON_RIGHT)
            batch->add(dom_event(pointer, "contextmenu", path), true);
    } else if (event.type == SDL_EVENT_WINDOW_MOUSE_LEAVE) {
        batch = dom_pointer_input(engine, DomPointerAction::Leave, PlatformMouseEvent{}, {});
    } else if (event.type == SDL_EVENT_WINDOW_FOCUS_LOST ||
               event.type == SDL_EVENT_WINDOW_FOCUS_GAINED) {
        if (event.type == SDL_EVENT_WINDOW_FOCUS_LOST) {
            batch = dom_pointer_input(engine, DomPointerAction::Cancel, PlatformMouseEvent{},
                                      input.hover_path);
            input.hover_path.clear();
            for (auto& [key, contact] : input.touches) {
                (void)key;
                if (contact.gesture)
                    batch->released_pointers.push_back(contact.pointer.pointer_id);
                else
                    append_touch_cancel(engine, *batch, contact);
            }
            append_dom_touch_event(*batch, input, DomPointerAction::Cancel,
                                   [](const DomTouchContact&) { return true; });
            input.touches.clear();
        }
        batch->add(dom_event(PlatformMouseEvent{},
                             event.type == SDL_EVENT_WINDOW_FOCUS_LOST ? "blur" : "focus",
                             {DomEventTarget::window()}, false, false));
    } else if (resize && (input.pending_resize || event.type == SDL_EVENT_WINDOW_RESIZED ||
                          engine.options.width != previous_width ||
                          engine.options.height != previous_height)) {
        input.pending_resize = false;
        batch->add(
            dom_event(PlatformMouseEvent{}, "resize", {DomEventTarget::window()}, false, false));
    } else if (event.type == SDL_EVENT_DROP_BEGIN || event.type == SDL_EVENT_DROP_POSITION ||
               event.type == SDL_EVENT_DROP_FILE || event.type == SDL_EVENT_DROP_COMPLETE) {
        return dom_drag_input(engine, event);
    } else
        return {};
    sync_dom_mouse_capture(input);
    return batch;
}

/** Legacy engine hooks (including glTF interactivity) receive the primary
 * contact's canvas pointer events; their click fires only for a tap's click.
 * Secondary/UI contacts stay separate. */
inline void dispatch_touch_defaults(Engine& engine, const DomEventBatch& batch) {
    const bool tapped =
        !batch.tap_withheld &&
        std::any_of(batch.events.begin(), batch.events.end(), [](const auto& entry) {
            const auto* pointer = std::get_if<PlatformMouseEvent>(&entry.payload);
            return pointer && pointer->dom && pointer->dom->type == "click" &&
                   pointer->dom->target == DomEventTarget::canvas();
        });
    for (const auto& entry : batch.events) {
        const auto* pointer = std::get_if<PlatformMouseEvent>(&entry.payload);
        if (!pointer || !pointer->dom || pointer->dom->target != DomEventTarget::canvas())
            continue;
        const auto& type = pointer->dom->type;
        if (pointer->is_primary && type == "pointercancel") {
            engine.canvas_click_armed = false;
            engine.mouse_cancel_callbacks.dispatch(*pointer);
        }
        if (pointer->is_primary && type == "pointerup" && (!tapped || batch.default_prevented))
            engine.canvas_click_armed = false;
        if (batch.default_prevented)
            continue;
        if (pointer->is_primary && (type == "pointerdown" || type == "pointerup"))
            dispatch_platform_mouse_button(engine, *pointer, type == "pointerdown", false);
        else if (pointer->is_primary && type == "pointermove")
            dispatch_platform_mouse_move(engine, *pointer, false);
        else if (type == "wheel")
            dispatch_platform_wheel_event(engine, pointer->delta_y, pointer->client_x,
                                          pointer->client_y, 0, false);
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
inline void poll_platform_events(Engine& engine, bool& running, bool test_pass,
                                 UiEventFilter&& ui_filter, DispatchedHook&& dispatched) {
    if (auto* offscreen = OffscreenRun::current()) {
        running = running && !offscreen->closed();
        sync_engine_canvas_size(nullptr, engine);
        return;
    }
    SDL_Event event;
    while (poll_sdl_event(&event)) {
        if (is_emulated_pointer_event(event))
            continue;
        if (event.type == SDL_EVENT_QUIT || event.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED) {
            running = false;
        }
        if (test_pass && is_platform_input_event(event) && !is_replayed_ui_event(event)) {
            continue;
        }
        if (!page_platform_event(engine, event))
            continue;
        end_press_mouse_capture(event);
        const auto batch = prepare_dom_platform_input(engine, event);
        if (batch) {
            dispatch_dom_batch(engine, batch);
            if (!batch->ready())
                throw std::logic_error("Synchronous frame input cannot defer its callbacks.");
            // Listener side effects apply even when a later contextmenu listener
            // prevents defaults or retained UI consumes the native packet.
            sync_pointer_lock(SDL_GetWindowFromEvent(&event), engine);
            if (is_touch_event(event))
                dispatch_touch_defaults(engine, *batch);
            if (batch->default_prevented) {
                if (event.type == SDL_EVENT_MOUSE_BUTTON_UP)
                    engine.canvas_click_armed = false;
                end_withheld_ui_press(engine, event);
                continue;
            }
        }
        if (event.type == SDL_EVENT_KEY_DOWN || event.type == SDL_EVENT_KEY_UP) {
            // Window listeners receive keyboard events bubbling from focused
            // controls too. Run them before RmlUi's default actions so a
            // source preventDefault suppresses scrolling/activation, not the
            // application listener itself. Camera controls still yield to UI.
            const auto code = keyboard_event_code(event.key.scancode);
            const bool prevented =
                !code.empty() && dispatch_platform_keyboard_event(
                                     engine, code, event.type == SDL_EVENT_KEY_DOWN,
                                     event.key.repeat, dom_modifiers(event.key.mod), false);
            release_pointer_lock_on_escape(SDL_GetWindowFromID(event.key.windowID), engine, code,
                                           event.type == SDL_EVENT_KEY_DOWN);
            if (!prevented && ui_filter(event))
                dispatched(event);
            continue;
        }
        if (!ui_filter(event))
            continue;
        handle_platform_event(event, engine, false);
        dispatched(event);
        if (event.type == SDL_EVENT_MOUSE_MOTION || event.type == SDL_EVENT_MOUSE_BUTTON_DOWN ||
            event.type == SDL_EVENT_MOUSE_BUTTON_UP || event.type == SDL_EVENT_MOUSE_WHEEL) {
            apply_canvas_cursor(engine);
        }
    }
    if (engine.dom_input && engine.dom_input->pending_resize) {
        engine.dom_input->pending_resize = false;
        auto batch = std::make_shared<DomEventBatch>();
        batch->add(
            dom_event(PlatformMouseEvent{}, "resize", {DomEventTarget::window()}, false, false));
        dispatch_dom_batch(engine, batch);
    }
}

template <typename UiEventFilter>
inline void poll_platform_events(Engine& engine, bool& running, bool test_pass,
                                 UiEventFilter&& ui_filter) {
    poll_platform_events(engine, running, test_pass, std::forward<UiEventFilter>(ui_filter),
                         [](const SDL_Event&) {});
}

inline void poll_platform_events(Engine& engine, bool& running, bool test_pass) {
    poll_platform_events(engine, running, test_pass, [](const SDL_Event&) { return true; });
}

} // namespace bbl::pal

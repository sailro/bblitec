#define BBLITE_HAS_GAMEPAD 1
#include "pal_sdl.cpp"
namespace bbl::pal { void apply_canvas_cursor(Engine&); }
#include "pal_platform_events.hpp"
#include <cassert>
#include <iostream>

namespace bbl::pal {
std::string environment_variable(const char*) { return {}; }
int canvas_cursor_updates = 0;
void apply_canvas_cursor(Engine&) { ++canvas_cursor_updates; }
}

int main() {
    SDL_SetHint(SDL_HINT_JOYSTICK_ALLOW_BACKGROUND_EVENTS, "1");
    assert(SDL_Init(SDL_INIT_EVENTS | SDL_INIT_GAMEPAD));
    bbl::Engine engine;
    SDL_VirtualJoystickDesc desc{};
    SDL_INIT_INTERFACE(&desc);
    desc.type = SDL_JOYSTICK_TYPE_GAMEPAD;
    desc.naxes = SDL_GAMEPAD_AXIS_COUNT;
    desc.nbuttons = SDL_GAMEPAD_BUTTON_COUNT;
    desc.axis_mask = (1u << SDL_GAMEPAD_AXIS_COUNT) - 1u;
    desc.button_mask = (1u << SDL_GAMEPAD_BUTTON_COUNT) - 1u;
    desc.name = "bblite virtual controller regression";
    const auto find_pad = [](const auto& pads, SDL_JoystickID instance_id) {
        bbl::GamepadHandle found;
        for (const auto& pad : pads) {
            if (pad && pad->instance_id == instance_id) found = *pad;
        }
        return found;
    };
    const auto id = SDL_AttachVirtualJoystick(&desc);
    assert(id);
    auto* joystick = SDL_OpenJoystick(id);
    assert(joystick);
    const auto pads = bbl::platform_gamepads(engine);
    const bbl::GamepadHandle handle = find_pad(pads, id);
    assert(handle.instance_id == id);
    const auto buttons = bbl::gamepad_buttons(engine, handle);
    assert(bbl::gamepad_buttons(engine, handle) == buttons);
    for (const auto mapping : {std::pair{SDL_GAMEPAD_BUTTON_SOUTH, 0u},
                              std::pair{SDL_GAMEPAD_BUTTON_DPAD_DOWN, 13u},
                              std::pair{SDL_GAMEPAD_BUTTON_START, 9u}}) {
        assert(SDL_SetJoystickVirtualButton(joystick, mapping.first, true));
        SDL_UpdateJoysticks();
        assert(bbl::gamepad_button_pressed(engine, buttons[mapping.second]));
        assert(SDL_SetJoystickVirtualButton(joystick, mapping.first, false));
        SDL_UpdateJoysticks();
        assert(!bbl::gamepad_button_pressed(engine, buttons[mapping.second]));
    }
    assert(SDL_SetJoystickVirtualAxis(joystick, SDL_GAMEPAD_AXIS_RIGHTX, -32768));
    assert(SDL_SetJoystickVirtualAxis(joystick, SDL_GAMEPAD_AXIS_RIGHT_TRIGGER, 32767));
    SDL_UpdateJoysticks();
    const auto axes = bbl::gamepad_axes(engine, handle);
    assert(axes[2] == -1.0);
    assert(bbl::gamepad_axes(engine, handle) == axes);
    assert(bbl::gamepad_button_pressed(engine, buttons[7]));
    assert(SDL_SetJoystickVirtualAxis(joystick, SDL_GAMEPAD_AXIS_RIGHTX, 16384));
    SDL_UpdateJoysticks();
    const auto changed_axes = bbl::gamepad_axes(engine, handle);
    assert(!(changed_axes == axes));
    assert(changed_axes[2] > 0.5 && changed_axes[2] < 0.501);
    assert(axes[2] == -1.0);
    assert(bbl::gamepad_axes(engine, handle) == changed_axes);

    const auto second_id = SDL_AttachVirtualJoystick(&desc);
    assert(second_id);
    const auto two_pads = bbl::platform_gamepads(engine);
    const bbl::GamepadHandle first_with_second = find_pad(two_pads, id);
    const bbl::GamepadHandle second = find_pad(two_pads, second_id);
    assert(first_with_second.index == handle.index);
    assert(second.instance_id == second_id && second.index != handle.index);

    SDL_CloseJoystick(joystick);
    assert(SDL_DetachVirtualJoystick(id));
    const auto after_disconnect = bbl::platform_gamepads(engine);
    assert(after_disconnect.size() > second.index);
    assert(!after_disconnect[handle.index]);
    assert(after_disconnect[second.index]);
    assert(after_disconnect[second.index]->instance_id == second_id);
    assert(!bbl::gamepad_button_pressed(engine, buttons[0]));

    const auto replacement_id = SDL_AttachVirtualJoystick(&desc);
    assert(replacement_id);
    const auto replaced_hole = bbl::platform_gamepads(engine);
    const bbl::GamepadHandle replacement = find_pad(replaced_hole, replacement_id);
    const bbl::GamepadHandle stable_second = find_pad(replaced_hole, second_id);
    assert(replacement.index == handle.index);
    assert(stable_second.index == second.index);
    assert(SDL_DetachVirtualJoystick(second_id));
    assert(SDL_DetachVirtualJoystick(replacement_id));

    int downs = 0, ups = 0, ui = 0, camera = 0;
    engine.key_down_callbacks.add(1, [&](const bbl::PlatformKeyboardEvent& event) {
        ++downs;
        event.prevent_default();
    });
    engine.key_up_callbacks.add(1, [&](const bbl::PlatformKeyboardEvent&) { ++ups; });
    SDL_Event event{};
    event.type = SDL_EVENT_KEY_DOWN;
    event.key.scancode = SDL_SCANCODE_DOWN;
    assert(SDL_PushEvent(&event));
    event.type = SDL_EVENT_KEY_UP;
    assert(SDL_PushEvent(&event));
    bool running = true;
    bbl::pal::poll_platform_events(engine, running, false,
        [&](const SDL_Event& value) { if (value.type == SDL_EVENT_KEY_DOWN || value.type == SDL_EVENT_KEY_UP) ++ui; return false; },
        [&](const SDL_Event&) { ++camera; });
    assert(downs == 1 && ups == 1 && ui == 1 && camera == 0);
    assert(bbl::pal::canvas_cursor_updates == 0);
    // A scene move followed by a UI move in one drain must leave the UI
    // cursor selected. Keyboard/window/controller traffic cannot replace it.
    event = {};
    event.type = SDL_EVENT_MOUSE_MOTION;
    assert(SDL_PushEvent(&event));
    event.motion.x = 100;
    assert(SDL_PushEvent(&event));
    event.type = SDL_EVENT_WINDOW_EXPOSED;
    assert(SDL_PushEvent(&event));
    bbl::pal::poll_platform_events(engine, running, false, [&](const SDL_Event& value) {
        if (value.type == SDL_EVENT_MOUSE_MOTION && value.motion.x == 100) {
            assert(bbl::pal::canvas_cursor_updates == 1);
            return false;
        }
        return true;
    });
    assert(bbl::pal::canvas_cursor_updates == 1);
    SDL_Quit();
    std::cout << "gamepad-check: ok\n";
}

#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("UI focus fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto panel = ui_create_element(engine, "div");
        ui_set_attribute(engine, panel, "style", "position:absolute;left:20px;top:20px;");
        const auto label = ui_create_element(engine, "label");
        const auto input = ui_create_element(engine, "input");
        ui_set_attribute(engine, input, "type", "range");
        ui_set_attribute(engine, input, "min", "0");
        ui_set_attribute(engine, input, "max", "4");
        ui_set_attribute(engine, input, "step", "0.05");
        ui_set_form_value(engine, input, "1");
        ui_set_attribute(engine, input, "style", "width:240px;height:20px;margin:0;");
        ui_append_child(engine, label, input);
        ui_append_child(engine, panel, label);
        const auto button = ui_create_element(engine, "button");
        ui_set_text(engine, button, "Pause");
        ui_append_child(engine, panel, button);
        ui_append_to_root(engine, panel);
        int input_focuses = 0, ancestor_focuses = 0, changes = 0, clicks = 0;
        ui_on_event(engine, input, "focus", [&](const PlatformMouseEvent&) { ++input_focuses; });
        for (const auto ancestor : {panel, label})
            ui_on_event(engine, ancestor, "focus",
                        [&](const PlatformMouseEvent&) { ++ancestor_focuses; });
        ui_on_event(engine, input, "input", [&](const PlatformMouseEvent&) { ++changes; });
        on_dom_pointer(engine, DomEventTarget::document(), "click", 1,
                       [&](const PlatformMouseEvent&) { ++clicks; });
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto send = [&](SDL_Event event) {
            static_cast<void>(pal::handle_ui_rml_event(runtime, event));
            pal::update_ui_rml_runtime(runtime, 640, 480);
        };
        SDL_Event motion{};
        motion.type = SDL_EVENT_MOUSE_MOTION;
        motion.motion.x = 100;
        motion.motion.y = 30;
        send(motion);
        SDL_Event press{};
        press.type = SDL_EVENT_MOUSE_BUTTON_DOWN;
        press.button.button = SDL_BUTTON_LEFT;
        press.button.x = 100;
        press.button.y = 30;
        send(press);
        press.type = SDL_EVENT_MOUSE_BUTTON_UP;
        send(press);
        assert(ui_active_element(engine) == input);
        assert(input_focuses == 1 && ancestor_focuses == 0 && clicks == 0);
        const auto key = [&](SDL_Keycode code) {
            SDL_Event event{};
            event.type = SDL_EVENT_KEY_DOWN;
            event.key.which = ~0u;
            event.key.key = code;
            send(event);
            event.type = SDL_EVENT_KEY_UP;
            send(event);
        };
        key(SDLK_HOME);
        assert(std::stod(ui_get_form_value(engine, input)) == 0);
        key(SDLK_END);
        assert(std::stod(ui_get_form_value(engine, input)) == 4);
        key(SDLK_HOME);
        for (int index = 0; index < 20; ++index)
            key(SDLK_RIGHT);
        assert(std::abs(std::stod(ui_get_form_value(engine, input)) - 1) < 0.000001);
        assert(changes >= 21 && ui_active_element(engine) == input);
        // A source focus request still takes precedence during projection.
        ui_focus(engine, button);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(runtime.context->GetFocusElement() ==
               runtime.projected_elements.at(button.value).element);
        assert(ui_active_element(engine) == button && ancestor_focuses == 0);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}

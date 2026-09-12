#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected fixture asset read"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
}

int main() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("UI disabled fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto button = ui_create_element(engine, "button");
        ui_set_attribute(engine, button, "style", "position:absolute;left:20px;top:20px;width:100px;height:40px;");
        int calls = 0;
        ui_on_click(engine, button, [&] { ++calls; });
        ui_set_boolean_attribute(engine, button, "disabled", true);
        ui_append_to_root(engine, button);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        auto* raw = runtime.projected_elements.at(button.value).element;
        auto* control = rmlui_dynamic_cast<Rml::ElementFormControl*>(raw);
        assert(control && control->IsDisabled());
        assert(control->IsPseudoClassSet("disabled"));
        ui_focus(engine, button);
        assert(ui_active_element(engine).value == invalid_handle);
        ui_click(engine, button);
        assert(calls == 0);
        const auto click = [&] {
            runtime.context->ProcessMouseMove(40, 40, 0);
            runtime.context->ProcessMouseButtonDown(0, 0);
            runtime.context->ProcessMouseButtonUp(0, 0);
        };
        click();
        assert(calls == 0);
        ui_set_boolean_attribute(engine, button, "disabled", false);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(!control->IsDisabled() && runtime.projected_elements.at(button.value).element == raw);
        assert(!control->IsPseudoClassSet("disabled"));
        ui_focus(engine, button);
        assert(ui_active_element(engine).value == button.value);
        click();
        assert(calls == 1);
        ui_click(engine, button);
        assert(calls == 2);
        ui_set_attribute(engine, button, "disabled", "false");
        assert(ui_active_element(engine).value == invalid_handle);
        ui_click(engine, button);
        assert(calls == 2);
        for (const char* tag : {"input", "textarea"}) {
            const auto field = ui_create_element(engine, tag);
            ui_append_to_root(engine, field);
            ui_set_boolean_attribute(engine, field, "disabled", true);
            pal::update_ui_rml_runtime(runtime, 640, 480);
            auto* field_control = rmlui_dynamic_cast<Rml::ElementFormControl*>(runtime.projected_elements.at(field.value).element);
            assert(field_control && field_control->IsDisabled());
            ui_set_boolean_attribute(engine, field, "disabled", false);
            pal::update_ui_rml_runtime(runtime, 640, 480);
            assert(!field_control->IsDisabled());
        }
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}

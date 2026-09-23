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
    SDL_Window* window = SDL_CreateWindow("UI Ocean controls fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        int clicks = 0;
        on_dom_pointer(engine, DomEventTarget::document(), "click", 1,
                       [&](const PlatformMouseEvent&) { ++clicks; });
        const auto details = ui_create_element(engine, "details");
        ui_set_boolean_attribute(engine, details, "open", true);
        ui_set_attribute(engine, details, "style",
                         "position:absolute;left:20px;top:20px;width:240px;");
        const auto summary = ui_create_element(engine, "summary");
        ui_set_text(engine, summary, "Settings");
        ui_set_attribute(engine, summary, "style", "height:24px;");
        ui_append_child(engine, details, summary);
        const auto select = ui_create_element(engine, "select");
        ui_set_attribute(engine, select, "style", "width:120px;height:24px;");
        std::vector<UiElementHandle> options;
        for (const char* value : {"256", "128", "64"}) {
            const auto option = ui_create_element(engine, "option");
            ui_set_form_value(engine, option, value);
            ui_set_text(engine, option, value);
            ui_set_selected(engine, option, std::string_view(value) == "128");
            ui_append_child(engine, select, option);
            options.push_back(option);
        }
        assert(ui_get_form_value(engine, select) == "128");
        assert(!ui_get_selected(engine, options[0]) && ui_get_selected(engine, options[1]));
        assert(!ui_has_attribute(engine, options[1], "selected"));
        ui_append_child(engine, details, select);
        const auto output = ui_create_element(engine, "output");
        ui_set_form_value(engine, output, "128");
        ui_append_child(engine, details, output);
        std::string events;
        ui_on_event(engine, select, "input", [&](const PlatformMouseEvent&) {
            events += "input:" + ui_get_form_value(engine, select) + ";";
        });
        ui_on_event(engine, select, "change", [&](const PlatformMouseEvent&) {
            events += "change:" + ui_get_form_value(engine, select) + ";";
            ui_set_form_value(engine, output, ui_get_form_value(engine, select));
        });
        ui_append_to_root(engine, details);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        auto* raw_select = rmlui_dynamic_cast<Rml::ElementFormControlSelect*>(
            runtime.projected_elements.at(select.value).element);
        assert(raw_select && raw_select->GetValue() == "128" && events.empty());
        assert(raw_select->GetDisplay() != Rml::Style::Display::None);
        runtime.context->ProcessMouseMove(40, 30, 0);
        runtime.context->ProcessMouseButtonDown(0, 0);
        runtime.context->ProcessMouseButtonUp(0, 0);
        assert(clicks == 1 && !ui_has_attribute(engine, details, "open"));
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(raw_select->GetDisplay() == Rml::Style::Display::None);
        runtime.context->ProcessMouseButtonDown(0, 0);
        runtime.context->ProcessMouseButtonUp(0, 0);
        assert(clicks == 2);
        assert(ui_has_attribute(engine, details, "open"));
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(raw_select->GetDisplay() != Rml::Style::Display::None);
        assert(raw_select->Focus());
        runtime.context->ProcessKeyDown(Rml::Input::KI_RETURN, 0);
        runtime.context->ProcessKeyUp(Rml::Input::KI_RETURN, 0);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(raw_select->IsSelectBoxVisible());
        runtime.context->ProcessKeyDown(Rml::Input::KI_DOWN, 0);
        runtime.context->ProcessKeyUp(Rml::Input::KI_DOWN, 0);
        if (events != "input:64;change:64;")
            std::fprintf(stderr, "Dropdown events: %s; value: %s; selected: %d\n", events.c_str(),
                         raw_select->GetValue().c_str(), raw_select->GetSelection());
        assert(events == "input:64;change:64;");
        assert(ui_get_form_value(engine, output) == "64");
        assert(ui_get_selected(engine, options[2]));
        ui_set_selected(engine, options[0], true);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(raw_select->GetValue() == "256");
        assert(events == "input:64;change:64;");
        for (std::size_t index = 0; index < options.size(); ++index) {
            assert(raw_select->GetOption(static_cast<int>(index)) ==
                   runtime.projected_elements.at(options[index].value).element);
            assert(ui_element(engine, options[index]).parent == select);
        }
        ui_set_form_value(engine, select, "missing");
        assert(ui_get_form_value(engine, select).empty());
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(raw_select->GetValue().empty() && events == "input:64;change:64;");
        ui_set_selected(engine, options[1], true);
        ui_remove(engine, options[1]);
        assert(ui_get_form_value(engine, select) == "256");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(raw_select->GetNumOptions() == 2 && raw_select->GetValue() == "256");
        ui_click(engine, summary);
        assert(!ui_has_attribute(engine, details, "open"));
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(raw_select->GetDisplay() == Rml::Style::Display::None);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}

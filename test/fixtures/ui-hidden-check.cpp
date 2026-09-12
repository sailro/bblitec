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
    SDL_Window* window = SDL_CreateWindow("UI hidden fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto panel = ui_create_element(engine, "div");
        ui_set_attribute(engine, panel, "style", "width:100px;height:40px;");
        ui_set_boolean_attribute(engine, panel, "hidden", true);
        ui_append_to_root(engine, panel);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        auto* raw = runtime.projected_elements.at(panel.value).element;
        const auto display = [&](Rml::Style::Display expected) {
            pal::update_ui_rml_runtime(runtime, 640, 480);
            assert(runtime.projected_elements.at(panel.value).element == raw);
            assert(raw->GetComputedValues().display() == expected);
        };
        display(Rml::Style::Display::None);
        assert(ui_has_attribute(engine, panel, "hidden"));
        ui_set_boolean_attribute(engine, panel, "hidden", false);
        display(Rml::Style::Display::Block);
        assert(!ui_has_attribute(engine, panel, "hidden"));
        assert(raw->GetBox().GetSize().y == 40.f);
        // Any attribute value other than until-found still means hidden.
        ui_set_attribute(engine, panel, "hidden", "false");
        display(Rml::Style::Display::None);
        ui_set_style_property(engine, panel, "display", "flex");
        display(Rml::Style::Display::Flex);
        assert(ui_has_attribute(engine, panel, "hidden"));
        ui_set_boolean_attribute(engine, panel, "hidden", false);
        display(Rml::Style::Display::Flex);
        ui_set_boolean_attribute(engine, panel, "hidden", true);
        ui_set_style_property(engine, panel, "display", "");
        display(Rml::Style::Display::None);
        bool refused = false;
        try { ui_set_attribute(engine, panel, "hidden", "UnTiL-FoUnD"); }
        catch (const std::runtime_error&) { refused = true; }
        assert(refused && ui_get_attribute(engine, panel, "hidden").empty());
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}

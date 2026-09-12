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
    SDL_Window* window = SDL_CreateWindow("UI child selector fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto sheet = ui_create_element(engine, "style");
        const auto rule = [&](const char* tag, const char* style) {
            ui_add_style_rule(engine, sheet, UiStyleSelectorKind::TagChildClass, "entry", "", tag, false, -1, style);
        };
        rule("div", "background-color:#ff0000;");
        rule("span", "background-color:#00ff00;");
        rule("body", "background-color:#0000ff;");
        rule("html", "background-color:#ffff00;");
        ui_add_style_rule(engine, sheet, UiStyleSelectorKind::TagChildClass, "entry", "active", "span", false, -1, "background-color:#00ffff;");
        // Later source order cannot overcome a parent tag's specificity.
        ui_add_class_style(engine, sheet, "entry", "background-color:#111111;");
        ui_add_class_style(engine, sheet, "other", "background-color:#222222;");
        ui_append_to_root(engine, sheet);
        const auto parent = ui_create_element(engine, "div");
        const auto middle = ui_create_element(engine, "p");
        const auto alternate = ui_create_element(engine, "span");
        const auto create = [&] {
            const auto element = ui_create_element(engine, "button");
            ui_set_attribute(engine, element, "class", "entry");
            ui_set_attribute(engine, element, "style", "width:40px;height:30px;");
            return element;
        };
        const auto direct = create(), nested = create(), root = create();
        ui_append_child(engine, parent, direct);
        ui_append_child(engine, parent, middle);
        ui_append_child(engine, middle, nested);
        ui_append_to_root(engine, parent);
        ui_append_to_root(engine, alternate);
        ui_append_to_root(engine, root);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        auto* original = runtime.projected_elements.at(direct.value).element;
        const auto color = [&](UiElementHandle handle, std::uint8_t red, std::uint8_t green, std::uint8_t blue) {
            pal::update_ui_rml_runtime(runtime, 640, 480);
            auto* element = runtime.projected_elements.at(handle.value).element;
            const auto actual = element->GetProperty(Rml::PropertyId::BackgroundColor)->Get<Rml::Colourb>();
            if (actual.red != red || actual.green != green || actual.blue != blue || actual.alpha != 255)
                std::fprintf(stderr, "Element %u expected %u,%u,%u; actual %u,%u,%u,%u; parent %s\n", handle.value,
                    red, green, blue, actual.red, actual.green, actual.blue, actual.alpha, element->GetParentNode()->GetTagName().c_str());
            assert(actual.red == red && actual.green == green && actual.blue == blue && actual.alpha == 255);
        };
        color(direct, 255, 0, 0);
        color(nested, 17, 17, 17);
        color(root, 0, 0, 255);
        const auto& div_rule = engine.ui_elements.at(sheet.value).style_rules.front();
        assert(pal::ui_style_rule_matches(engine, direct, div_rule));
        assert(!pal::ui_style_rule_matches(engine, nested, div_rule));
        ui_remove(engine, direct);
        ui_append_to_root(engine, direct);
        color(direct, 0, 0, 255);
        assert(!pal::ui_style_rule_matches(engine, direct, div_rule));
        ui_remove(engine, direct);
        ui_append_child(engine, alternate, direct);
        color(direct, 0, 255, 0);
        ui_set_attribute(engine, direct, "class", "other");
        color(direct, 34, 34, 34);
        ui_set_attribute(engine, direct, "class", "entry");
        color(direct, 0, 255, 0);
        ui_set_attribute(engine, direct, "class", "entry active");
        color(direct, 0, 255, 255);
        ui_remove(engine, direct);
        ui_remove(engine, alternate);
        ui_append_to_root(engine, direct);
        color(direct, 0, 0, 255);
        assert(runtime.projected_elements.at(direct.value).element == original);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}

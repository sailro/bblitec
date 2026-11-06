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
    SDL_Window* window = SDL_CreateWindow("UI line clamp fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto panel = ui_create_element(engine, "div");
        ui_set_attribute(
            engine, panel, "style",
            "display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;"
            "width:120px;font-size:16px;line-height:20px;");
        ui_set_text(engine, panel,
                    "one two three four five six seven eight nine ten eleven twelve");
        ui_append_to_root(engine, panel);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        auto* element = runtime.projected_elements.at(panel.value).element;
        auto* text = dynamic_cast<Rml::ElementText*>(element->GetChild(0));
        assert(text);
        const auto update = [&]() {
            pal::update_ui_rml_runtime(runtime, 640, 480);
            static_cast<void>(pal::record_ui_rml_frame(runtime, 640, 480));
        };
        const auto height = [&]() { return element->GetBox().GetSize(Rml::BoxArea::Content).y; };
        const auto ellipsized = [&](size_t line) {
            const auto& value = text->GetLines().at(line).text;
            const auto ends = [&](std::string_view suffix) {
                return value.size() >= suffix.size() &&
                       value.compare(value.size() - suffix.size(), suffix.size(), suffix) == 0;
            };
            return ends("\xE2\x80\xA6") || ends("...");
        };

        // Two lines show; the second ends in an ellipsis because more follow, and still fits the line.
        update();
        assert(element->GetDisplay() == Rml::Style::Display::FlowRoot);
        const size_t all_lines = text->GetLines().size();
        assert(all_lines > 2);
        assert(std::abs(height() - 40.f) < .1f);
        assert(!ellipsized(0) && ellipsized(1));
        assert(text->GetLines().at(1).width <= 120);

        // A clamp at or past the line count shows every line, with no ellipsis.
        ui_set_style_property(engine, panel, "-webkit-line-clamp", std::to_string(all_lines));
        update();
        assert(std::abs(height() - 20.f * float(all_lines)) < .1f);
        for (size_t line = 0; line < all_lines; ++line)
            assert(!ellipsized(line));

        // Without a clamp the legacy box is a flex container along its orient.
        ui_set_style_property(engine, panel, "-webkit-line-clamp", "none");
        update();
        assert(element->GetDisplay() == Rml::Style::Display::Flex);
        assert(element->GetComputedValues().flex_direction() == Rml::Style::FlexDirection::Column);
        ui_set_style_property(engine, panel, "-webkit-line-clamp", "2");
        ui_set_style_property(engine, panel, "-webkit-box-orient", "horizontal");
        update();
        assert(element->GetDisplay() == Rml::Style::Display::Flex);
        assert(element->GetComputedValues().flex_direction() == Rml::Style::FlexDirection::Row);

        // A fixed height keeps its size; the clamp line still ends in an ellipsis. The inline box is an inline-block.
        ui_set_style_property(engine, panel, "-webkit-box-orient", "vertical");
        ui_set_style_property(engine, panel, "height", "56px");
        ui_set_style_property(engine, panel, "display", "-webkit-inline-box");
        update();
        assert(element->GetDisplay() == Rml::Style::Display::InlineBlock);
        assert(std::abs(height() - 56.f) < .1f);
        assert(ellipsized(1) && !ellipsized(2));

        // flex-direction does not apply to a legacy box, and display:block drops the clamp.
        ui_set_style_property(engine, panel, "flex-direction", "row");
        ui_set_style_property(engine, panel, "-webkit-line-clamp", "none");
        update();
        assert(element->GetDisplay() == Rml::Style::Display::InlineFlex);
        assert(element->GetComputedValues().flex_direction() == Rml::Style::FlexDirection::Column);
        ui_set_style_property(engine, panel, "-webkit-line-clamp", "2");
        ui_set_style_property(engine, panel, "display", "block");
        ui_set_style_property(engine, panel, "height", "auto");
        update();
        assert(text->GetLines().size() == all_lines);
        assert(std::abs(height() - 20.f * float(all_lines)) < .1f);
        assert(!ellipsized(1));

        // A clamp line too wide for its ellipsis sheds characters until both fit.
        ui_set_style_property(engine, panel, "display", "-webkit-box");
        ui_set_text(
            engine, panel,
            "abcdefghijklmnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz");
        update();
        text = dynamic_cast<Rml::ElementText*>(element->GetChild(0));
        assert(text && ellipsized(1));
        assert(text->GetLines().at(1).width <= 120);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}

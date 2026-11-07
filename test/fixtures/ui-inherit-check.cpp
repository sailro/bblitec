#define main generated_main
#include "../../artifacts/ui-inherit/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cmath>
#include <cstdio>

namespace bbl::pal {
double fixture_time = 1000;
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return fixture_time; }
Engine& window_document_engine() {
    static Engine document;
    return document;
}
} // namespace bbl::pal
#include "realm-application-fixture.hpp"

int main() try {
    using namespace bbl;
    const auto check = [](bool pass, const char* message) {
        if (!pass)
            throw std::runtime_error(message);
    };
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    SDL_Window* window = SDL_CreateWindow("UI inherit fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        auto& engine = pal::window_document_engine();
        check(generated_main() == 0, "program");
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto update = [&] { pal::update_ui_rml_runtime(runtime, 640, 480); };
        const auto element = [&](const char* id) {
            return runtime.projected_elements.at(ui_get_element_by_id(engine, id).value).element;
        };
        const auto close_to = [](float value, float expected, const char* what) {
            if (std::abs(value - expected) > 0.01f)
                std::fprintf(stderr, "%s: %g, expected %g\n", what, value, expected);
            return std::abs(value - expected) <= 0.01f;
        };
        const auto panel_color = [](const Rml::Element* target) {
            const auto color = target->GetComputedValues().color();
            return color.red == 229 && color.green == 238 && color.blue == 251;
        };
        const auto radius = [&](const char* id) {
            return element(id)->GetComputedValues().border_top_left_radius().value.x;
        };
        // Animations start on one update and apply their keys once time moves.
        update();
        pal::fixture_time += 100;
        update();
        for (const char* id : {"select", "button"}) {
            const auto& values = element(id)->GetComputedValues();
            check(panel_color(element(id)),
                  "a form control's color: inherit reads its container's");
            check(
                close_to(values.font_size(), 14.f, id) &&
                    close_to(values.line_height().value, 21.f, id),
                "a form control's font: inherit replaces the user-agent control font and line height");
        }
        auto* value = element("select")->GetChild(1);
        check(value->GetTagName() == "selectvalue" && panel_color(value),
              "the select's displayed value inherits the control's color");
        check(close_to(radius("round"), 12.f, "round"),
              "a property that does not inherit takes the parent's value");
        check(close_to(radius("deep"), 12.f, "deep"), "an inherit parent defers to its own parent");
        check(close_to(radius("initial"), 0.f, "initial"),
              "a parent declaring nothing gives the initial value");
        check(close_to(element("pad")->GetComputedValues().padding_top().value, 20.f, "pad"),
              "an inherited em length is the parent's computed length");
        check(panel_color(element("written")), "a CSSOM inherit beats the stylesheet's color");
        check(close_to(radius("keyword-initial"), 0.f, "keyword-initial") &&
                  close_to(radius("keyword-unset"), 0.f, "keyword-unset"),
              "initial and unset on a property that does not inherit replace a lower declaration");
        check(panel_color(element("keyword-unset")),
              "unset on an inherited property inherits over a lower declaration");
        const auto& heading = element("heading")->GetComputedValues();
        check(close_to(heading.margin_top().value, 0.67f * 28.f, "heading margin") &&
                  close_to(heading.padding_left().value, 0.f, "heading padding") &&
                  panel_color(element("heading")),
              "revert takes the user-agent declaration, its em at the element, or none");
        check(close_to(element("written-heading")->GetComputedValues().margin_top().value,
                       0.83f * 21.f, "written heading margin"),
              "a CSSOM revert takes the user-agent declaration");
        const auto& canvas_text = element("canvas-text")->GetComputedValues();
        check(canvas_text.color() == Rml::Colourb(0, 0, 0) &&
                  close_to(canvas_text.font_size(), 16.f, "canvas-text font size") &&
                  canvas_text.line_height().inherit_type == Rml::Style::LineHeight::Normal,
              "initial is CSS's CanvasText, medium and normal");
        const auto& edge = element("edge")->GetComputedValues();
        check(edge.border_top_color() == Rml::Colourb(0, 255, 0) &&
                  edge.border_right_color() == Rml::Colourb(0, 255, 0),
              "an undeclared or initial border colour is currentcolor");
        check(element("tone-initial")->GetComputedValues().color() == Rml::Colourb(0, 0, 255),
              "a custom property's initial is the guaranteed-invalid value");
        check(element("tone-inherit")->GetComputedValues().color() == Rml::Colourb(255, 0, 0),
              "a custom property's inherit takes the parent's value");
        const auto* flex_item = element("flex-item");
        check(flex_item->GetComputedValues().display() == Rml::Style::Display::Flex &&
                  flex_item->GetChild(0)->GetTagName() == "span",
              "text in a box whose display inherits flex is an anonymous flex item");
        const auto* block_item = element("block-item");
        check(block_item->GetComputedValues().display() == Rml::Style::Display::Block &&
                  block_item->GetChild(0)->GetTagName() == "#text",
              "text in a box whose display reverts to block stays inline");
        check(close_to(radius("taken"), 12.f, "taken"),
              "a keyframe's inherit takes the parent's value");
        check(close_to(radius("cleared"), 0.f, "cleared"),
              "a keyframe's initial and unset take the initial value");
        check(close_to(element("keyed")->GetComputedValues().padding_top().value, 20.f, "keyed"),
              "a keyframe's inherited em length is the parent's computed length");
        ui_toggle_class(engine, ui_get_element_by_id(engine, "panel"), "wide", true);
        update();
        check(close_to(radius("round"), 20.f, "round after") &&
                  close_to(radius("deep"), 20.f, "deep after"),
              "inherit follows the parent's change");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "UI inherit failure: %s\n", error.what());
    return 1;
}

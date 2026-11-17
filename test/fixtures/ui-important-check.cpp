#define main generated_main
#include "../../artifacts/ui-important/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cmath>
#include <cstdio>

namespace {
double fixture_time = 1000;
}

namespace bbl::pal {
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
    SDL_Window* window = SDL_CreateWindow("UI important fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        auto& engine = pal::window_document_engine();
        check(generated_main() == 0, "program");
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto at = [&](double milliseconds) {
            fixture_time = milliseconds;
            pal::update_ui_rml_runtime(runtime, 640, 480);
        };
        const auto element = [&](const char* id) {
            return runtime.projected_elements.at(ui_get_element_by_id(engine, id).value).element;
        };
        const auto opacity = [&](const char* id, float expected) {
            const float value = element(id)->GetComputedValues().group_opacity();
            if (std::abs(value - expected) > 0.01f)
                std::fprintf(stderr, "%s opacity %g, expected %g\n", id, value, expected);
            return std::abs(value - expected) <= 0.01f;
        };
        at(1000);
        check(opacity("specific", 0.25f), "an important declaration beats a more specific one");
        check(opacity("cssom", 0.25f), "an important declaration beats a CSSOM write");
        check(opacity("inline", 0.6f), "an important inline declaration beats an important rule");
        check(opacity("order", 0.75f) && !element("order")->IsVisible(),
              "a later normal declaration does not replace an important one");
        check(element("hidden")->GetComputedValues().display() == Rml::Style::Display::None,
              "an important rule hides an element a normal rule displays");
        check(element("kept")->GetComputedValues().display() == Rml::Style::Display::Block,
              "the hiding rule leaves its exception displayed");
        check(element("kept")->GetBox().GetSize().x == 8.f, "the exception keeps its layout");
        const auto displayed = [&](const char* id) {
            return element(id)->GetComputedValues().display() == Rml::Style::Display::Block;
        };
        check(opacity("plain", 0.25f) &&
                  ui_get_style_property(engine, ui_get_element_by_id(engine, "plain"), "opacity")
                      .empty(),
              "a plain write of a value carrying a priority mark is ignored");
        check(displayed("survivor"), "an important CSSOM write beats an important rule");
        check(!displayed("demoted"), "a later normal write drops a declaration's importance");
        ui_set_style_property(engine, ui_get_element_by_id(engine, "survivor"), "display", "block");
        at(1000);
        check(!displayed("survivor"), "a normal write replaces the flagged declaration");
        // An important transition shorthand's delay reset beats a normal inline delay.
        ui_toggle_class(engine, ui_get_element_by_id(engine, "fade"), "on", true);
        at(1000);
        at(1050);
        check(opacity("fade", 0.5f), "important shorthand resets the inline delay");
        // The transition would restore the declaration without its flag.
        bool refused = false;
        try {
            ui_set_important_style_property(engine, ui_get_element_by_id(engine, "fade"), "opacity",
                                            "0.2");
            at(1100);
        } catch (const std::runtime_error&) {
            refused = true;
        }
        check(refused, "an important declaration of a transitioned property refuses");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "UI important failure: %s\n", error.what());
    return 1;
}

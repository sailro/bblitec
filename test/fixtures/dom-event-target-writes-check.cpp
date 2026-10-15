#define main generated_main
#include "../../artifacts/dom-event-target-writes/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cstdio>

namespace {
double fixture_milliseconds = 0;
}

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return fixture_milliseconds; }
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
    SDL_Window* window =
        SDL_CreateWindow("DOM event target writes fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        auto& engine = pal::window_document_engine();
        check(generated_main() == 0, "program");
        const auto origin = ui_get_element_by_id(engine, "origin");
        const auto button = ui_get_element_by_id(engine, "button");
        // The bubbled click wrote through its target; the origin's own click did not.
        check(ui_get_attribute(engine, button, "aria-pressed") == "true",
              "a bubbled click writes through its target");
        check(!ui_has_attribute(engine, origin, "aria-pressed"),
              "the current target is not the bubbled target");
        check(ui_get_attribute(engine, origin, "data-last") == "self",
              "the last click wrote through its current target");

        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto update = [&](double milliseconds) {
            fixture_milliseconds = milliseconds;
            pal::update_ui_rml_runtime(runtime, 640, 480);
        };
        update(0);
        ui_toggle_class(engine, origin, "open", true);
        update(0);
        for (double time = 50; time <= 400; time += 50)
            update(time);
        // Each swatch's transitionend bubbled to the origin, whose listener
        // wrote through the swatch; the origin's own end is skipped by identity.
        for (const char* id : {"a", "b"}) {
            const auto swatch = ui_get_element_by_id(engine, id);
            check(ui_get_style_property(engine, swatch, "transition-delay") == "0ms",
                  "the target's style is written");
            check(ui_has_class(engine, swatch, "settled"), "the target's class is written");
            check(ui_get_attribute(engine, swatch, "data-settled") == "opacity",
                  "the target's dataset is written");
        }
        check(!ui_has_class(engine, origin, "settled"), "the origin's own end is skipped");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "DOM event target writes failure: %s\n", error.what());
    return 1;
}

#define main generated_main
#include "../../artifacts/ui-animation-duration/program.hpp"
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
    SDL_Window* window =
        SDL_CreateWindow("UI animation duration fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        auto& engine = pal::window_document_engine();
        check(generated_main() == 0, "program");
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto at = [&](double milliseconds) {
            fixture_time = milliseconds;
            pal::update_ui_rml_runtime(runtime, 640, 480);
        };
        // RmlUi limits one animation step to 100 ms; advance below it.
        const auto advance = [&](double milliseconds) {
            while (fixture_time < milliseconds)
                at(std::min(fixture_time + 50, milliseconds));
        };
        const auto element = [&](const char* id) {
            return runtime.projected_elements.at(ui_get_element_by_id(engine, id).value).element;
        };
        const auto opacity = [&](const char* id, float expected) {
            const float value = element(id)->GetComputedValues().opacity();
            if (std::abs(value - expected) > 0.02f)
                std::fprintf(stderr, "%s opacity %g, expected %g at %g ms\n", id, value, expected,
                             fixture_time);
            return std::abs(value - expected) <= 0.02f;
        };
        at(1000);
        const auto* reset = element("base")->GetLocalProperty("animation-duration");
        check(reset && reset->value.GetType() == Rml::Variant::TRANSITIONLIST &&
                  reset->value.GetReference<Rml::TransitionList>().none,
              "a sheet shorthand resets its duration longhand to 'auto'");
        advance(1100);
        check(opacity("base", 0.25f), "the shorthand's own duration");
        check(opacity("slow", 0.125f), "a later rule's duration replaces the shorthand's");
        check(opacity("reset", 0.25f), "a shorthand after the longhand resets it");
        check(opacity("calm", 0.25f), "a reduced-motion rule waits for its preference");
        check(opacity("inline", 0.0625f), "an inline duration list replaces the sheet's");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "UI animation duration failure: %s\n", error.what());
    return 1;
}

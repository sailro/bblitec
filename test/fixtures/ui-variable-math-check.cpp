#define main generated_main
#include "../../artifacts/ui-variable-math/program.hpp"
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
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.on_error([](std::exception_ptr error) { std::rethrow_exception(error); });
    loop.run([&] { initialize(realm); });
    return 0;
}
} // namespace bbl::pal

int main() try {
    using namespace bbl;
    const auto check = [](bool pass, const char* message) {
        if (!pass)
            throw std::runtime_error(message);
    };
    check(pal::rml_css_length_math("width:calc(var(--n) * 10px)", 640, 480) ==
              "width:calc(var(--n) * 10px)",
          "projection leaves math over var() for substitution");
    check(pal::rml_css_length_math("calc(2 * 18ms)", 640, 480) == "0.036000s", "time math");
    check(pal::rml_css_length_math("calc(0.25turn + 10deg)", 640, 480) == "100.000000deg",
          "angle math");
    check(pal::rml_css_length_math("calc(50dvh)", 640, 480) == "240.000000px",
          "dynamic viewport units");
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    SDL_Window* window = SDL_CreateWindow("UI variable math fixture", 640, 480, SDL_WINDOW_HIDDEN);
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
        const auto width = [&](const char* id, float expected) {
            const float value = element(id)->GetBox().GetSize().x;
            if (std::abs(value - expected) > 0.5f)
                std::fprintf(stderr, "%s width %g, expected %g\n", id, value, expected);
            return std::abs(value - expected) <= 0.5f;
        };
        const auto opacity = [&](const char* id, float expected) {
            const float value = element(id)->GetComputedValues().opacity();
            if (std::abs(value - expected) > 0.01f)
                std::fprintf(stderr, "%s opacity %g, expected %g at %g ms\n", id, value, expected,
                             fixture_time);
            return std::abs(value - expected) <= 0.01f;
        };
        at(1000);
        check(width("bar", 30), "a length from an inline custom property");
        check(width("viewport", 256),
              "an inherited custom property that is itself math over var()");
        check(opacity("night", 0.7f), "a number");
        const auto background = element("night")->GetComputedValues().color();
        check(background.red == 10 && background.green == 20 && background.blue == 30 &&
                  background.alpha == 77,
              "a colour alpha keeps the CSS range");
        ui_toggle_class(engine, ui_get_element_by_id(engine, "key"), "on", true);
        at(1000);
        at(1030);
        check(opacity("key", 0), "a time delays");
        at(1086);
        check(opacity("key", 0.5f), "the computed delay elapses");
        ui_set_style_property(engine, ui_get_element_by_id(engine, "bar"), "--n", "5");
        at(1100);
        check(width("bar", 50), "a changed custom property recomputes");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "UI variable math failure: %s\n", error.what());
    return 1;
}

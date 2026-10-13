#define main generated_main
#include "../../artifacts/ui-animation-fill/program.hpp"
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
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    SDL_Window* window = SDL_CreateWindow("UI animation fill fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        auto& engine = pal::window_document_engine();
        check(generated_main() == 0, "program");
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto at = [&](double milliseconds) {
            fixture_time = milliseconds;
            pal::update_ui_rml_runtime(runtime, 640, 480);
        };
        const auto advance = [&](double milliseconds) {
            while (fixture_time < milliseconds)
                at(std::min(fixture_time + 10, milliseconds));
        };
        const auto opacity = [&](const char* id, float expected) {
            const float value =
                runtime.projected_elements.at(ui_get_element_by_id(engine, id).value)
                    .element->GetComputedValues()
                    .opacity();
            if (std::abs(value - expected) > 0.02f)
                std::fprintf(stderr, "%s opacity %g, expected %g at %g ms\n", id, value, expected,
                             fixture_time);
            return std::abs(value - expected) <= 0.02f;
        };
        at(1000);
        for (const char* id : {"both", "forwards", "plain", "reverse", "alternate", "leading"})
            ui_toggle_class(engine, ui_get_element_by_id(engine, id), "go", true);
        at(1000);
        advance(1020);
        check(opacity("reverse", 0.8f), "reverse plays the first iteration backwards");
        check(opacity("alternate", 0.8f), "alternate-reverse starts backwards");
        advance(1050);
        check(opacity("both", 0), "backwards fill holds the first frame during the delay");
        check(opacity("forwards", 0.5f) && opacity("leading", 0.5f),
              "a fill keyword before the name");
        advance(1120);
        check(opacity("alternate", 0.2f), "alternate-reverse plays the second iteration forwards");
        advance(1150);
        check(opacity("both", 0.5f), "the delayed animation runs");
        check(opacity("forwards", 1), "forwards fill holds the last frame");
        check(opacity("plain", 0.5f) && opacity("leading", 0.5f), "no forwards fill");
        check(opacity("reverse", 0), "forwards fill after a reversed iteration");
        advance(1300);
        check(opacity("both", 1) && opacity("alternate", 1), "both and forwards fills hold");
        ui_toggle_class(engine, ui_get_element_by_id(engine, "forwards"), "go", false);
        at(1300);
        check(opacity("forwards", 0.5f), "removing the animation ends its fill");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "UI animation fill failure: %s\n", error.what());
    return 1;
}

#define main generated_main
#include "../../artifacts/ui-transition-delays/program.hpp"
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
    SDL_Window* window =
        SDL_CreateWindow("UI transition delays fixture", 640, 480, SDL_WINDOW_HIDDEN);
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
        const auto handle = [&](const char* id) { return ui_get_element_by_id(engine, id); };
        const auto element = [&](const char* id) {
            return runtime.projected_elements.at(handle(id).value).element;
        };
        const auto opacity = [&](const char* id, float expected) {
            const float value = element(id)->GetComputedValues().opacity();
            if (std::abs(value - expected) > 0.02f)
                std::fprintf(stderr, "%s opacity %g, expected %g at %g ms\n", id, value, expected,
                             fixture_time);
            return std::abs(value - expected) <= 0.02f;
        };
        at(1000);
        check(opacity("star", 1) && opacity("pill", 0), "initial styles");
        const auto* reset = element("badge")->GetLocalProperty("transition-delay");
        check(reset && reset->value.GetType() == Rml::Variant::TRANSITIONLIST &&
                  reset->value.GetReference<Rml::TransitionList>().none,
              "a cssText shorthand resets its delay longhand to 'auto'");

        // animation-delay lists: a variable-resolved negative delay starts part-way through,
        // past whole iterations; a positive delay leaves the element's own style until it ends.
        advance(1050);
        check(opacity("mote", 0.375f), "negative animation delay starts part-way");
        check(opacity("late-mote", 0.375f), "negative animation delay skips whole iterations");
        check(opacity("star", 1), "positive animation delay waits");
        advance(1350);
        check(opacity("star", 0.125f), "inline animation-delay starts the animation");

        // transition-delay: an inline list indexes the sheet's items; a longhand after the
        // shorthand in one rule wins, a shorthand after the longhand resets it, and an
        // undeclared longhand keeps the shorthand's own delay.
        ui_toggle_class(engine, handle("pill"), "open", true);
        for (const char* id : {"later", "reset", "own"})
            ui_toggle_class(engine, handle(id), "on", true);
        at(1350);
        advance(1400);
        check(opacity("reset", 0.5f) && opacity("later", 0) && opacity("own", 0),
              "rule order decides between the shorthand and its delay");
        check(opacity("pill", 0), "inline delay holds the first item");
        advance(1450);
        check(opacity("own", 0.5f) && opacity("reset", 1), "shorthand delay");
        advance(1520);
        check(opacity("pill", 0.5f), "first inline delay item");
        check(element("pill")->GetBox().GetSize().x == 10.f, "second inline delay item holds");
        advance(1600);
        check(opacity("later", 0.5f), "longhand after the shorthand");
        advance(1640);
        check(std::abs(element("pill")->GetBox().GetSize().x - 60.f) <= 1.f,
              "second inline delay item replaces the sheet's own delay");

        // An inline shorthand written after the longhand resets it; a longhand written after
        // the shorthand applies again.
        advance(1700);
        ui_set_style_property(engine, handle("pill"), "transition", "opacity 100ms linear");
        at(1700);
        ui_toggle_class(engine, handle("pill"), "open", false);
        at(1700);
        advance(1750);
        check(opacity("pill", 0.5f), "inline shorthand resets the inline delay");
        advance(1800);
        ui_set_style_property(engine, handle("pill"), "transition-delay", "50ms");
        at(1800);
        ui_toggle_class(engine, handle("pill"), "open", true);
        at(1800);
        advance(1840);
        check(opacity("pill", 0), "inline longhand after the shorthand delays");
        advance(1900);
        check(opacity("pill", 0.5f), "inline longhand delay elapses");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "UI transition delays failure: %s\n", error.what());
    return 1;
}

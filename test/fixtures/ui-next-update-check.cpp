#define main generated_main
#include "../../artifacts/ui-next-update/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cmath>
#include <cstdio>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
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
    SDL_Window* window = SDL_CreateWindow("UI next update fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        auto& engine = pal::window_document_engine();
        check(generated_main() == 0, "program");
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        check(!pal::ui_rml_next_update(runtime), "the wall clock reports no next update");
        double now = 0;
        const auto at = [&](double milliseconds) {
            now = milliseconds;
            pal::set_ui_rml_time(runtime, milliseconds);
            pal::update_ui_rml_runtime(runtime, 640, 480);
            const auto next = pal::ui_rml_next_update(runtime);
            if (!next || next->milliseconds != milliseconds)
                throw std::runtime_error("an update at a set time reports its next update");
            return *next;
        };
        const auto advance = [&](double milliseconds) {
            auto next = at(std::min(now + 10, milliseconds));
            while (now < milliseconds)
                next = at(std::min(now + 10, milliseconds));
            return next;
        };
        const auto idle = [](const pal::UiRmlNextUpdate& next) {
            return std::isinf(next.delay) && !next.due(next.milliseconds + 1e9);
        };
        const auto every = [](const pal::UiRmlNextUpdate& next) {
            return next.delay == 0 && next.due(next.milliseconds);
        };
        const auto go = [&](const char* id, bool enabled) {
            ui_toggle_class(engine, ui_get_element_by_id(engine, id), "go", enabled);
        };
        const auto opacity = [&](const char* id) {
            return runtime.projected_elements.at(ui_get_element_by_id(engine, id).value)
                .element->GetComputedValues()
                .opacity();
        };

        ui_set_attribute(engine, ui_get_element_by_id(engine, "title"), "style",
                         "--bbl-text-gradient:#ff0000|#0000ff");
        check(idle(at(1000)) && runtime.gradient_text.size() == 1,
              "a static document, a still text gradient included, has no time-driven work");
        go("plain", true);
        check(every(at(1000)), "a running animation needs every update");
        check(every(advance(1080)), "an animation needs every update until it ends");
        check(idle(advance(1200)), "an ended animation needs no update");
        go("forwards", true);
        check(every(at(1200)), "a forwards-filling animation runs");
        check(idle(advance(1400)) && opacity("forwards") == 1,
              "a completed forwards fill holds its final frame without updates");
        go("hidden", true);
        check(every(at(1400)), "a visibility-hidden animation still needs every update");
        go("hidden", false);
        check(idle(at(1400)), "a removed animation needs no update");
        go("collapsed", true);
        check(every(at(1400)), "an animation under display:none still needs every update");
        go("collapsed", false);
        check(idle(at(1400)), "a removed undisplayed animation needs no update");
        go("fade", true);
        check(every(at(1400)), "a running transition needs every update");
        check(idle(advance(1600)) && opacity("fade") == 1, "an ended transition needs no update");

        // The caret blinks on RmlUi's float timer: each update's next update is
        // due exactly at the update its caret toggles at.
        ui_focus(engine, ui_get_element_by_id(engine, "field"));
        auto next = at(2000);
        check(next.delay > 0 && std::isfinite(next.delay), "a focused caret blinks on a timer");
        int toggles = 0;
        for (double time = 2010; time <= 3600; time += 10) {
            const auto previous = next;
            next = at(time);
            const bool toggled = next.delay > previous.delay;
            if (toggled != previous.due(time)) {
                std::fprintf(stderr, "caret toggled=%d due=%d at %g ms\n", toggled,
                             previous.due(time), time);
                throw std::runtime_error("the caret's next update is due when it toggles");
            }
            toggles += toggled;
        }
        check(toggles == 2, "the caret toggles every 0.7 s");
        ui_blur(engine, ui_get_element_by_id(engine, "field"));
        check(idle(at(3600)), "a blurred caret needs no update");

        ui_set_attribute(engine, ui_get_element_by_id(engine, "banner"), "style",
                         "--bbl-text-gradient:#ff0000|#0000ff;--bbl-text-gradient-duration:2s");
        check(every(at(3600)) && runtime.gradient_text.size() == 2,
              "animated gradient text needs every update");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "UI next update failure: %s\n", error.what());
    return 1;
}

#define main generated_main
#include "../../artifacts/ui-computed-transform/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cmath>
#include <cstdio>

namespace {
double fixture_time = 0;
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
    const auto expect = [&](const std::string& actual, const std::string& wanted,
                            const char* message) {
        if (actual != wanted) {
            std::fprintf(stderr, "%s:\n  '%s'\n  wanted '%s'\n", message, actual.c_str(),
                         wanted.c_str());
            check(false, message);
        }
    };
    // A matrix's translation reaches RmlUi as CSS pixels the density projection writes as dp.
    expect(pal::rml_css_matrix_translations("matrix(1, 0, 0, 1, 9, -27)"),
           "translate(9px, -27px) matrix(1, 0, 0, 1, 0, 0)", "a 2D matrix's translation");
    expect(pal::rml_css_matrix_translations(
               "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,10,+20,30,1) rotate(1deg)"),
           "translate3d(10px, 20px, 30px) matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1) "
           "rotate(1deg)",
           "a 3D matrix's translation");
    expect(pal::rml_css_matrix_translations("matrix(2, 0, 0, 2, 0, -0)"),
           "matrix(2, 0, 0, 2, 0, -0)", "a matrix without a translation stays");
    expect(pal::rml_css_matrix_translations("matrix(1, 0, 0, 1, var(--x), 0)"),
           "matrix(1, 0, 0, 1, var(--x), 0)", "a matrix over var() waits for its substitution");
    expect(pal::rml_css_density_units("matrix(1, 0, 0, 1, 1e+06, 1e-07)"),
           "translate(1e+06dp, 1e-07dp) matrix(1, 0, 0, 1, 0, 0)", "the density projection");
    bool refused = false;
    try {
        static_cast<void>(pal::rml_css_matrix_translations(
            "matrix3d(1, 0, 0, 0.01, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)"));
    } catch (const std::runtime_error&) {
        refused = true;
    }
    check(refused, "a matrix3d() with perspective terms refuses");

    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    SDL_Window* window =
        SDL_CreateWindow("UI computed transform fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        auto& engine = pal::window_document_engine();
        check(generated_main() == 0, "program");
        const auto handle = [&](const char* id) { return ui_get_element_by_id(engine, id); };
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto at = [&](double milliseconds) {
            fixture_time = milliseconds;
            pal::update_ui_rml_runtime(runtime, 640, 480);
        };
        // RmlUi advances motion at most 100ms an update, so time moves in 50ms steps.
        const auto until = [&](double milliseconds) {
            while (fixture_time < milliseconds)
                at(std::min(fixture_time + 50, milliseconds));
        };
        at(0);
        until(1000);
        // The orbit animation, the transition between mismatched lists and the clock's 240ms
        // transition start at 1000ms. The update at 1250ms ends the clock's; the next dispatches
        // its transitionend, whose listener reads that update.
        ui_toggle_class(engine, handle("orbit"), "on", true);
        ui_toggle_class(engine, handle("mixed"), "moved", true);
        ui_toggle_class(engine, handle("clock"), "off", true);
        at(1000);
        until(1250);
        at(1300);
        // Chromium 157's reads of the same program, the animation and transition paused at 250ms.
        expect(ui_element(engine, handle("log")).text,
               "none;"
               "matrix(1, 0, 0, 1, 10, 20);"
               "matrix(1, 0, 0, 1, 50, -20);"
               "matrix(1, 0, 0, 1, 65, 55);"
               "matrix(0, 1, -1, 0, 0, 0);"
               "matrix(0.866025, 0.5, -0.5, 0.866025, 0, 0);"
               "matrix(2, 0, 0, 0.5, 0, 0);"
               "matrix(0.94, 0, 0, 0.94, -50, -40);"
               "matrix(1, 0, 0, 1, 10, 0);"
               "matrix3d(0.866025, 0, -0.5, 0.005, 0, 1, 0, 0, 0.5, 0, 0.866025, -0.00866025, 0, "
               "0, 0, 1);"
               "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 10, 1);"
               "matrix3d(0.75, 0.25, -0.612372, 0, 0.25, 0.75, 0.612372, 0, 0.612372, -0.612372, "
               "0.5, 0, 0, 0, 0, 1);"
               "matrix(1, 0, 0, 1, 1e+06, 1e-07);"
               "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1);"
               "matrix(1, 0, 0, 1, 25, 0)|"
               "matrix(1, 0, 0, 1, 9, -27)",
               "the reads at the clock's transitionend");
        // The frozen value holds from the update that stops the animation, and renders.
        const auto orbit = handle("orbit");
        expect(ui_computed_style(engine, orbit, "transform"), "matrix(1, 0, 0, 1, 9, -27)",
               "the frozen transform as the animation stops");
        until(1600);
        expect(ui_computed_style(engine, orbit, "transform"), "matrix(1, 0, 0, 1, 9, -27)",
               "the frozen transform");
        // Rendering resolves the transforms the bounds project through.
        static_cast<void>(pal::record_ui_rml_frame(runtime, 640, 480));
        const auto moved = [&](const char* id, float x, float y) {
            auto* element = runtime.projected_elements.at(handle(id).value).element;
            const float ratio = Rml::ElementUtilities::GetDensityIndependentPixelRatio(element);
            Rml::Rectanglef bounds;
            check(Rml::ElementUtilities::GetBoundingBox(bounds, element, Rml::BoxArea::Border),
                  "bounds");
            const auto offset = element->GetAbsoluteOffset(Rml::BoxArea::Border);
            const bool placed = std::abs(bounds.Left() - offset.x - x * ratio) < 0.01f &&
                                std::abs(bounds.Top() - offset.y - y * ratio) < 0.01f;
            if (!placed)
                std::fprintf(stderr, "%s moved by %g, %g at ratio %g\n", id,
                             bounds.Left() - offset.x, bounds.Top() - offset.y, ratio);
            return placed;
        };
        check(moved("orbit", 9, -27), "the frozen matrix moves the element in CSS pixels");
        check(moved("affine", 10, 20), "a matrix3d() translation moves the element in CSS pixels");
        check(moved("pixels", 10, 20), "a translate() moves the element in CSS pixels");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "UI computed transform failure: %s\n", error.what());
    return 1;
}

#define main generated_main
#include "../../artifacts/ui-easing/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cmath>
#include <cstdio>

namespace {
double fixture_time = 1000;

// CSS cubic-bezier() in Bernstein form, solved by bisection.
double bezier(double x1, double y1, double x2, double y2, double x) {
    double low = 0, high = 1, s = 0.5;
    for (int i = 0; i < 100; ++i) {
        s = (low + high) / 2;
        const double sx = 3 * x1 * s * (1 - s) * (1 - s) + 3 * x2 * s * s * (1 - s) + s * s * s;
        (sx < x ? low : high) = s;
    }
    return 3 * y1 * s * (1 - s) * (1 - s) + 3 * y2 * s * s * (1 - s) + s * s * s;
}
} // namespace

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
    SDL_Window* window = SDL_CreateWindow("UI easing fixture", 640, 480, SDL_WINDOW_HIDDEN);
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
                at(std::min(fixture_time + 50, milliseconds));
        };
        const auto element = [&](const char* id) {
            return runtime.projected_elements.at(ui_get_element_by_id(engine, id).value).element;
        };
        const auto close_to = [&](const char* id, const char* what, double value, double expected,
                                  double tolerance) {
            if (std::abs(value - expected) <= tolerance)
                return true;
            std::fprintf(stderr, "%s %s %g, expected %g at %g ms\n", id, what, value, expected,
                         fixture_time);
            return false;
        };
        const auto opacity = [&](const char* id, double expected) {
            return close_to(id, "opacity", element(id)->GetComputedValues().opacity(), expected,
                            2e-3);
        };
        const auto width = [&](const char* id, double expected) {
            return close_to(id, "width", element(id)->GetBox().GetSize().x, expected, 0.5);
        };
        at(1000);
        for (const char* id : {"curve", "stepped", "initial"})
            ui_toggle_class(engine, ui_get_element_by_id(engine, id), "on", true);
        at(1000);
        advance(1020);
        check(width("stepped", 10) && opacity("stepped", 1), "steps() jump-end and step-start");
        advance(1050);
        const double ease = bezier(0.25, 0.1, 0.25, 1, 0.5);
        check(opacity("curve", ease) && opacity("initial", ease), "ease and the initial easing");
        const double overshoot = bezier(0.2, 0.9, 0.3, 1.5, 0.5);
        check(overshoot > 1 && width("curve", 10 + 100 * overshoot),
              "cubic-bezier() inside a transition list, overshooting");
        advance(1060);
        check(width("stepped", 60), "steps() mid-way");
        advance(1080);
        check(width("stepped", 85), "steps() late step");
        // A keyframe segment's steps(1, end) holds its start value until the segment ends.
        advance(1450);
        advance(1495);
        check(opacity("blink", 1), "steps() inside a keyframe segment holds");
        advance(1550);
        check(opacity("blink", 0), "steps() inside a keyframe segment jumps");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "UI easing failure: %s\n", error.what());
    return 1;
}

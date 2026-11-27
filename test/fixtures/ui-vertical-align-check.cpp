#define main generated_main
#include "../../artifacts/ui-vertical-align/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cmath>
#include <cstdio>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 1000; }
Engine& window_document_engine() {
    static Engine document;
    return document;
}
void update_window_document(bool) {}
} // namespace bbl::pal
#include "realm-application-fixture.hpp"

int main() try {
    using namespace bbl;
    const auto check = [](bool pass, const char* message) {
        if (!pass)
            throw std::runtime_error(message);
    };
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    SDL_Window* window = SDL_CreateWindow("UI vertical-align fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        auto& engine = pal::window_document_engine();
        check(generated_main() == 0, "program");
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        const auto top = [&](const char* id) {
            return runtime.projected_elements.at(ui_get_element_by_id(engine, id).value)
                .element->GetAbsoluteOffset(Rml::BoxArea::Border)
                .y;
        };
        const auto close_to = [](float a, float b) { return std::abs(a - b) < 0.01f; };
        const float base = top("base");
        // A length lowers (negative) or raises (positive) the box's baseline by it.
        check(close_to(top("down") - base, 4), "-4px lowers the box by 4px");
        check(close_to(base - top("up"), 4), "4px raises the box by 4px");
        // A percentage is of the box's line height, an em of its font size.
        check(close_to(base - top("half"), 10), "50% of a 20px line height raises the box by 10px");
        check(close_to(top("em"), top("down")), "-0.25em of 16px lowers the box by 4px");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "UI vertical-align failure: %s\n", error.what());
    return 1;
}

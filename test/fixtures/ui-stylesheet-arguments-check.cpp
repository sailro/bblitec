#define main generated_main
#include "../../artifacts/ui-stylesheet-arguments/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
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
    check(generated_main() == 0, "program");
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    SDL_Window* window =
        SDL_CreateWindow("UI stylesheet arguments fixture", 320, 240, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        auto& engine = pal::window_document_engine();
        pal::UiRmlRuntime runtime(engine, window, 320, 240);
        pal::update_ui_rml_runtime(runtime, 320, 240);
        const auto element = [&](const char* id) {
            return runtime.projected_elements.at(ui_get_element_by_id(engine, id).value).element;
        };
        const auto painted = [&](const char* id, float width, Rml::Colourb background) {
            auto* box = element(id);
            const float actual = box->GetBox().GetSize().x;
            const auto colour = box->GetComputedValues().background_color();
            if (actual != width || colour != background)
                std::fprintf(stderr, "%s: width %g, background %d,%d,%d,%d\n", id, actual,
                             colour.red, colour.green, colour.blue, colour.alpha);
            return actual == width && colour == background;
        };
        check(painted("alert", 40, {255, 0, 0, 255}), "first module sheet");
        check(painted("calm", 30, {0, 0, 255, 255}), "second module sheet");
        check(painted("badge", 20, {255, 255, 0, 255}), "joined declarations");
        ui_click(engine, ui_get_element_by_id(engine, "refresh"));
        pal::update_ui_rml_runtime(runtime, 320, 240);
        check(painted("alert", 60, {0, 128, 0, 255}), "a refresh replaces its sheet");
        check(painted("calm", 30, {0, 0, 255, 255}), "a refresh keeps other sheets");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "UI stylesheet arguments failure: %s\n", error.what());
    return 1;
}

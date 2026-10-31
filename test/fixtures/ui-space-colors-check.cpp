#define main generated_main
#include "../../artifacts/ui-space-colors/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
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
} // namespace bbl::pal
#include "realm-application-fixture.hpp"

int main() try {
    using namespace bbl;
    const auto check = [](bool pass, const char* message) {
        if (!pass)
            throw std::runtime_error(message);
    };
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    SDL_Window* window = SDL_CreateWindow("UI space colours fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        auto& engine = pal::window_document_engine();
        check(generated_main() == 0, "program");
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        const auto element = [&](const char* id) {
            return runtime.projected_elements.at(ui_get_element_by_id(engine, id).value).element;
        };
        const auto colour = [](Rml::Colourb value, int red, int green, int blue, int alpha) {
            if (value.red != red || value.green != green || value.blue != blue ||
                value.alpha != alpha)
                std::fprintf(stderr, "colour %d %d %d %d, expected %d %d %d %d\n", value.red,
                             value.green, value.blue, value.alpha, red, green, blue, alpha);
            return value.red == red && value.green == green && value.blue == blue &&
                   value.alpha == alpha;
        };
        const auto& sheet = element("sheet")->GetComputedValues();
        check(colour(sheet.background_color(), 21, 22, 38, 224),
              "sheet background alpha percentage");
        check(colour(sheet.color(), 255, 128, 0, 255), "sheet channel percentages");
        check(colour(element("inline")->GetComputedValues().background_color(), 10, 20, 30, 128),
              "inline write with a numeric alpha");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "UI space colours failure: %s\n", error.what());
    return 1;
}

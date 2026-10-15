#include "pal_ui_rml.cpp"

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected fixture asset"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() try {
    using namespace bbl;
    const auto expect_near = [](float actual, float expected, const char* label) {
        if (std::abs(actual - expected) > .1f) {
            std::fprintf(stderr, "%s: %.3f != %.3f\n", label, actual, expected);
            throw std::runtime_error(label);
        }
    };
    if (!SDL_Init(SDL_INIT_VIDEO))
        throw std::runtime_error(SDL_GetError());
    auto* window = SDL_CreateWindow("Relative grid tracks", 640, 480, SDL_WINDOW_HIDDEN);
    if (!window)
        throw std::runtime_error(SDL_GetError());
    {
        Engine engine;
        const auto make = [&](const char* style) {
            const auto node = ui_create_element(engine, "div");
            ui_set_attribute(engine, node, "style", style);
            return node;
        };
        const auto grid = make(
            "position:absolute;display:grid;width:500px;font-size:20px;grid-template-columns:2em 2rem 10vw 10vh;grid-template-rows:2em;grid-auto-rows:1em;");
        ui_append_to_root(engine, grid);
        std::vector<UiElementHandle> cells;
        for (int i = 0; i < 8; ++i) {
            const auto cell = make("min-width:0;min-height:0;");
            ui_append_child(engine, grid, cell);
            cells.push_back(cell);
        }
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto update = [&](int width = 640, int height = 480) {
            pal::update_ui_rml_runtime(runtime, width, height);
        };
        const auto size = [&](std::size_t index) {
            return runtime.projected_elements.at(cells.at(index).value).element->GetBox().GetSize();
        };
        update();
        expect_near(size(0).x, 40, "em column uses grid font");
        expect_near(size(1).x, 32, "rem column uses document font");
        expect_near(size(2).x, 64, "vw column uses viewport width");
        expect_near(size(3).x, 48, "vh column uses viewport height");
        expect_near(size(0).y, 40, "explicit em row");
        expect_near(size(4).y, 20, "implicit em row");
        ui_set_style_property(engine, grid, "font-size", "30px");
        update();
        expect_near(size(0).x, 60, "em column follows font change");
        expect_near(size(0).y, 60, "explicit row follows font change");
        expect_near(size(4).y, 30, "implicit row follows font change");
        expect_near(size(1).x, 32, "rem ignores local font change");
        update(800, 600);
        expect_near(size(2).x, 80, "vw follows viewport resize");
        expect_near(size(3).x, 60, "vh follows viewport resize");
        ui_set_style_property(engine, grid, "grid-template-columns",
                              "repeat(auto-fit,minmax(2em,1fr))");
        ui_set_style_property(engine, grid, "width", "180px");
        update(800, 600);
        expect_near(size(0).x, 60, "auto-repeat uses resolved em minimum");
        ui_set_style_property(engine, grid, "grid-template-columns", "none");
        ui_set_style_property(engine, grid, "grid-auto-columns", "2em");
        ui_set_style_property(engine, cells[0], "grid-column", "2");
        update(800, 600);
        expect_near(size(0).x, 60, "implicit columns resolve em");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "Relative grid failure: %s\n", error.what());
    return 1;
}

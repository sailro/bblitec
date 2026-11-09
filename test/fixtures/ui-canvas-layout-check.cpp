#include <SDL3/SDL.h>
// Match the browser fixture's deviceScaleFactor=1 independently of the host display.
static float fixture_display_scale(SDL_Window*) { return 1.f; }
#define SDL_GetWindowDisplayScale fixture_display_scale
#include "pal_ui_rml.cpp"
#undef SDL_GetWindowDisplayScale
#include "cases.hpp"

#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() {
    using namespace bbl;
    using namespace bbl::pal;
    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* window = SDL_CreateWindow("Canvas sizing fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    int failures = 0;
    {
        std::unique_ptr<Engine> engine;
        std::unique_ptr<UiRmlRuntime> runtime;
        UiElementHandle parent{}, canvas{};
        for (const auto& test : canvas_layout_cases) {
            if (test.first) {
                runtime.reset();
                engine = std::make_unique<Engine>();
                const auto host = ui_create_element(*engine, "div");
                ui_set_attribute(
                    *engine, host, "style",
                    "position:relative;width:400px;height:300px;font-size:0;line-height:0;");
                ui_append_to_root(*engine, host);
                parent = ui_create_element(*engine, "div");
                ui_set_attribute(*engine, parent, "style", std::string(test.parent_style));
                ui_append_child(*engine, host, parent);
                canvas = ui_create_element(*engine, "canvas");
                ui_append_child(*engine, parent, canvas);
            }
            ui_set_attribute(*engine, canvas, "style",
                             "vertical-align:top;" + std::string(test.canvas_style));
            if (test.backing_width >= 0)
                ui_canvas_set_width(*engine, canvas, test.backing_width);
            if (test.backing_height >= 0)
                ui_canvas_set_height(*engine, canvas, test.backing_height);
            if (!runtime)
                runtime = std::make_unique<UiRmlRuntime>(*engine, window, 640, 480);
            update_ui_rml_runtime(*runtime, 640, 480);
            auto* outer = runtime->projected_elements.at(parent.value).element;
            auto* inner = runtime->projected_elements.at(canvas.value).element;
            assert(outer && inner);
            const auto parent_size = outer->GetBox().GetSize(Rml::BoxArea::Border);
            const auto canvas_size = inner->GetBox().GetSize(Rml::BoxArea::Border);
            const auto offset = inner->GetAbsoluteOffset(Rml::BoxArea::Border) -
                                outer->GetAbsoluteOffset(Rml::BoxArea::Border);
            const double scale = runtime->density_ratio;
            const std::array<double, 6> actual{parent_size.x / scale, parent_size.y / scale,
                                               offset.x / scale,      offset.y / scale,
                                               canvas_size.x / scale, canvas_size.y / scale};
            bool equal = true;
            for (std::size_t lane = 0; lane < actual.size(); ++lane)
                equal = equal && std::isfinite(actual[lane]) &&
                        std::abs(actual[lane] - test.expected[lane]) < 0.02;
            if (!equal) {
                ++failures;
                std::fprintf(stderr, "%s%s: native", test.name.data(),
                             test.first ? "" : " (update)");
                for (double value : actual)
                    std::fprintf(stderr, " %.6g", value);
                std::fprintf(stderr, "; browser");
                for (double value : test.expected)
                    std::fprintf(stderr, " %.6g", value);
                std::fprintf(stderr, "\n");
            }
        }
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return failures == 0 ? 0 : 1;
}

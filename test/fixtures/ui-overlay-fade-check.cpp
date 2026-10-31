#define main generated_main
#include "../../artifacts/ui-overlay-fade/program.hpp"
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
    SDL_Window* window = SDL_CreateWindow("UI overlay fade fixture", 1280, 720, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        auto& engine = pal::window_document_engine();
        check(generated_main() == 0, "program");
        pal::UiRmlRuntime runtime(engine, window, 1280, 720);
        const auto overlay = ui_get_element_by_id(engine, "loadingOverlay");
        const auto fill = ui_get_element_by_id(engine, "loadingBarFill");
        // Frames every 16 ms up to `until`, as the display renders them.
        const auto frames_until = [&](double until) -> const pal::UiRenderFrame* {
            const pal::UiRenderFrame* frame = nullptr;
            while (fixture_time < until) {
                fixture_time += 16;
                pal::set_ui_rml_time(runtime, fixture_time);
                pal::update_ui_rml_runtime(runtime, 1280, 720);
                frame = &pal::record_ui_rml_frame(runtime, 1280, 720);
            }
            return frame;
        };
        // The opacity a draw reaches the frame at: the opacity filters of the
        // composites carrying its layer down to layer 0 (CSS group opacity).
        const auto draw_opacity = [](const pal::UiRenderFrame& frame, std::size_t draw) {
            float opacity = 1;
            std::uint32_t layer = frame.draws[draw].layer;
            for (const auto& operation : frame.operations) {
                if (layer == 0)
                    break;
                if (operation.kind != pal::UiRenderOperation::Kind::Composite ||
                    operation.before_draw <= draw)
                    continue;
                const auto& composite = frame.composites[operation.index];
                if (composite.source != layer)
                    continue;
                for (const auto& filter : composite.filters)
                    if (filter.kind == pal::UiFilterKind::Color)
                        opacity *= filter.matrix[15];
                layer = composite.destination;
            }
            return opacity;
        };
        const auto orange = [](const pal::UiRenderFrame& frame) {
            std::size_t count = 0;
            for (const auto& draw : frame.draws)
                for (std::uint32_t index = draw.first_index;
                     index < draw.first_index + draw.index_count; ++index) {
                    const auto& vertex = frame.vertices[frame.indices[index]];
                    count += vertex.alpha > 0 && vertex.red > vertex.blue + 64 &&
                             vertex.red > vertex.green + 64;
                }
            return count;
        };
        // The most opaque orange vertex: the fill, at the opacity it reaches the frame at.
        const auto fill_alpha = [&](const pal::UiRenderFrame& frame) {
            int alpha = 0;
            for (std::size_t draw = 0; draw < frame.draws.size(); ++draw)
                for (std::uint32_t index = frame.draws[draw].first_index;
                     index < frame.draws[draw].first_index + frame.draws[draw].index_count;
                     ++index) {
                    const auto& vertex = frame.vertices[frame.indices[index]];
                    if (vertex.red * 2 > vertex.blue * 3 && vertex.red * 2 > vertex.green * 3)
                        alpha = std::max(alpha, static_cast<int>(std::lround(
                                                    vertex.alpha * draw_opacity(frame, draw))));
                }
            return alpha;
        };
        frames_until(1100);
        // installFetchProgress: progress shows, the fill grows to its width.
        ui_toggle_class(engine, overlay, "has-progress", true);
        frames_until(1200);
        ui_set_style_property(engine, fill, "width", "100%");
        const auto* shown = frames_until(1700);
        check(shown && orange(*shown) > 0 && fill_alpha(*shown) == 255,
              "the progress bar shows while loading");
        // The scene is ready: the overlay fades, then leaves the document.
        ui_toggle_class(engine, overlay, "is-hidden", true);
        // Opacity is a group effect: the bar's own opacity composes with the
        // fading overlay's, 0.5 s ease, near its end.
        const auto* fading = frames_until(2100);
        check(fading != nullptr, "frames while fading");
        if (fill_alpha(*fading) > 40)
            std::fprintf(stderr, "fill alpha while the overlay fades out: %d\n",
                         fill_alpha(*fading));
        check(fill_alpha(*fading) <= 40, "the progress bar fades with its overlay");
        frames_until(2300);
        ui_remove(engine, overlay);
        const auto* gone = frames_until(3300);
        check(gone != nullptr, "frames after the removal");
        if (orange(*gone) > 0 || !gone->draws.empty())
            std::fprintf(stderr, "after removal: %zu orange vertices, %zu draws\n", orange(*gone),
                         gone->draws.size());
        check(orange(*gone) == 0 && gone->draws.empty(),
              "a removed overlay leaves nothing of its progress bar");

        // A translucent container composites with its child as one group: the
        // child's opaque background covers the container's inside the group,
        // so the container's never shows through it.
        const auto group = ui_create_element(engine, "div");
        ui_set_attribute(engine, group, "style",
                         "position:fixed;left:0;top:0;width:100px;height:100px;"
                         "background-color:#ff0000;opacity:0.5;");
        const auto child = ui_create_element(engine, "div");
        ui_set_attribute(engine, child, "style",
                         "width:100px;height:100px;background-color:#0000ff;");
        ui_append_child(engine, group, child);
        ui_append_to_root(engine, group);
        const auto* grouped = frames_until(3400);
        check(grouped != nullptr, "frames with the group");
        std::size_t red = 0, blue = 0;
        for (std::size_t draw = 0; draw < grouped->draws.size(); ++draw)
            for (std::uint32_t index = grouped->draws[draw].first_index;
                 index < grouped->draws[draw].first_index + grouped->draws[draw].index_count;
                 ++index) {
                const auto& vertex = grouped->vertices[grouped->indices[index]];
                const bool is_red = vertex.red > 200 && vertex.blue < 50;
                const bool is_blue = vertex.blue > 200 && vertex.red < 50;
                if (!is_red && !is_blue)
                    continue;
                check(vertex.alpha == 255 && grouped->draws[draw].layer != 0 &&
                          std::abs(draw_opacity(*grouped, draw) - 0.5f) < 0.01f,
                      "the group's boxes paint opaque into one layer composited at 0.5");
                red += is_red;
                blue += is_blue;
            }
        check(red > 0 && blue > 0, "the group paints both backgrounds");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "UI overlay fade failure: %s\n", error.what());
    return 1;
}

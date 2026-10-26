#include <SDL3/SDL.h>
#include <cassert>

namespace {
SDL_Window* hidden_window(const char* title, int width, int height, SDL_WindowFlags flags) {
    return SDL_CreateWindow(title, width, height, flags | SDL_WINDOW_HIDDEN);
}
} // namespace
#define SDL_CreateWindow hidden_window
#include "pal_ui_rml.cpp"
#include "window-frame-clock-fixture.hpp"
#define WindowFrameClock FixtureWindowFrameClock
#include "pal_window_realm.cpp"
#undef WindowFrameClock
#include "pal_media_query.cpp"
#include "window-frame-unit-fixture.hpp"

namespace bbl {
void set_canvas_dataset(Engine&, std::string, std::string) {
    throw std::runtime_error("Unexpected fixture dataset replay");
}
} // namespace bbl
namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected fixture asset"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
double monotonic_milliseconds() {
    return std::chrono::duration<double, std::milli>(EventLoop::Clock::now().time_since_epoch())
        .count();
}
const char* bblite_build_stamp() { return "fixture-build-stamp"; }
void report_build_stamp() {}
struct SurfacePresenter final : WindowPresenter {
    OffscreenDevice graphics;
    OffscreenDevice& device() override { return graphics; }
    bool can_present() override { return true; }
    bool present(std::span<const WindowCanvasFrame>, const UiRenderFrame&,
                 const std::string&) override {
        return true;
    }
};
std::shared_ptr<WindowPresenter> create_window_sdl_gpu_presenter(SDL_Window*) {
    return std::make_shared<SurfacePresenter>();
}
struct Image final : OffscreenImage {};
} // namespace bbl::pal

int main() {
    using namespace bbl;
    using namespace bbl::pal;
    const auto initialize = [](WorkerRealm& realm) {
        auto& document = window_document_engine();
        const auto canvas = [&](const char* style) {
            const auto element = ui_create_element(document, "canvas");
            ui_set_attribute(document, element, "style", style);
            ui_append_to_root(document, element);
            return element;
        };
        const auto primary = canvas("position:absolute;left:0;top:0;width:120px;height:100px");
        const auto secondary = canvas("position:absolute;left:120px;top:0;width:80px;height:60px");
        const auto element = window_canvas(primary);
        auto engine = std::make_shared<Engine>();
        engine->realm_owner = engine;
        engine->offscreen_run = element->rendering_context();
        bind_canvas_engine(element, engine);
        // This fixture supplies sizing; the generated pinned resize is tested in engine-switches.
        engine->resize_surface_canvas = [](OffscreenRun& run, double width, double height) {
            run.resize(static_cast<std::uint32_t>(width), static_cast<std::uint32_t>(height));
        };
        engine->resize_surface = [](Engine& target) {
            target.resize_surface_canvas(*target.offscreen_run, target.canvas_client_width,
                                         target.canvas_client_height);
        };
        auto disposed = std::make_shared<bool>(false);
        engine->attach_surface(secondary, disposed);
        assert(engine->ui_elements.empty());
        assert(engine->offscreen_run->extent().width == 120);
        assert(engine->offscreen_run->render_extent().width == 200);
        assert(engine->surface_panes.at(secondary.value).x == 120);
        auto image = std::make_shared<Image>();
        engine->offscreen_run->publish(200, 100, image);
        auto& host = *current_document().host;
        auto frame = host.canvases.at(secondary.value)->surface->take_frame();
        assert(frame && frame->width == 80 && frame->height == 60 && frame->image == image);

        UiRenderFrame ui;
        ui.textures.push_back({.id = 9, .rgba = {}, .external_canvas = secondary.value});
        append_ui_quad(ui, 0, 0, 80, 60, 255);
        ui.draws.push_back({.first_index = 0, .index_count = 6, .texture_id = 9});
        const std::array frames{WindowCanvasFrame{secondary, *frame}};
        const auto view = window_canvas_views(ui, frames);
        assert(view && ui.vertices.front().u == 0);
        const auto& vertex = view->vertices.at(view->indices.at(view->draws.front().first_index));
        assert(vertex.u == 0.6f && vertex.v == 0);

        *disposed = true;
        engine->update_surface_layout(*engine);
        assert(engine->surface_panes.empty());
        assert(engine->offscreen_run->render_extent().width == 120);
        assert(!host.canvases.at(secondary.value)->surface->presenting());
        disposed = std::make_shared<bool>(false);
        engine->attach_surface(secondary, disposed);
        assert(host.canvases.at(secondary.value)->surface->presenting());
        assert(engine->surface_panes.at(secondary.value).width == 80);
        realm.close();
    };
    EngineOptions options;
    options.width = 320;
    options.height = 200;
    assert(run_window_application(initialize, options) == 0);
}

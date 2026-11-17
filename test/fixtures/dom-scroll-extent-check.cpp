#define main generated_main
#include "../../artifacts/dom-scroll-extent/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cassert>

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
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.run([&] { initialize(realm); });
    return 0;
}
} // namespace bbl::pal

int main() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("scroll extent fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        auto& engine = pal::window_document_engine();
        assert(generated_main() == 0);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        const auto box = ui_get_client_rect(engine, ui_get_element_by_id(engine, "box")).unzoomed(),
                   fit = ui_get_client_rect(engine, ui_get_element_by_id(engine, "fit")).unzoomed();
        // The overflowing box reports its content's extent; the fitting one its own box.
        assert(box.scroll_height == 50 && box.height == 20);
        assert(box.scroll_width == 40 && box.width == 40);
        assert(fit.scroll_height == 30 && fit.height == 30);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}

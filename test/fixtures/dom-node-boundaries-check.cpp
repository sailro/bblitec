#define main generated_main
#include "../../artifacts/dom-node-boundaries/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected fixture asset"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
Engine& window_document_engine() {
    static Engine engine;
    return engine;
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
int main() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* window = SDL_CreateWindow("DOM node projection", 320, 240, SDL_WINDOW_HIDDEN);
    assert(window && generated_main() == 0);
    {
        auto& engine = pal::window_document_engine();
        const auto svg = ui_get_element_by_id(engine, "shapes");
        const auto markup = pal::ui_svg_markup(engine, ui_element(engine, svg));
        assert(markup.source.find("<line") != std::string::npos);
        assert(markup.source.find("<ellipse") != std::string::npos);
        assert(markup.source.find("<polyline") != std::string::npos);
        assert(markup.source.find("<polygon") != std::string::npos);
        pal::UiRmlRuntime runtime(engine, window, 320, 240);
        const auto& frame = pal::record_ui_rml_frame(runtime, 320, 240);
        assert(!frame.draws.empty() && !frame.textures.empty());
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}

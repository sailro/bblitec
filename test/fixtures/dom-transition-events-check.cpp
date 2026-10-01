#define main generated_main
#include "../../artifacts/dom-transition-events/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cassert>
#include <cstdio>

namespace {
double fixture_milliseconds = 0;
}

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return fixture_milliseconds; }
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

int run() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("DOM transition fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        auto& engine = pal::window_document_engine();
        assert(generated_main() == 0);
        const auto log = ui_get_element_by_id(engine, "log");
        const auto root = ui_get_element_by_id(engine, "root");
        const auto child = ui_get_element_by_id(engine, "child");
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto update = [&](double milliseconds) {
            fixture_milliseconds = milliseconds;
            pal::update_ui_rml_runtime(runtime, 640, 480);
        };
        const auto fade = [&](bool hidden) {
            ui_toggle_class(engine, root, "is-hidden", hidden);
            ui_toggle_class(engine, child, "is-hidden", hidden);
        };
        update(0);
        fade(true);
        update(0);
        // The child's shorter transition ends first: the Document capture
        // listener, then the root's listener as it bubbles.
        update(100);
        update(110);
        assert(ui_element(engine, log).text == "Dc");
        // The root's own end removes its listener.
        update(300);
        update(310);
        // Its listener read the computed styles of the update that ended it.
        assert(ui_element(engine, log).text == "DcT[block,0,visible,auto;0]");
        fade(false);
        update(400);
        update(800);
        update(810);
        assert(ui_element(engine, log).text == "DcT[block,0,visible,auto;0]D");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}

int main() {
    try {
        return run();
    } catch (const std::exception& error) {
        std::fputs(error.what(), stderr);
        return 1;
    }
}

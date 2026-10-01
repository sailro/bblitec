#define main generated_main
#include "../../artifacts/dom-element-surface/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include "pal_platform_events.hpp"
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
    SDL_Window* window = SDL_CreateWindow("DOM element fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        auto& engine = pal::window_document_engine();
        assert(generated_main() == 0);
        const auto log = ui_get_element_by_id(engine, "log");
        const auto button = ui_get_element_by_id(engine, "button");
        // Connection, containment, attribute and class reads and blur ran at evaluation.
        assert(ui_element(engine, log).text == "12345b67");
        assert(ui_active_element(engine).value == invalid_handle);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        static_cast<void>(ui_get_client_rect(engine, button));
        pal::update_ui_rml_runtime(runtime, 640, 480);
        const auto& rect = ui_element(engine, button).client_rect;
        assert(rect.width == 88 && rect.height == 48);
        assert(rect.offset_width == 94 && rect.offset_height == 54);
        const auto send = [&](SDL_Event event) {
            const auto batch = pal::prepare_dom_platform_input(engine, event);
            assert(batch);
            dispatch_dom_batch(engine, batch);
            assert(batch->ready());
            if (!batch->default_prevented)
                static_cast<void>(pal::handle_ui_rml_event(runtime, event));
            pal::update_ui_rml_runtime(runtime, 640, 480);
        };
        const auto click = [&](float x, float y) {
            SDL_Event motion{};
            motion.type = SDL_EVENT_MOUSE_MOTION;
            motion.motion.windowID = SDL_GetWindowID(window);
            motion.motion.x = x;
            motion.motion.y = y;
            send(motion);
            SDL_Event down{};
            down.type = SDL_EVENT_MOUSE_BUTTON_DOWN;
            down.button.windowID = SDL_GetWindowID(window);
            down.button.button = SDL_BUTTON_LEFT;
            down.button.down = true;
            down.button.x = x;
            down.button.y = y;
            send(down);
            SDL_Event up = down;
            up.type = SDL_EVENT_MOUSE_BUTTON_UP;
            up.button.down = false;
            send(up);
        };
        // The handler keeps its first listener position when replaced, a null
        // handler removes it, and a later handler joins after B.
        click(40, 20);
        assert(ui_element(engine, log).text == "12345b67MPAHB");
        click(40, 20);
        assert(ui_element(engine, log).text == "12345b67MPAHBAIB");
        click(40, 20);
        assert(ui_element(engine, log).text == "12345b67MPAHBAIBAB");
        click(40, 20);
        assert(ui_element(engine, log).text == "12345b67MPAHBAIBABABJ");
        // Only the replacing change handler runs.
        click(215, 15);
        assert(ui_element(engine, log).text == "12345b67MPAHBAIBABABJD");
        const auto body = ui_element(engine, button).parent;
        assert(ui_contains(engine, body, button) && !ui_contains(engine, button, body));
        assert(ui_is_connected(engine, body) && ui_contains(engine, button, button));
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}

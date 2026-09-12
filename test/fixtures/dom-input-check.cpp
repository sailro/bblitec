#define BBLITE_WORKERS 1
#define BBLITE_OFFSCREEN_SURFACES 1
#define BBLITE_HAS_DOM_INPUT 1
#define main generated_main
#include "../../artifacts/dom-input/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include "pal_platform_events.hpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected fixture asset read"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
Engine& window_document_engine() { static Engine document; return document; }
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.run([&] { initialize(realm); });
    return 0;
}
}

int main() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("DOM input fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        auto& engine = pal::window_document_engine();
        assert(generated_main() == 0);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        const auto button = ui_get_element_by_id(engine, "button"), log = ui_get_element_by_id(engine, "log");
        const auto path = engine.dom_input->hit_path(40, 40);
        assert(path.front() == DomEventTarget::node(button.value));
        assert(path.back() == DomEventTarget::window());
        const auto send = [&](SDL_Event event) {
            const auto batch = pal::prepare_dom_platform_input(engine, event);
            assert(batch);
            dispatch_dom_batch(engine, batch);
            assert(batch->ready());
            if (!batch->default_prevented) static_cast<void>(pal::handle_ui_rml_event(runtime, event));
            pal::update_ui_rml_runtime(runtime, 640, 480);
            return batch->default_prevented;
        };
        SDL_Event motion{};
        motion.type = SDL_EVENT_MOUSE_MOTION;
        motion.motion.windowID = SDL_GetWindowID(window);
        motion.motion.x = 40; motion.motion.y = 40;
        assert(!send(motion));
        SDL_Event down{};
        down.type = SDL_EVENT_MOUSE_BUTTON_DOWN;
        down.button.windowID = SDL_GetWindowID(window);
        down.button.button = SDL_BUTTON_LEFT;
        down.button.down = true;
        down.button.x = 40; down.button.y = 40;
        assert(send(down));
        assert(ui_element(engine, log).text == "DPW");
        assert(runtime.context->GetFocusElement() != runtime.projected_elements.at(button.value).element);
        SDL_Event up = down;
        up.type = SDL_EVENT_MOUSE_BUTTON_UP; up.button.down = false;
        assert(!send(up));
        assert(ui_element(engine, log).text == "DPWC");
        assert(!send(down));
        assert(ui_element(engine, log).text == "DPWCDWM");
        assert(!send(up));
        assert(ui_element(engine, log).text == "DPWCDWM");
        SDL_Event key{};
        key.type = SDL_EVENT_KEY_DOWN;
        key.key.scancode = SDL_SCANCODE_ESCAPE;
        key.key.key = SDLK_ESCAPE;
        assert(send(key));
        assert(ui_element(engine, log).text == "DPWCDWMK");
        int clicks = 0;
        on_dom_pointer(engine, DomEventTarget::node(button.value), "click", 900, [&](const PlatformMouseEvent& event) {
            assert(!event.dom->trusted);
            assert(event.dom->path.back() == DomEventTarget::window());
            ++clicks;
        });
        ui_click(engine, button);
        assert(clicks == 1);
        ui_set_boolean_attribute(engine, button, "disabled", true);
        ui_click(engine, button);
        assert(clicks == 1);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(!send(down));
        assert(!send(up));
        assert(clicks == 1);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}

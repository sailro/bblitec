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
        assert(ui_get_attribute(engine, button, "data-target") == "yes");
        assert(ui_get_attribute(engine, button, "data-up") == "yes");
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
        const auto late = ui_create_element(engine, "button");
        ui_set_attribute(engine, late, "style", "position:absolute;left:260px;top:20px;width:80px;height:40px");
        ui_append_child(engine, ui_document_root(engine, UiDocumentPart::Body), late);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(engine.dom_input->hit_path(280, 40).front() != DomEventTarget::node(late.value));
        on_dom_pointer(engine, DomEventTarget::node(late.value), "click", 901, [](const PlatformMouseEvent&) {});
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(engine.dom_input->hit_path(280, 40).front() == DomEventTarget::node(late.value));
        ui_set_style_property(engine, late, "pointer-events", "none");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(engine.dom_input->hit_path(280, 40).front() != DomEventTarget::node(late.value));
        SDL_Event leave{};
        leave.type = SDL_EVENT_WINDOW_MOUSE_LEAVE;
        assert(!send(leave));
        assert(ui_get_attribute(engine, button, "data-left") == "true");
        ui_set_boolean_attribute(engine, button, "disabled", true);
        ui_click(engine, button);
        assert(clicks == 1);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(!send(down));
        assert(!send(up));
        assert(clicks == 1);
    }
    {
        Engine engine;
        pal::update_engine_canvas_metrics(engine, 640, 480, 1, 1);
        std::array<UiElementHandle, 2> buttons;
        std::array<std::set<double>, 2> held;
        std::map<double, bool> primary;
        int mouse_downs = 0, cancelled = 0;
        for (std::size_t i = 0; i < buttons.size(); ++i) {
            const auto button = buttons[i] = ui_create_element(engine, "div");
            ui_set_attribute(engine, button, "style", "position:absolute;left:" + std::to_string(20 + i * 120) + "px;top:20px;width:80px;height:60px");
            ui_append_to_root(engine, button);
            on_dom_pointer(engine, DomEventTarget::node(button.value), "pointerdown", 1, [&, i](const PlatformMouseEvent& event) {
                assert(event.pointer_type == "touch" && event.buttons == 1);
                held[i].insert(event.pointer_id);
                primary[event.pointer_id] = event.is_primary;
                if (i == 0) event.prevent_default();
            });
            for (const auto type : {"pointerup", "pointercancel"}) on_dom_pointer(engine, DomEventTarget::node(button.value), type, 2,
                [&, i](const PlatformMouseEvent& event) {
                    assert(event.dom->target == DomEventTarget::node(buttons[i].value));
                    assert(event.buttons == 0);
                    assert(primary.at(event.pointer_id) == event.is_primary);
                    assert(held[i].erase(event.pointer_id) == 1);
                    if (event.dom->type == "pointercancel") ++cancelled;
                });
            on_dom_pointer(engine, DomEventTarget::node(button.value), "mousedown", 3, [&](const PlatformMouseEvent&) { ++mouse_downs; });
        }
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        const auto touch = [&](SDL_EventType type, SDL_FingerID id, float x, float y) {
            SDL_Event event{};
            event.type = type; event.tfinger.windowID = SDL_GetWindowID(window);
            event.tfinger.touchID = 9; event.tfinger.fingerID = id;
            event.tfinger.x = x / 640; event.tfinger.y = y / 480;
            const auto batch = pal::prepare_dom_platform_input(engine, event);
            dispatch_dom_batch(engine, batch);
            return batch->default_prevented;
        };
        assert(touch(SDL_EVENT_FINGER_DOWN, 100, 40, 40));
        assert(!touch(SDL_EVENT_FINGER_DOWN, 200, 160, 40));
        assert(held[0].size() == 1 && held[1].size() == 1);
        assert(*held[0].begin() != *held[1].begin());
        assert(mouse_downs == 0); // Cancelled primary and secondary contacts do not emit mousedown.
        assert(touch(SDL_EVENT_FINGER_MOTION, 100, 600, 400));
        assert(touch(SDL_EVENT_FINGER_UP, 100, 600, 400));
        assert(held[0].empty() && held[1].size() == 1); // Implicit capture survives sliding off.
        assert(!touch(SDL_EVENT_FINGER_DOWN, 300, 160, 40));
        assert(held[1].size() == 2);
        for (const auto id : held[1]) assert(!primary.at(id)); // No promotion while another contact remains.
        assert(!touch(SDL_EVENT_FINGER_CANCELED, 200, 600, 400));
        assert(held[1].size() == 1 && cancelled == 1);
        SDL_Event blur{}; blur.type = SDL_EVENT_WINDOW_FOCUS_LOST;
        dispatch_dom_batch(engine, pal::prepare_dom_platform_input(engine, blur));
        assert(held[1].empty() && cancelled == 2 && engine.dom_input->touches.empty());
        assert(engine.dom_input->suppress_compatibility_mouse.empty());
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}

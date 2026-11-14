#define main generated_main
#include "../../artifacts/dom-element-from-point/program.hpp"
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
    SDL_Window* window = SDL_CreateWindow("elementFromPoint fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        auto& engine = pal::window_document_engine();
        assert(generated_main() == 0);
        // No display has laid the document out yet.
        bool refused = false;
        try {
            static_cast<void>(ui_element_from_point(engine, 40, 40));
        } catch (const std::logic_error&) {
            refused = true;
        }
        assert(refused);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        const auto button = ui_get_element_by_id(engine, "button"),
                   panel = ui_get_element_by_id(engine, "panel"),
                   log = ui_get_element_by_id(engine, "log");
        const auto html = ui_document_root(engine, UiDocumentPart::Html);
        // The topmost element under one pointer events pass through, and one no listener
        // made a target of the display's own hit test.
        assert(ui_element_from_point(engine, 40, 40) == DomEventTarget::node(button.value));
        assert(ui_element_from_point(engine, 150, 60) == DomEventTarget::node(panel.value));
        // The canvas is the page's background; without one the root element answers where the
        // page lays nothing else.
        assert(ui_element_from_point(engine, 300, 300) == DomEventTarget::canvas());
        engine.dom_input->canvas_background = false;
        assert(ui_element_from_point(engine, 300, 300) == DomEventTarget::node(html.value));
        engine.dom_input->canvas_background = true;
        // Outside the viewport there is no element; its far edges are inside.
        assert(!ui_element_from_point(engine, -1, 5));
        assert(!ui_element_from_point(engine, 5, -1));
        assert(!ui_element_from_point(engine, 641, 5));
        assert(!ui_element_from_point(engine, 5, 481));
        assert(ui_element_from_point(engine, 640, 480) == DomEventTarget::canvas());
        // WebIDL double: a non-finite coordinate is a TypeError.
        bool type_error = false;
        try {
            static_cast<void>(
                ui_element_from_point(engine, std::numeric_limits<double>::quiet_NaN(), 5));
        } catch (const js::NamedError& error) {
            type_error = error.name == "TypeError";
        }
        assert(type_error);
        // A listener asks during its own event.
        SDL_Event down{};
        down.type = SDL_EVENT_MOUSE_BUTTON_DOWN;
        down.button.windowID = SDL_GetWindowID(window);
        down.button.button = SDL_BUTTON_LEFT;
        down.button.down = true;
        down.button.x = 40;
        down.button.y = 40;
        const auto batch = pal::prepare_dom_platform_input(engine, down);
        assert(batch);
        {
            // The listener's loop checks in with its realm's event loop.
            const js::RealmScope scope;
            pal::EventLoop loop;
            pal::WorkerRealm realm(loop);
            loop.run([&] {
                dispatch_dom_batch(engine, batch);
                realm.close();
            });
        }
        assert(batch->ready());
        assert(ui_element(engine, log).text == "button|panel|null|canvas|button>panel>?>?|true");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}

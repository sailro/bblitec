#define main generated_main
#include "../../artifacts/dom-tree-reads/program.hpp"
#undef main
#include "../../artifacts/dom-tree-reads/visibility.hpp"
#include "pal_ui_rml.cpp"
#include "pal_platform_events.hpp"
#include <cassert>
#include <cstdio>

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
    loop.on_error([](std::exception_ptr error) { std::rethrow_exception(error); });
    loop.run([&] { initialize(realm); });
    return 0;
}
} // namespace bbl::pal

int run() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("DOM tree fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        auto& engine = pal::window_document_engine();
        // Tree, text, editability and conditional-owner reads threw on a wrong answer.
        assert(generated_main() == 0);
        const auto log = ui_get_element_by_id(engine, "log");
        const auto field = ui_get_element_by_id(engine, "field");
        assert(ui_element(engine, log).text == "1");
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        // select() selected the focused input's whole value in its projection.
        auto* input = dynamic_cast<Rml::ElementFormControlInput*>(
            runtime.projected_elements.at(field.value).element);
        assert(input);
        int start = -1, end = -1;
        Rml::String selected;
        input->GetSelection(&start, &end, &selected);
        assert(start == 0 && end == 5 && selected == "hello");
        const auto send = [&](SDL_Event event) {
            const auto batch = pal::prepare_dom_platform_input(engine, event);
            assert(batch);
            dispatch_dom_batch(engine, batch);
            assert(batch->ready());
            if (!batch->default_prevented)
                static_cast<void>(pal::handle_ui_rml_event(runtime, event));
            pal::update_ui_rml_runtime(runtime, 640, 480);
        };
        // The stored Event listener reads key through its asserted KeyboardEvent view.
        SDL_Event key{};
        key.type = SDL_EVENT_KEY_DOWN;
        key.key.windowID = SDL_GetWindowID(window);
        key.key.scancode = SDL_SCANCODE_ESCAPE;
        key.key.key = SDLK_ESCAPE;
        send(key);
        assert(ui_element(engine, log).text == "1K");
        // A pointer target narrowed to HTMLElement reads isContentEditable.
        SDL_Event down{};
        down.type = SDL_EVENT_MOUSE_BUTTON_DOWN;
        down.button.windowID = SDL_GetWindowID(window);
        down.button.button = SDL_BUTTON_LEFT;
        down.button.down = true;
        down.button.x = 50;
        down.button.y = 110;
        send(down);
        assert(ui_element(engine, log).text == "1KE");
        // The render canvas the document does not retain is not editable.
        down.button.x = 600;
        down.button.y = 400;
        send(down);
        assert(ui_element(engine, log).text == "1KE");
        // Window visibility updates document.hidden and dispatches once per change.
        SDL_Event shown{};
        for (const auto type :
             {SDL_EVENT_WINDOW_MINIMIZED, SDL_EVENT_WINDOW_HIDDEN, SDL_EVENT_WINDOW_RESTORED}) {
            shown.type = type;
            pal::handle_platform_event(shown, engine);
        }
        assert(ui_element(engine, log).text == "1KEHV" && !engine.document_hidden);
        // innerHTML content has no retained records to walk.
        const auto host = ui_create_element(engine, "div");
        ui_set_inner_rml(engine, host, "<span>markup</span>");
        const auto refuses = [](auto operation) {
            try {
                operation();
            } catch (const std::exception&) {
                return true;
            }
            return false;
        };
        assert(refuses([&] { static_cast<void>(ui_text_content(engine, host)); }));
        assert(refuses(
            [&] { static_cast<void>(ui_tree_element(engine, host, UiTreeRead::FirstChild)); }));
        assert(dom_target_is_node(dom_target_value(engine, DomEventTarget::document())));
        assert(!dom_target_is_node(dom_target_value(engine, DomEventTarget::window())));
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

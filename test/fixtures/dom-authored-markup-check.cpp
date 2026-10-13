#define main generated_main
#include "../../artifacts/dom-authored-markup/program.hpp"
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
    loop.on_error([](std::exception_ptr error) { std::rethrow_exception(error); });
    loop.run([&] { initialize(realm); });
    return 0;
}
} // namespace bbl::pal

int main() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("Authored markup fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        auto& engine = pal::window_document_engine();
        assert(generated_main() == 0);
        const auto panel = ui_get_element_by_id(engine, "panel");
        // The markup became retained elements and text nodes, not projected RML; leading text
        // is the leaf text that renders before the children.
        const auto& record = ui_element(engine, panel);
        assert(record.inner_rml.empty());
        assert(!record.text.empty() && record.text.find_first_not_of(" \n") == std::string::npos);
        std::string tags;
        for (const auto child : record.children)
            tags += ui_element(engine, child).tag + ";";
        assert(tags == "div;#text;div;#text;div;#text;label;#text;div;#text;div;");
        const auto title = record.children[0];
        assert(ui_element(engine, title).text == "Look & feel");
        const auto drop = record.children[2];
        assert(ui_text_content(engine, drop) == "Drop .cube files");
        assert(ui_element(engine, drop).text == "Drop " &&
               ui_element(engine, drop).children.size() == 2);
        const auto status = record.children.back();
        // Default value, selection and checkedness, the list's replaced content, and writes.
        assert(ui_element(engine, status).text == "DLW");
        const auto strength = ui_get_element_by_id(engine, "strength");
        const auto keep = ui_get_element_by_id(engine, "keep");
        assert(ui_active_element(engine) == strength);
        static_cast<void>(ui_get_client_rect(engine, keep));
        static_cast<void>(ui_get_client_rect(engine, panel));
        static_cast<void>(ui_get_client_rect(engine, title));

        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        // Whitespace between blocks renders nothing, as in browsers.
        assert(ui_element(engine, title).client_rect.top ==
               ui_element(engine, panel).client_rect.top);
        const auto send = [&](SDL_Event event) {
            const auto batch = pal::prepare_dom_platform_input(engine, event);
            assert(batch);
            dispatch_dom_batch(engine, batch);
            assert(batch->ready());
            if (!batch->default_prevented)
                static_cast<void>(pal::handle_ui_rml_event(runtime, event));
            pal::update_ui_rml_runtime(runtime, 640, 480);
        };
        // The focused markup range takes keyboard edits and dispatches its input listener.
        SDL_Event key{};
        key.type = SDL_EVENT_KEY_DOWN;
        key.key.windowID = SDL_GetWindowID(window);
        key.key.scancode = SDL_SCANCODE_END;
        key.key.key = SDLK_END;
        key.key.down = true;
        send(key);
        key.type = SDL_EVENT_KEY_UP;
        key.key.down = false;
        send(key);
        assert(std::stod(ui_get_form_value(engine, strength)) == 1);
        assert(ui_element(engine, status).text.starts_with("DLWI"));
        // The markup button's click listener runs and writes its disabled state.
        const auto rect = ui_get_client_rect(engine, keep);
        const float x = static_cast<float>(rect.left + 20), y = static_cast<float>(rect.top + 10);
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
        assert(ui_element(engine, status).text.ends_with("K"));
        assert(ui_has_attribute(engine, keep, "disabled"));
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}

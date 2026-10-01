#define main generated_main
#include "../../artifacts/dom-drag-events/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include "pal_platform_events.hpp"
#include <cassert>
#include <cstdio>

namespace bbl::pal {
bool save_file(Engine&, const FileDialogOptions&, std::span<const std::uint8_t>,
               const std::function<void()>&) {
    throw std::runtime_error("Unexpected fixture save dialog");
}
std::optional<SelectedFileSnapshot> choose_open_file(Engine&, const FileDialogOptions&) {
    throw std::runtime_error("Unexpected fixture open dialog");
}
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
    SDL_Window* window = SDL_CreateWindow("DOM drag fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        auto& engine = pal::window_document_engine();
        assert(generated_main() == 0);
        const auto log = ui_get_element_by_id(engine, "log");
        const auto root = ui_get_element_by_id(engine, "root");
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        // Window input prepares on the display and dispatches in the application's engine.
        Engine display;
        dom_input(display).event_types = engine.dom_input->event_types;
        dom_input(display).hit_path = engine.dom_input->hit_path;
        const auto send = [&](SDL_EventType type, float x = 50, const char* file = nullptr) {
            SDL_Event event{};
            event.type = type;
            event.drop.windowID = SDL_GetWindowID(window);
            event.drop.x = x;
            event.drop.y = 20;
            event.drop.data = file;
            auto batch = pal::prepare_dom_platform_input(display, event);
            if (batch) {
                dispatch_dom_batch(engine, batch);
                assert(batch->ready());
            }
            return batch;
        };
        const auto drop_files = [&](float x = 50) {
            send(SDL_EVENT_DROP_FILE, x, "artifacts/dom-drag-events/payload.txt");
            // Only the first index is represented; subsequent files contribute the count.
            send(SDL_EVENT_DROP_FILE, x, "artifacts/dom-drag-events/second.txt");
            return send(SDL_EVENT_DROP_COMPLETE);
        };
        send(SDL_EVENT_DROP_BEGIN);
        send(SDL_EVENT_DROP_POSITION);
        send(SDL_EVENT_DROP_POSITION);
        assert(ui_element(engine, log).text == "EOO");
        auto completed = drop_files();
        assert(completed && completed->default_prevented);
        assert(ui_element(engine, log).text == "EOOCpayload.txt:5:helloW");
        const auto& payload = std::get<PlatformDragEvent>(completed->events.front().payload);
        auto files = js::drag_files(engine, payload);
        assert(files.length() == 2);
        assert(js::file_at(files, 0) == js::file_at(js::drag_files(engine, payload), 0));
        assert(!js::file_at(files, 1));
        completed.reset();
        assert(js::file_name(engine, files.first) == "payload.txt");
        assert(js::file_size(engine, files.first) == 5);
        assert(js::file_text(engine, files.first) == "hello");
        Engine alien;
        bool refused = false;
        try {
            static_cast<void>(js::file_name(alien, files.first));
        } catch (const std::runtime_error&) {
            refused = true;
        }
        assert(refused);
        files = {};
        assert(engine.browser_file_storage->snapshot_count() == 0);
        // A platform without position notifications synthesizes dragover before completion.
        send(SDL_EVENT_DROP_BEGIN);
        assert(drop_files()->default_prevented);
        assert(ui_element(engine, log).text == "EOOCpayload.txt:5:helloWEOpayload.txt:5:helloW");
        // Enter precedes leave when a drag changes targets; passive cannot accept a drop.
        send(SDL_EVENT_DROP_BEGIN);
        send(SDL_EVENT_DROP_POSITION);
        send(SDL_EVENT_DROP_POSITION, 300);
        const auto before = ui_element(engine, log).text;
        assert(before.ends_with("EOeL"));
        drop_files(300);
        assert(ui_element(engine, log).text == before);
        // An aborted drag dispatches leave without exposing files.
        send(SDL_EVENT_DROP_BEGIN);
        send(SDL_EVENT_DROP_POSITION);
        send(SDL_EVENT_DROP_COMPLETE);
        assert(ui_element(engine, log).text == before + "EOL");
        // Removing the handler stops its cancellation and prevents a subsequent drop.
        set_dom_drag_handler(engine, DomEventTarget::node(root.value), "dragover", {});
        send(SDL_EVENT_DROP_BEGIN);
        send(SDL_EVENT_DROP_POSITION);
        drop_files();
        assert(ui_element(engine, log).text == before + "EOLEL");
        // Read failures remain explicit and bounds apply before accumulating an unbounded list.
        send(SDL_EVENT_DROP_BEGIN);
        refused = false;
        try {
            send(SDL_EVENT_DROP_FILE, 50, "artifacts/dom-drag-events/missing.txt");
        } catch (const std::runtime_error&) {
            refused = true;
        }
        assert(refused);
        display.dom_input->dropped_files.count = maximum_browser_file_snapshots;
        refused = false;
        try {
            send(SDL_EVENT_DROP_FILE, 50, "artifacts/dom-drag-events/payload.txt");
        } catch (const std::runtime_error&) {
            refused = true;
        }
        assert(refused);
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

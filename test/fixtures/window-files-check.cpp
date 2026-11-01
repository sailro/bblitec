#include "pal_ui_rml.cpp"
#include "pal_platform_events.hpp"
#include "window-frame-clock-fixture.hpp"
#include <cassert>
#include <filesystem>

namespace {
const auto display_thread = std::this_thread::get_id();
const auto file_path = std::filesystem::absolute("artifacts/window-files/selected.json");
int dialogs = 0;
bool done = false;

void push_click(float x) {
    SDL_Event event{};
    event.type = SDL_EVENT_MOUSE_MOTION;
    event.motion.which = bbl::pal::replay_ui_mouse_id;
    event.motion.x = x;
    event.motion.y = 35;
    assert(SDL_PushEvent(&event));
    event = {};
    event.type = SDL_EVENT_MOUSE_BUTTON_DOWN;
    event.button.which = bbl::pal::replay_ui_mouse_id;
    event.button.button = SDL_BUTTON_LEFT;
    event.button.down = true;
    event.button.x = x;
    event.button.y = 35;
    assert(SDL_PushEvent(&event));
    event.type = SDL_EVENT_MOUSE_BUTTON_UP;
    event.button.down = false;
    assert(SDL_PushEvent(&event));
}
} // namespace

static void fixture_file_dialog(SDL_FileDialogType, SDL_DialogFileCallback callback, void* data,
                                SDL_PropertiesID) {
    assert(std::this_thread::get_id() == display_thread);
    ++dialogs;
    if (dialogs == 3) {
        SDL_SetError("fixture dialog failure");
        callback(data, nullptr, 0);
        return;
    }
    const auto path = file_path.string();
    const char* files[] = {dialogs == 2 || dialogs == 5 ? nullptr : path.c_str(), nullptr};
    callback(data, files, 0);
}
#define SDL_ShowFileDialogWithProperties fixture_file_dialog
#include "pal_file.cpp"
#undef SDL_ShowFileDialogWithProperties

static SDL_Window* hidden_window(const char* title, int width, int height, SDL_WindowFlags flags) {
    return SDL_CreateWindow(title, width, height, flags | SDL_WINDOW_HIDDEN);
}
#define SDL_CreateWindow hidden_window
#define WindowFrameClock FixtureWindowFrameClock
#include "pal_window_realm.cpp"
#undef WindowFrameClock
#undef SDL_CreateWindow
#include "pal_media_query.cpp"
#include "window-frame-unit-fixture.hpp"

namespace bbl {
void set_canvas_dataset(Engine&, std::string, std::string) {
    throw std::runtime_error("Unexpected fixture dataset replay");
}
} // namespace bbl
namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char* name) {
    const std::string_view key(name);
    if (key == "BBLITE_TEST_PASS")
        return "1";
    if (key == "BBLITE_MAX_FRAMES")
        return "5000";
    return {};
}
double performance_milliseconds() { return 0; }
double monotonic_milliseconds() {
    return std::chrono::duration<double, std::milli>(EventLoop::Clock::now().time_since_epoch())
        .count();
}
const char* bblite_build_stamp() { return "fixture-build-stamp"; }
void report_build_stamp() {}
struct FilePresenter final : WindowPresenter {
    OffscreenDevice graphics;
    OffscreenDevice& device() override { return graphics; }
    bool can_present() override { return true; }
    bool present(std::span<const WindowCanvasFrame>, const UiRenderFrame&,
                 const std::string&) override {
        return true;
    }
};
std::shared_ptr<WindowPresenter> create_window_sdl_gpu_presenter(SDL_Window*) {
    return std::make_shared<FilePresenter>();
}
} // namespace bbl::pal

int main() {
    using namespace bbl;
    using namespace bbl::pal;
    const auto initialize = [](WorkerRealm& realm) {
        auto& engine = window_document_engine();
        const auto button = ui_create_element(engine, "button");
        ui_set_attribute(engine, button, "style",
                         "position:absolute;left:20px;top:20px;width:80px;height:30px;");
        ui_append_to_root(engine, button);
        ui_on_click(engine, button, [&realm] {
            assert(std::this_thread::get_id() != display_thread);
            auto& owner = window_document_engine();
            const js::Blob blob({js::blob_part_string("{\"parts\":[]}")}, "application/json");
            const auto url = js::create_object_url(owner, blob);
            const auto anchor = ui_create_element(owner, "a");
            ui_set_download_url(owner, anchor, url);
            ui_set_download_name(owner, anchor, "map.json");
            ui_click(owner, anchor);
            ui_click(owner, anchor); // Cancel leaves the successful export intact.
            bool failed = false;
            try {
                ui_click(owner, anchor);
            } catch (const std::runtime_error& error) {
                failed =
                    std::string(error.what()).find("fixture dialog failure") != std::string::npos;
            }
            assert(failed);
            js::revoke_object_url(owner, url);
            update_window_document(); // Revoked URLs on detached anchors cannot poison snapshots.
            const auto input = ui_create_element(owner, "input");
            ui_set_file_input(owner, input);
            ui_set_file_accept(owner, input, "application/json,.json");
            const auto changes = std::make_shared<int>(0);
            ui_on_event(owner, input, "change",
                        [input, changes, &realm](const PlatformMouseEvent&) {
                            assert(std::this_thread::get_id() != display_thread);
                            auto& document_engine = window_document_engine();
                            const auto selected =
                                handle_at(document_engine.ui_elements, input).selected_file;
                            assert(selected.get() &&
                                   std::string(selected.get()->bytes.begin(),
                                               selected.get()->bytes.end()) == "{\"parts\":[]}");
                            if (++*changes == 3) {
                                done = true;
                                realm.close();
                            }
                        });
            ui_click(owner, input);
            assert(*changes == 1);
            const auto selected = handle_at(owner.ui_elements, input).selected_file;
            ui_click(owner, input); // Cancel retains the selection, without change.
            assert(*changes == 1 &&
                   handle_at(owner.ui_elements, input).selected_file.get() == selected.get());
            ui_click(owner, input);
            assert(*changes == 2);
            // The display gets no realm callback, selected file, or object URL.
            const auto snapshot = snapshot_document(owner);
            assert(!snapshot->elements[input.value].file_change_callbacks);
            assert(!snapshot->elements[input.value].selected_file.get());
            assert(snapshot->elements[anchor.value].download_url.slot == invalid_handle);
            assert(snapshot->listeners[input.value].click);
            // Also activate an attached file input through the actual display -> realm path.
            ui_set_attribute(owner, input, "style",
                             "position:absolute;left:120px;top:20px;width:80px;height:30px;");
            ui_append_to_root(owner, input);
            update_window_document();
            submit_window_request(
                [](SDL_Window*, PageFullscreen&, Engine&) {
                    push_click(140);
                    return std::string();
                },
                [](const std::string& error) { assert(error.empty()); });
        });
        update_window_document();
        submit_window_request(
            [](SDL_Window*, PageFullscreen&, Engine&) {
                push_click(60);
                return std::string();
            },
            [](const std::string& error) { assert(error.empty()); });
    };
    EngineOptions options;
    options.width = 320;
    options.height = 200;
    assert(run_window_application(initialize, options) == 0);
    assert(done && dialogs == 7);
}

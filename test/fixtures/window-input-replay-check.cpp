// A Window display plays BBLITE_INPUT_REPLAY: every input entry reaches the realm's document
// listeners as a device's events do, one entry per presentation.
#include <SDL3/SDL.h>
#include <atomic>
#include <cassert>

namespace {
std::atomic<int> presentations = 0;
SDL_Window* hidden_window(const char* title, int width, int height, SDL_WindowFlags flags) {
    return SDL_CreateWindow(title, width, height, flags | SDL_WINDOW_HIDDEN);
}
} // namespace

#define SDL_CreateWindow hidden_window
#include "pal_ui_rml.cpp"
#include "window-frame-clock-fixture.hpp"
#define WindowFrameClock FixtureWindowFrameClock
#include "pal_window_realm.cpp"
#undef WindowFrameClock
#include "pal_media_query.cpp"
#include "window-frame-unit-fixture.hpp"

namespace bbl {
void set_canvas_dataset(Engine&, std::string, std::string) {
    throw std::runtime_error("Unexpected fixture dataset replay");
}
} // namespace bbl
namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected fixture asset"); }
std::string environment_variable(const char* name) {
    const std::string_view key(name);
    if (key == "BBLITE_TEST_PASS")
        return "1";
    if (key == "BBLITE_MAX_FRAMES")
        return "200";
    if (key == "BBLITE_INPUT_REPLAY")
        return "-,-,KeyA,+Space,-,-Space,Ctrl+KeyZ,UiKey@B,MouseLeft,+MouseRight,MouseMoveRight,"
               "-MouseRight,Enter";
    return {};
}
double performance_milliseconds() { return 0; }
double monotonic_milliseconds() {
    return std::chrono::duration<double, std::milli>(EventLoop::Clock::now().time_since_epoch())
        .count();
}
const char* bblite_build_stamp() { return "fixture-build-stamp"; }
void report_build_stamp() {}

struct CountingPresenter final : WindowPresenter {
    OffscreenDevice graphics;
    OffscreenDevice& device() override { return graphics; }
    bool can_present() override { return true; }
    bool present(std::span<const WindowCanvasFrame>, const UiRenderFrame&,
                 const std::string&) override {
        ++presentations;
        return true;
    }
};
std::shared_ptr<WindowPresenter> create_window_sdl_gpu_presenter(SDL_Window*) {
    return std::make_shared<CountingPresenter>();
}
} // namespace bbl::pal

namespace {
std::vector<std::string> received;
std::optional<int> first_presentation;
// The tape entry an event arrived with, counted in presentations from the first key's.
std::string entry() {
    const int now = presentations.load();
    if (!first_presentation)
        first_presentation = now;
    return std::to_string(2 + now - *first_presentation) + ' ';
}
} // namespace

int main() {
    using namespace bbl;
    using namespace bbl::pal;
    const auto initialize = [](WorkerRealm& realm) {
        auto& document = window_document_engine();
        const auto window = DomEventTarget::window();
        for (const char* type : {"keydown", "keyup"})
            on_dom_keyboard(document, window, type, 1,
                            [type, &realm](const PlatformKeyboardEvent& event) {
                                assert(!event.repeat);
                                received.push_back(entry() + type + ' ' + event.code + " '" +
                                                   event.key + (event.ctrl_key ? "' ctrl" : "'"));
                                if (event.code == "Enter" && std::string_view(type) == "keyup")
                                    realm.close();
                            });
        for (const char* type : {"pointerdown", "pointerup"})
            on_dom_pointer(document, window, type, 2, [type](const PlatformMouseEvent& event) {
                const auto viewport = window_viewport_size();
                assert(std::abs(event.client_x - viewport.width / 2) <= 1 &&
                       std::abs(event.client_y - viewport.height / 2) <= 1);
                received.push_back(entry() + type + ' ' +
                                   std::to_string(static_cast<int>(event.button)) + ' ' +
                                   std::to_string(static_cast<int>(event.buttons)));
            });
        // The display does not wait for a move's listeners, so a move carries no entry.
        on_dom_pointer(document, window, "pointermove", 3, [](const PlatformMouseEvent& event) {
            received.push_back("pointermove " + std::to_string(static_cast<int>(event.movement_x)) +
                               ' ' + std::to_string(static_cast<int>(event.buttons)));
        });
    };
    EngineOptions options;
    options.width = 320;
    options.height = 200;
    for (const bool display_clock : {false, true}) {
        FixtureWindowFrameClock::enabled = display_clock;
        received.clear();
        first_presentation.reset();
        assert(run_window_application(initialize, options) == 0);
        assert((received == std::vector<std::string>{
                                "2 keydown KeyA 'a'",
                                "2 keyup KeyA 'a'",
                                "3 keydown Space ' '",
                                "5 keyup Space ' '",
                                "6 keydown KeyZ 'z' ctrl",
                                "6 keyup KeyZ 'z' ctrl",
                                "7 keydown KeyB 'b'",
                                "7 keyup KeyB 'b'",
                                "8 pointerdown 0 1",
                                "8 pointerup 0 0",
                                "9 pointerdown 2 2",
                                "pointermove 100 2",
                                "11 pointerup 2 0",
                                "12 keydown Enter 'Enter'",
                                "12 keyup Enter 'Enter'",
                            }));
    }
}

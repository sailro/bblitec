#include "pal_ui_rml.cpp"
#include "window-frame-clock-fixture.hpp"
#include <cassert>
#include <cstdio>

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

namespace bbl::pal {
int fixture_run_window_application(WorkerEntry initialize, EngineOptions options);
}
#define run_window_application fixture_run_window_application
#define main generated_main
#include "../../artifacts/pointer-capture-window/program.hpp"
#undef main
#undef run_window_application

namespace bbl {
void set_canvas_dataset(Engine&, std::string, std::string) {
    throw std::runtime_error("Unexpected fixture dataset replay");
}
} // namespace bbl

namespace {
// Set by the realm's first animation frame: its document, listeners included,
// is on display, so input now reaches them.
std::atomic<bool> document_live = false;
bbl::pal::WorkerEntry program = nullptr;
// The program's trace, read on its realm as the page hides.
std::string final_log;

void push(SDL_Event event) { assert(SDL_PushEvent(&event)); }

void move(float x, float y, SDL_MouseButtonFlags state) {
    SDL_Event event{};
    event.type = SDL_EVENT_MOUSE_MOTION;
    event.motion.which = bbl::pal::replay_ui_mouse_id;
    event.motion.x = x;
    event.motion.y = y;
    event.motion.state = state;
    push(event);
}

void button(bool down, float x, float y) {
    SDL_Event event{};
    event.type = down ? SDL_EVENT_MOUSE_BUTTON_DOWN : SDL_EVENT_MOUSE_BUTTON_UP;
    event.button.which = bbl::pal::replay_ui_mouse_id;
    event.button.button = SDL_BUTTON_LEFT;
    event.button.down = down;
    event.button.x = x;
    event.button.y = y;
    push(event);
}

/** Window points: the program's panel, other and canvas boxes at any display scale up to 2. */
void push_gestures() {
    // The panel captures, the drag crosses `other`, leaves the window and is released outside.
    move(60, 60, 0);
    button(true, 60, 60);
    move(900, 60, SDL_BUTTON_LMASK);
    move(-50, -50, SDL_BUTTON_LMASK);
    SDL_Event leave{};
    leave.type = SDL_EVENT_WINDOW_MOUSE_LEAVE;
    push(leave);
    button(false, -50, -50);
    move(900, 60, 0);
    // A retained canvas captures through its on<event> handlers.
    move(60, 700, 0);
    button(true, 60, 700);
    move(900, 60, SDL_BUTTON_LMASK);
    button(false, 900, 60);
    // A stored element captures in a capture-phase listener.
    button(true, 900, 60);
    move(60, 60, SDL_BUTTON_LMASK);
    button(false, 60, 60);
}

void observed_program(bbl::pal::WorkerRealm& realm) {
    using namespace bbl;
    program(realm);
    auto& engine = pal::window_document_engine();
    realm.request_animation_frame([](double) { document_live.store(true); });
    on_dom_pointer(engine, DomEventTarget::window(), "pagehide", 0x7ace,
                   [](const PlatformMouseEvent&) {
                       auto& document = pal::window_document_engine();
                       final_log = ui_element(document, ui_get_element_by_id(document, "log")).text;
                   });
}
} // namespace

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char* name) {
    const std::string_view key(name);
    if (key == "BBLITE_TEST_PASS")
        return "1";
    if (key == "BBLITE_MAX_FRAMES")
        return "400";
    return {};
}
double performance_milliseconds() { return 0; }
double monotonic_milliseconds() {
    return std::chrono::duration<double, std::milli>(EventLoop::Clock::now().time_since_epoch())
        .count();
}
const char* bblite_build_stamp() { return "fixture-build-stamp"; }
void report_build_stamp() {}

struct GesturePresenter final : WindowPresenter {
    OffscreenDevice graphics;
    int live_presentations = 0;
    OffscreenDevice& device() override { return graphics; }
    bool can_present() override { return true; }
    bool present(std::span<const WindowCanvasFrame>, const UiRenderFrame&,
                 const std::string&) override {
        // One drain receives every gesture.
        if (document_live.load() && ++live_presentations == 6)
            push_gestures();
        return true;
    }
};
std::shared_ptr<WindowPresenter> create_window_sdl_gpu_presenter(SDL_Window*) {
    return std::make_shared<GesturePresenter>();
}

int fixture_run_window_application(WorkerEntry initialize, EngineOptions options) {
    program = initialize;
    return run_window_application(observed_program, std::move(options));
}
} // namespace bbl::pal

int main() {
    assert(generated_main() == 0);
    // Motion over the panel; the press captures it (D, h); gotpointercapture before the
    // captured motion over `other` and outside the window (G, m, m); the release outside
    // reaches the panel (W, U) and ends the capture (L); hover then reaches `other` (O, x).
    // The canvas captures (c) and keeps the motion (v) until its release (W, u, O). The
    // stored element refuses a detached capture (I) and an inactive pointer (N), then
    // keeps the motion over the panel (x) until its release (W).
    if (final_log != "mDhGmmWULOxcvWuOINxW") {
        std::fprintf(stderr, "pointer capture trace: %s\n", final_log.c_str());
        return 1;
    }
}

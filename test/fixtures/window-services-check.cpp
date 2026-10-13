#include "pal_ui_rml.cpp"
#include "pal_platform_events.hpp"
#include "window-frame-clock-fixture.hpp"
#include <cassert>
#include <string>
#include <utility>
#include <vector>

// The real Window host runs the generated program in a hidden window. The
// platform's message boxes and fullscreen requests are recorded: each message
// box answers by its text and drives the display (an Escape press, a replayed
// click, a refused fullscreen request).
namespace {
struct ShownBox {
    std::string title;
    std::string message;
    int buttons = 0;
    SDL_MessageBoxFlags flags = 0;
    bool return_default_ok = false;
    bool escape_default_cancel = false;
};
// Display-thread state.
std::vector<ShownBox> shown;
std::vector<bool> fullscreen_requests;
bool fail_next_fullscreen = false;
bool environment_phase = false;
int environment_reads = 0;
bool done = false;

void push_replayed_click(float x, float y) {
    SDL_Event event{};
    event.type = SDL_EVENT_MOUSE_MOTION;
    event.motion.which = bbl::pal::replay_ui_mouse_id;
    event.motion.x = x;
    event.motion.y = y;
    assert(SDL_PushEvent(&event));
    event = {};
    event.type = SDL_EVENT_MOUSE_BUTTON_DOWN;
    event.button.which = bbl::pal::replay_ui_mouse_id;
    event.button.button = SDL_BUTTON_LEFT;
    event.button.down = true;
    event.button.x = x;
    event.button.y = y;
    assert(SDL_PushEvent(&event));
    event.type = SDL_EVENT_MOUSE_BUTTON_UP;
    event.button.down = false;
    assert(SDL_PushEvent(&event));
}

void push_escape() {
    SDL_Event event{};
    event.type = SDL_EVENT_KEY_DOWN;
    event.key.which = ~0u;
    event.key.key = SDLK_ESCAPE;
    event.key.scancode = SDL_SCANCODE_ESCAPE;
    event.key.down = true;
    assert(SDL_PushEvent(&event));
}
} // namespace

static bool fixture_show_message_box(const SDL_MessageBoxData* data, int* button) {
    ShownBox box{data->title ? data->title : "<null>", data->message, data->numbuttons,
                 data->flags};
    for (int index = 0; index < data->numbuttons; ++index) {
        const auto& entry = data->buttons[index];
        if (entry.buttonID == 1 && (entry.flags & SDL_MESSAGEBOX_BUTTON_RETURNKEY_DEFAULT))
            box.return_default_ok = true;
        if ((entry.buttonID == 0 || data->numbuttons == 1) &&
            (entry.flags & SDL_MESSAGEBOX_BUTTON_ESCAPEKEY_DEFAULT))
            box.escape_default_cancel = true;
    }
    shown.push_back(box);
    const std::string message = data->message;
    if (message == "switch: environment")
        environment_phase = true;
    else if (message == "escape")
        push_escape();
    else if (message == "click")
        push_replayed_click(60, 35);
    else if (message == "fail-next")
        fail_next_fullscreen = true;
    else if (message == "done")
        done = true;
    // A closed box (the empty message) answers -1, as SDL does.
    *button = message.rfind("no:", 0) == 0 ? 0 : message.empty() ? -1 : 1;
    return true;
}

static bool fixture_set_window_fullscreen(SDL_Window* window, bool fullscreen) {
    fullscreen_requests.push_back(fullscreen);
    if (std::exchange(fail_next_fullscreen, false))
        return SDL_SetError("Fixture display refuses fullscreen");
    return SDL_SetWindowFullscreen(window, fullscreen);
}

static SDL_Window* hidden_window(const char* title, int width, int height, SDL_WindowFlags flags) {
    return SDL_CreateWindow(title, width, height, flags | SDL_WINDOW_HIDDEN);
}
#define SDL_CreateWindow hidden_window
#define SDL_ShowMessageBox fixture_show_message_box
#define SDL_SetWindowFullscreen fixture_set_window_fullscreen
#define WindowFrameClock FixtureWindowFrameClock
#include "pal_window_realm.cpp"
#undef WindowFrameClock
#undef SDL_SetWindowFullscreen
#undef SDL_ShowMessageBox
#undef SDL_CreateWindow
#include "pal_media_query.cpp"
#include "window-frame-unit-fixture.hpp"

#define main generated_main
#include "../../artifacts/window-services/program.hpp"
#undef main

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
    // Bounds a run whose program failed before closing its realm.
    if (key == "BBLITE_MAX_FRAMES")
        return "5000";
    // Two message boxes answer through the noninteractive switch.
    if (key == "BBLITE_MESSAGE_BOX_RESPONSE" && environment_phase) {
        if (++environment_reads == 2)
            environment_phase = false;
        return environment_reads == 1 ? "accept" : "dismiss";
    }
    return {};
}
double performance_milliseconds() { return 0; }
double monotonic_milliseconds() {
    return std::chrono::duration<double, std::milli>(EventLoop::Clock::now().time_since_epoch())
        .count();
}
const char* bblite_build_stamp() { return "fixture-build-stamp"; }
void report_build_stamp() {}

struct ServicesPresenter final : WindowPresenter {
    OffscreenDevice graphics;
    OffscreenDevice& device() override { return graphics; }
    bool can_present() override { return true; }
    bool present(std::span<const WindowCanvasFrame>, const UiRenderFrame&,
                 const std::string&) override {
        return true;
    }
};
std::shared_ptr<WindowPresenter> create_window_sdl_gpu_presenter(SDL_Window*) {
    return std::make_shared<ServicesPresenter>();
}
} // namespace bbl::pal

int main() try {
    assert(generated_main() == 0);
    if (!done) {
        for (const auto& box : shown)
            std::fprintf(stderr, "shown: '%s'\n", box.message.c_str());
        return 1;
    }
    const std::vector<std::pair<std::string, int>> expected{
        {"plain", 1},     {"yes: proceed?", 2},
        {"no: stop?", 2}, {"", 2},
        {"5", 1},         {"undefined", 1},
        {"", 2},          {"switch: environment", 2},
        {"click", 1},     {"Delete rule 1 (move)?", 2},
        {"escape", 1},    {"fail-next", 2},
        {"done", 1},
    };
    assert(shown.size() == expected.size());
    for (std::size_t index = 0; index < expected.size(); ++index) {
        const auto& box = shown[index];
        assert(box.message == expected[index].first);
        assert(box.buttons == expected[index].second);
        assert(box.title == "Window services fixture");
        assert(box.flags & SDL_MESSAGEBOX_INFORMATION);
        assert(box.flags & SDL_MESSAGEBOX_BUTTONS_LEFT_TO_RIGHT);
        assert(box.return_default_ok && box.escape_default_cancel);
    }
    // Enter; a repeated request keeps the window; Escape leaves; enter and exit;
    // enter and exit unobserved; a refused enter.
    assert((fullscreen_requests == std::vector<bool>{true, false, true, false, true, false, true}));
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
}

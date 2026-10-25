#include <SDL3/SDL.h>
#include <atomic>
#include <cassert>

namespace {
bool relative_mouse = false;
bool cursor_visible = true;
std::atomic<int> phase = 0;
std::atomic<bool> document_live = false;
int changes = 0;
int moves = 0;
bool set_relative(SDL_Window*, bool value) {
    relative_mouse = value;
    return true;
}
bool get_relative(SDL_Window*) { return relative_mouse; }
bool hide_cursor() {
    cursor_visible = false;
    return true;
}
bool show_cursor() {
    cursor_visible = true;
    return true;
}
bool visible_cursor() { return cursor_visible; }
SDL_Window* hidden_window(const char* title, int width, int height, SDL_WindowFlags flags) {
    return SDL_CreateWindow(title, width, height, flags | SDL_WINDOW_HIDDEN);
}
} // namespace

#define SDL_SetWindowRelativeMouseMode set_relative
#define SDL_GetWindowRelativeMouseMode get_relative
#define SDL_HideCursor hide_cursor
#define SDL_ShowCursor show_cursor
#define SDL_CursorVisible visible_cursor
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
    return {};
}
double performance_milliseconds() { return 0; }
double monotonic_milliseconds() {
    return std::chrono::duration<double, std::milli>(EventLoop::Clock::now().time_since_epoch())
        .count();
}
const char* bblite_build_stamp() { return "fixture-build-stamp"; }
void report_build_stamp() {}

struct PointerLockPresenter final : WindowPresenter {
    OffscreenDevice graphics;
    int sent = -1;
    int ready_frames = 0;
    OffscreenDevice& device() override { return graphics; }
    bool can_present() override { return true; }
    bool present(std::span<const WindowCanvasFrame>, const UiRenderFrame&,
                 const std::string&) override {
        if (!document_live.load() || ++ready_frames < 4)
            return true;
        const int current = phase.load();
        if (sent == current)
            return true;
        sent = current;
        if (current == 1 || current == 2 || current == 4 || current == 6) {
            assert(relative_mouse && !cursor_visible);
        }
        const auto button = [](bool down, Uint8 value, float x, float y) {
            SDL_Event event{};
            event.type = down ? SDL_EVENT_MOUSE_BUTTON_DOWN : SDL_EVENT_MOUSE_BUTTON_UP;
            event.button.which = replay_ui_mouse_id;
            event.button.button = value;
            event.button.down = down;
            event.button.x = x;
            event.button.y = y;
            assert(SDL_PushEvent(&event));
        };
        if (current == 0)
            button(true, SDL_BUTTON_RIGHT, 30, 30);
        else if (current == 1) {
            SDL_Event event{};
            event.type = SDL_EVENT_MOUSE_MOTION;
            event.motion.which = replay_ui_mouse_id;
            event.motion.x = 300;
            event.motion.y = 190;
            event.motion.xrel = 20;
            // Windows relative packets may omit held buttons.
            event.motion.state = 0;
            assert(SDL_PushEvent(&event));
        } else if (current == 2)
            button(false, SDL_BUTTON_RIGHT, 300, 190);
        else if (current == 3 || current == 5) {
            assert(!relative_mouse && cursor_visible);
            button(true, SDL_BUTTON_LEFT, 30, 30);
            button(false, SDL_BUTTON_LEFT, 30, 30);
        } else if (current == 4 || current == 6) {
            SDL_Event event{};
            event.type = current == 4 ? SDL_EVENT_KEY_DOWN : SDL_EVENT_WINDOW_FOCUS_LOST;
            if (current == 4) {
                event.key.which = ~0u;
                event.key.scancode = SDL_SCANCODE_ESCAPE;
                event.key.key = SDLK_ESCAPE;
                event.key.down = true;
            }
            assert(SDL_PushEvent(&event));
        }
        return true;
    }
};
std::shared_ptr<WindowPresenter> create_window_sdl_gpu_presenter(SDL_Window*) {
    return std::make_shared<PointerLockPresenter>();
}
} // namespace bbl::pal

int main() {
    using namespace bbl;
    using namespace bbl::pal;
    const auto initialize = [](WorkerRealm& realm) {
        auto& document = window_document_engine();
        const auto canvas = ui_create_element(document, "canvas");
        ui_set_attribute(document, canvas, "style",
                         "position:absolute;left:0;top:0;width:120px;height:100px;");
        ui_append_to_root(document, canvas);
        auto engine = std::make_shared<Engine>();
        engine->realm_owner = engine;
        bind_canvas_engine(window_canvas(canvas), engine);
        const auto request = [engine](bool locked) {
            engine->pointer_lock_requested = locked;
            engine->request_platform_pointer_lock(locked);
        };
        engine->pointer_lock_change_callbacks.add(1,
                                                  [owner = std::weak_ptr<Engine>(engine), &realm] {
                                                      const auto engine = owner.lock();
                                                      assert(engine);
                                                      ++changes;
                                                      if (changes == 1) {
                                                          assert(engine->pointer_locked);
                                                          phase = 1;
                                                      } else if (changes == 2) {
                                                          assert(!engine->pointer_locked);
                                                          phase = 3;
                                                      } else if (changes == 3) {
                                                          assert(engine->pointer_locked);
                                                          phase = 4;
                                                      } else if (changes == 4) {
                                                          assert(!engine->pointer_locked);
                                                          phase = 5;
                                                      } else if (changes == 5) {
                                                          assert(engine->pointer_locked);
                                                          phase = 6;
                                                      } else if (changes == 6) {
                                                          assert(!engine->pointer_locked);
                                                          phase = 7;
                                                          realm.close();
                                                      } else
                                                          assert(false);
                                                  });
        const auto target = DomEventTarget::node(canvas.value);
        on_dom_pointer(document, target, "pointerdown", 2,
                       [request](const PlatformMouseEvent& event) {
                           if (event.button == 2) {
                               request(true);
                               event.prevent_default();
                           }
                       });
        on_dom_pointer(document, target, "pointerup", 3,
                       [request](const PlatformMouseEvent& event) {
                           if (event.button == 2)
                               request(false);
                       });
        on_dom_pointer(document, target, "click", 4,
                       [request](const PlatformMouseEvent&) { request(true); });
        on_dom_pointer(
            document, target, "pointermove", 5, [engine](const PlatformMouseEvent& event) {
                if (phase.load() != 1)
                    return;
                assert(engine->pointer_locked && event.buttons == 2 && event.movement_x == 20);
                ++moves;
                phase = 2;
            });
        realm.request_animation_frame([](double) { document_live = true; });
    };
    EngineOptions options;
    options.width = 320;
    options.height = 200;
    assert(run_window_application(initialize, options) == 0);
    assert(phase.load() == 7 && changes == 6 && moves == 1);
    assert(!relative_mouse && cursor_visible);
}

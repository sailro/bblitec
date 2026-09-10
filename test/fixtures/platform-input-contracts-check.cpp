#define SDL_STATIC_LIB
#include "pal_sdl.cpp"
namespace bbl::pal { void apply_canvas_cursor(Engine&); }
#include "pal_platform_events.hpp"
#include "pal_frame_conductor.hpp"
#include <cassert>

// Observe OS pointer-lock requests without taking the user's pointer.
bool relative_mouse = false, cursor_visible = true;
extern "C" bool SDLCALL SDL_SetWindowRelativeMouseMode(SDL_Window*, bool enabled) { relative_mouse = enabled; return true; }
extern "C" bool SDLCALL SDL_GetWindowRelativeMouseMode(SDL_Window*) { return relative_mouse; }
extern "C" bool SDLCALL SDL_HideCursor() { cursor_visible = false; return true; }
extern "C" bool SDLCALL SDL_ShowCursor() { cursor_visible = true; return true; }

namespace bbl {
void set_canvas_dataset(Engine&, std::string, std::string) { assert(false); }
}
namespace bbl::pal {
std::string replay_source;
std::vector<std::string> calls;
bool consume_ui = false;
int cursor_updates = 0;
std::string environment_variable(const char* name) { return std::string_view(name) == "BBLITE_INPUT_REPLAY" ? replay_source : ""; }
double monotonic_milliseconds() { return 0; }
void apply_canvas_cursor(Engine&) { ++cursor_updates; }
bool handle_ui_rml_event(int&, SDL_Event&) { calls.push_back("ui"); return !consume_ui; }
void dispatch_surface_camera_pointer(Engine&, const SDL_Event&, int&, int&, int&) { calls.push_back("camera"); }
struct InputState {
    SDL_Window* window;
    unsigned surface_width = 640, surface_height = 480;
    struct { SDL_Window* window; } gpu{window};
};
bool resize_dawn_surface(InputState&, const EngineOptions&) { return false; }
void recreate_dawn_scene_targets(InputState&, Scene&, unsigned, unsigned) { assert(false); }
void build_graph(InputState&, Engine&, unsigned, unsigned) { assert(false); }
bool request_renderer_restart_if_scene_set_changed(Engine&, const std::vector<std::shared_ptr<Scene>>&) { return false; }
struct InputDriver {
    Engine engine;
    PlatformInputReplay input_replay;
    bool running = true;
    long frame = 0;
    struct { bool test_pass = false; } frame_options;
    SDL_Window* window;
    InputState state;
    int ui = 0;
    int* ui_runtime = &ui;
    struct { InputState& state; int* ui_runtime; } resources{state, &ui};
    unsigned width = 640, height = 480;
    Scene scene;
    std::vector<std::shared_ptr<Scene>> active_registered_scenes;
    int camera_value = 0;
    int* camera = &camera_value;
    int pointer_state = 0, surface_pointer_state = 0;
    explicit InputDriver(SDL_Window* target) : window(target), state{target} {
        sync_engine_canvas_size(window, engine);
    }
    void recreate_msaa_target() { assert(false); }
    InputDriver& fixture() { return *this; }
};
struct SceneInputDriver {
    InputDriver data_;
    struct Frame { double start = 0; };
    std::optional<Frame> frame_;
    explicit SceneInputDriver(SDL_Window* target) : data_(target) {}
    InputDriver& fixture() { return data_; }
};
#include "drivers.hpp"
}

namespace {
using namespace bbl;
using namespace bbl::pal;
SDL_Window* window;
void queue_key(SDL_Scancode code, bool down, bool replayed = false) {
    SDL_Event event{};
    event.type = down ? SDL_EVENT_KEY_DOWN : SDL_EVENT_KEY_UP;
    event.key.windowID = SDL_GetWindowID(window);
    event.key.scancode = code;
    event.key.which = replayed ? ~0u : 0;
    event.key.mod = SDL_KMOD_CTRL;
    event.key.repeat = true;
    assert(SDL_PushEvent(&event));
}
void queue_pointer(Uint32 type, float x = 20, Uint8 button = SDL_BUTTON_LEFT) {
    SDL_Event event{};
    event.type = type;
    if (type == SDL_EVENT_MOUSE_MOTION) {
        event.motion.windowID = SDL_GetWindowID(window);
        event.motion.x = x; event.motion.y = 30;
        event.motion.xrel = 4; event.motion.yrel = -5;
        event.motion.state = 0; // The ordered button stream is authoritative.
    } else {
        event.button.windowID = SDL_GetWindowID(window);
        event.button.button = button;
        event.button.down = type == SDL_EVENT_MOUSE_BUTTON_DOWN;
        event.button.x = x; event.button.y = 30;
    }
    assert(SDL_PushEvent(&event));
}
template <typename Driver> void exercise(int index) {
    replay_source.clear();
    Driver driver(window);
    auto& state = driver.fixture();
    auto& engine = state.engine;
    SDL_FlushEvents(SDL_EVENT_FIRST, SDL_EVENT_LAST);
    tracked_mouse_buttons() = 0;
    calls.clear(); cursor_updates = 0; consume_ui = false;
    const bool scene = index < 2;
    const bool ui = BBLITE_HAS_UI && index < 4;
    bool prevent_key = false;
    std::vector<std::string> keys;
    std::vector<double> moves, wheels;
    int downs = 0, clicks = 0, resizes = 0;
    engine.key_down_callbacks.add(1, [&](const PlatformKeyboardEvent& event) {
        calls.push_back("key"); keys.push_back(event.code + ":" + event.key);
        if (event.code != "Escape") assert(event.ctrl_key && event.repeat);
        if (prevent_key) event.prevent_default();
    });
    engine.key_up_callbacks.add(1, [&](const PlatformKeyboardEvent&) { calls.push_back("up"); });
    engine.mouse_move_callbacks.add(1, [&](const PlatformMouseEvent& event) {
        moves.push_back(event.buttons); assert(event.client_x == 20 && event.client_y == 30);
        assert(event.movement_x == 4 && event.movement_y == -5);
    });
    engine.mouse_wheel_callbacks.add(1, [&](const PlatformMouseEvent& event) { wheels.push_back(event.delta_y); });
    engine.pointer_down_callbacks.add(1, [&] { ++downs; });
    engine.canvas_click_callbacks.add(1, [&] { ++clicks; });
    engine.window_resize_callbacks.add(1, [&] { ++resizes; });
    queue_key(SDL_SCANCODE_SPACE, true); queue_key(SDL_SCANCODE_F3, false);
    assert(driver.prepare() == FramePreparation::ready);
    std::vector<std::string> expected{"key"};
    if (ui) expected.push_back("ui"); if (scene) expected.push_back("camera");
    expected.push_back("up");
    if (ui) expected.push_back("ui"); if (scene) expected.push_back("camera");
    assert(calls == expected && keys == std::vector<std::string>{"Space: "});
    assert(cursor_updates == 0);
    calls.clear(); prevent_key = true;
    queue_key(SDL_SCANCODE_F3, true);
    assert(driver.prepare() == FramePreparation::ready);
    assert(calls == std::vector<std::string>{"key"});
    assert(keys.back() == "F3:F3");
    prevent_key = false; calls.clear();
    state.frame_options.test_pass = true;
    queue_key(SDL_SCANCODE_SPACE, true); queue_key(SDL_SCANCODE_F3, true, true);
    assert(driver.prepare() == FramePreparation::ready);
    assert(keys.size() == 3 && keys.back() == "F3:F3");
    state.frame_options.test_pass = false;
    calls.clear(); consume_ui = true;
    queue_pointer(SDL_EVENT_MOUSE_MOTION);
    assert(driver.prepare() == FramePreparation::ready);
    assert(moves.size() == (ui ? 0u : 1u));
    if (ui) { assert(calls == std::vector<std::string>{"ui"}); assert(cursor_updates == 0); }
    consume_ui = false; moves.clear(); calls.clear(); cursor_updates = 0;
    queue_pointer(SDL_EVENT_MOUSE_BUTTON_DOWN);
    queue_pointer(SDL_EVENT_MOUSE_MOTION);
    queue_pointer(SDL_EVENT_MOUSE_BUTTON_UP);
    queue_pointer(SDL_EVENT_MOUSE_BUTTON_DOWN, -1);
    queue_pointer(SDL_EVENT_MOUSE_BUTTON_UP, -1);
    queue_pointer(SDL_EVENT_MOUSE_BUTTON_DOWN, 20, SDL_BUTTON_RIGHT);
    queue_pointer(SDL_EVENT_MOUSE_MOTION);
    queue_pointer(SDL_EVENT_MOUSE_BUTTON_UP, 20, SDL_BUTTON_RIGHT);
    assert(driver.prepare() == FramePreparation::ready);
    assert((moves == std::vector<double>{1,2}));
    assert(downs == 2 && clicks == 1 && cursor_updates == 8);
    SDL_Event wheel{}; wheel.type = SDL_EVENT_MOUSE_WHEEL;
    wheel.wheel.windowID = SDL_GetWindowID(window);
    wheel.wheel.y = 1; wheel.wheel.mouse_x = 20; wheel.wheel.mouse_y = 30;
    assert(SDL_PushEvent(&wheel));
    wheel.wheel.direction = SDL_MOUSEWHEEL_FLIPPED;
    assert(SDL_PushEvent(&wheel));
    assert(driver.prepare() == FramePreparation::ready);
    assert((wheels == std::vector<double>{-100,100}));
    // Each driver executes its replay dispatch after draining live packets.
    replay_source = "WheelUp,WheelDown"; state.input_replay = PlatformInputReplay{};
    ++state.frame; assert(driver.prepare() == FramePreparation::ready);
    ++state.frame; assert(driver.prepare() == FramePreparation::ready);
    assert((wheels == std::vector<double>{-100,100,-100,100}));
    replay_source.clear(); state.input_replay = PlatformInputReplay{};
    engine.options.width = 1; engine.options.height = 1;
    engine.canvas_client_width = 1; engine.canvas_client_height = 1;
    SDL_Event resize{}; resize.type = SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED;
    resize.window.windowID = SDL_GetWindowID(window); assert(SDL_PushEvent(&resize));
    assert(driver.prepare() == FramePreparation::ready);
    assert(engine.options.width == 640 && engine.options.height == 480 && resizes == 1);
    int lock_changes = 0;
    engine.pointer_lock_change_callbacks.add(1, [&] { ++lock_changes; });
    const auto lock = [&] {
        engine.pointer_lock_requested = true;
        sync_pointer_lock(window, engine);
        assert(engine.pointer_locked && relative_mouse && !cursor_visible);
        assert(std::string(SDL_GetHint(SDL_HINT_MOUSE_RELATIVE_SYSTEM_SCALE)) == "1");
    };
    lock();
    queue_key(SDL_SCANCODE_ESCAPE, true);
    assert(driver.prepare() == FramePreparation::ready);
    assert(!engine.pointer_locked && !engine.pointer_lock_requested && !relative_mouse && cursor_visible);
    lock();
    replay_source = "Escape"; state.input_replay = PlatformInputReplay{};
    engine.input_replay_next_frame = 0;
    ++state.frame; assert(driver.prepare() == FramePreparation::ready);
    assert(!engine.pointer_locked && !engine.pointer_lock_requested && !relative_mouse && cursor_visible);
    assert(lock_changes == 4);
    replay_source.clear(); state.input_replay = PlatformInputReplay{};
    for (const Uint32 type : {SDL_EVENT_WINDOW_CLOSE_REQUESTED, SDL_EVENT_QUIT}) {
        state.running = true;
        SDL_Event close{}; close.type = type; assert(SDL_PushEvent(&close));
        assert(driver.prepare() == FramePreparation::ready && !state.running);
    }
}
}
int main() {
    SDL_SetAssertionHandler([](const SDL_AssertData* data, void*) {
        std::cerr << "SDL assertion: " << data->condition << '\n'; return SDL_ASSERTION_ABORT;
    }, nullptr);
    assert(SDL_Init(SDL_INIT_VIDEO));
    window = SDL_CreateWindow("Input fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
#include "exercise.hpp"
    SDL_DestroyWindow(window); SDL_Quit();
}

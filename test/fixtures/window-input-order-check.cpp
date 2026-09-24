#define BBLITE_WORKERS 1
#define BBLITE_OFFSCREEN_SURFACES 1
#define BBLITE_HAS_DOM_INPUT 1
#define BBLITE_HAS_SDL_GPU 1
#define BBLITE_HAS_DAWN 0
#define BBLITE_HAS_PBR_RENDERER 0
#include "pal_ui_rml.cpp"
#include "window-frame-clock-fixture.hpp"
#include <cassert>

namespace {
std::atomic<int> native_pointer_down = 0;
}
static bool tracked_ui_event(bbl::pal::UiRmlRuntime& runtime, SDL_Event& event) {
    if (event.type == SDL_EVENT_MOUSE_BUTTON_DOWN)
        ++native_pointer_down;
    return bbl::pal::handle_ui_rml_event(runtime, event);
}

static SDL_Window* hidden_window(const char* title, int width, int height, SDL_WindowFlags flags) {
    return SDL_CreateWindow(title, width, height, flags | SDL_WINDOW_HIDDEN);
}
#define SDL_CreateWindow hidden_window
#define handle_ui_rml_event tracked_ui_event
#define WindowFrameClock FixtureWindowFrameClock
#include "pal_window_realm.cpp"
#undef WindowFrameClock
#undef SDL_CreateWindow
#undef handle_ui_rml_event
#include "pal_media_query.cpp"

namespace bbl {
void set_canvas_dataset(Engine&, std::string, std::string) {
    throw std::runtime_error("Unexpected fixture dataset replay");
}
} // namespace bbl

namespace {
std::atomic<int> input_phase = 0;
std::atomic<int> pending_presentations = 0;
// Set by the realm's first animation frame: its document, listeners included,
// was published before that callback could run, so input now reaches them.
std::atomic<bool> document_live = false;
int animation_count = 0;
int animation_at_down = 0;
bool clicked = false;
bool dom_clicked = false;
bool prevent_down = false;
int moved = 0;
constexpr int motion_count = 32;
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
        return "100";
    return {};
}
double performance_milliseconds() { return 0; }
double monotonic_milliseconds() {
    return std::chrono::duration<double, std::milli>(EventLoop::Clock::now().time_since_epoch())
        .count();
}
const char* bblite_build_stamp() { return "fixture-build-stamp"; }

struct InputOrderPresenter final : WindowPresenter {
    OffscreenDevice graphics;
    int live_presentations = 0;
    OffscreenDevice& device() override { return graphics; }
    bool can_present() override { return true; }
    bool present(std::span<const WindowCanvasFrame>, const UiRenderFrame&,
                 const std::string&) override {
        if (input_phase.load() == 1)
            ++pending_presentations;
        // One drain receives the whole gesture: every event is queued here,
        // before the host polls again.
        if (document_live.load() && ++live_presentations == 6) {
            SDL_Event event{};
            event.type = SDL_EVENT_MOUSE_MOTION;
            event.motion.which = replay_ui_mouse_id;
            event.motion.x = 30;
            event.motion.y = 30;
            assert(SDL_PushEvent(&event));
            event = {};
            event.type = SDL_EVENT_MOUSE_BUTTON_DOWN;
            event.button.which = replay_ui_mouse_id;
            event.button.button = SDL_BUTTON_LEFT;
            event.button.down = true;
            event.button.x = 30;
            event.button.y = 30;
            assert(SDL_PushEvent(&event));
            for (int move = 0; move < motion_count; ++move) {
                event = {};
                event.type = SDL_EVENT_MOUSE_MOTION;
                event.motion.which = replay_ui_mouse_id;
                event.motion.x = static_cast<float>(30 + move % 2);
                event.motion.y = 30;
                event.motion.state = SDL_BUTTON_LMASK;
                assert(SDL_PushEvent(&event));
            }
            event = {};
            event.type = SDL_EVENT_MOUSE_BUTTON_UP;
            event.button.which = replay_ui_mouse_id;
            event.button.button = SDL_BUTTON_LEFT;
            event.button.x = 30;
            event.button.y = 30;
            assert(SDL_PushEvent(&event));
        }
        return true;
    }
};
std::shared_ptr<WindowPresenter> create_window_sdl_presenter(SDL_Window*) {
    return std::make_shared<InputOrderPresenter>();
}
} // namespace bbl::pal

int main() {
    using namespace bbl;
    using namespace bbl::pal;
    {
        Engine source, display;
        const auto label = ui_create_element(source, "span");
        ui_set_text(source, label, "First");
        ui_append_to_root(source, label);
        ui_element(source, label).click_callbacks.push_back([] {});
        apply_document(display, std::move(*snapshot_document(source)), {});
        const auto since = source.ui_text_revision;
        const auto revision = source.ui_revision;
        ui_set_text(source, label, "Intermediate");
        ui_set_text(source, label, "Latest");
        assert(source.ui_only_text_changed_since(revision, since));
        auto snapshot = snapshot_document(source, since);
        assert(snapshot->text_updates && snapshot->text_updates->size() == 1);
        assert(snapshot->elements.empty() && snapshot->listeners.empty() &&
               snapshot->styles.empty());
        apply_document(display, std::move(*snapshot), {});
        assert(ui_element(display, label).text == "Latest");
        assert(ui_element(display, label).click_callbacks.size() == 1);
        assert(display.ui_text_revision == 1);
        ui_set_attribute(source, label, "class", "changed");
        assert(!source.ui_only_text_changed_since(revision, since));
        apply_document(display, std::move(*snapshot_document(source)), {});
        assert(ui_element(display, label).attributes.at("class") == "changed");
        assert(ui_element(display, label).text_revision == 0);
        const auto full_revision = display.ui_revision;
        ui_set_text(display, label, "After full snapshot");
        assert(display.ui_only_text_changed_since(full_revision, 1));
        assert(ui_element(display, label).text_revision == 2);
    }
    const auto initialize = [](WorkerRealm& realm) {
        auto& engine = window_document_engine();
        const auto button = ui_create_element(engine, "button");
        ui_set_attribute(engine, button, "style",
                         "position:absolute;left:20px;top:20px;width:80px;height:30px;");
        ui_set_text(engine, button, "Click");
        ui_append_to_root(engine, button);
        const auto frame = std::make_shared<EventLoop::AnimationCallback>();
        *frame = [&realm, weak = std::weak_ptr(frame)](double) {
            document_live.store(true);
            ++animation_count;
            if (const auto next = weak.lock())
                realm.request_animation_frame(*next);
        };
        realm.request_animation_frame(*frame);
        on_dom_pointer(engine, DomEventTarget::node(button.value), "pointerdown", 1,
                       [button, frame](const PlatformMouseEvent& pointer) {
                           animation_at_down = animation_count;
                           input_phase.store(1);
                           if (prevent_down)
                               pointer.prevent_default();
                           // Repeated synchronous layout reads must complete without
                           // presenting or advancing RAF during the input transaction.
                           for (int update = 0; update < 5; ++update) {
                               ui_set_text(window_document_engine(), button,
                                           std::to_string(update));
                               const auto bounds = window_element_size(button);
                               assert(bounds.width == 80);
                           }
                           // The following packets must see a newly added listener even
                           // before another document snapshot is published.
                           on_dom_pointer(window_document_engine(), DomEventTarget::window(),
                                          "pointermove", 3, [](const PlatformMouseEvent& event) {
                                              assert(event.client_x == 30 + moved % 2);
                                              ++moved;
                                          });
                       });
        const auto finish = [&realm] {
            input_phase.store(2);
            clicked = true;
            realm.close();
        };
        on_dom_pointer(engine, DomEventTarget::node(button.value), "click", 2,
                       [finish](const PlatformMouseEvent&) {
                           assert(input_phase.load() == 1 && animation_count == animation_at_down);
                           assert(moved == motion_count);
                           assert(native_pointer_down.load() == (prevent_down ? 0 : 1));
                           assert(!dom_clicked);
                           dom_clicked = true;
                           // A prevented pointerdown never reaches the native button,
                           // so its default action (below) does not run.
                           if (prevent_down)
                               finish();
                       });
        // The button's native default runs its click callbacks after the DOM
        // click. A slow realm widens the window in which a display that did not
        // wait for them would present or advance repaint.
        ui_on_click(engine, button, [finish] {
            assert(!prevent_down && dom_clicked);
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
            assert(input_phase.load() == 1 && animation_count == animation_at_down);
            finish();
        });
    };
    EngineOptions options;
    options.width = 320;
    options.height = 200;
    for (const bool display_clock : {false, true}) {
        FixtureWindowFrameClock::enabled = display_clock;
        for (const bool prevent : {false, true}) {
            prevent_down = prevent;
            input_phase = 0;
            pending_presentations = 0;
            native_pointer_down = 0;
            animation_count = 0;
            moved = 0;
            clicked = false;
            dom_clicked = false;
            document_live = false;
            assert(run_window_application(initialize, options) == 0);
            assert(clicked && pending_presentations == 0);
        }
    }
}

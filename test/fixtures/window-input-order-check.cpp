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
#include "window-frame-unit-fixture.hpp"

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
// Visibility the realm's document recorded at each visibilitychange.
std::vector<bool> visibility_changes;
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
void report_build_stamp() {}

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
            // Minimizing and restoring reach the realm's document before the gesture.
            for (const auto type :
                 {SDL_EVENT_WINDOW_MINIMIZED, SDL_EVENT_WINDOW_HIDDEN, SDL_EVENT_WINDOW_RESTORED}) {
                event = {};
                event.type = type;
                assert(SDL_PushEvent(&event));
            }
            event = {};
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
std::shared_ptr<WindowPresenter> create_window_sdl_gpu_presenter(SDL_Window*) {
    return std::make_shared<InputOrderPresenter>();
}

static void check_host_metrics(UiElementHandle canvas) {
    auto& doc = current_document();
    auto& host = *doc.host;
    update_window_document();
    const auto adopted = doc.layout;
    assert(adopted);
    const auto previous_box = ui_element(doc.engine, canvas).client_rect;
    auto latest = std::make_shared<LayoutSnapshot>(*adopted);
    latest->width = 960;
    latest->height = 540;
    latest->pixel_ratio = 2;
    latest->input = {PointerPrecision::Coarse, false};
    latest->rectangles[canvas.value] = {150, 50, 160, 90};
    std::uint64_t requested = 0;
    {
        // The host is awaiting this input transaction. With no pending
        // document, its independently published metrics remain stable.
        std::lock_guard lock(host.mutex);
        assert(!host.pending);
        requested = host.requested;
        host.layout = latest;
    }
    assert(window_device_pixel_ratio() == 2);
    const auto viewport = window_viewport_size();
    assert(viewport.width == 480 && viewport.height == 270);
    assert(window_input_capabilities() == latest->input);
    assert(doc.layout == adopted);
    const auto unchanged = ui_element(doc.engine, canvas).client_rect;
    assert(unchanged.left == previous_box.left && unchanged.top == previous_box.top &&
           unchanged.width == previous_box.width && unchanged.height == previous_box.height);
    update_window_document();
    assert(doc.layout == latest);
    const auto updated = ui_element(doc.engine, canvas).client_rect;
    assert(updated.left == 150 && updated.top == 50 && updated.width == 160 &&
           updated.height == 90);
    {
        std::lock_guard lock(host.mutex);
        assert(host.requested == requested && !host.pending);
        host.layout = adopted;
    }
    update_window_document();

    const auto published_canvas_revision = doc.published_canvas_revision;
    for (int stroke = 0; stroke < 54; ++stroke) {
        ui_canvas_begin_path(doc.engine, canvas);
        ui_canvas_move_to(doc.engine, canvas, 0, stroke);
        ui_canvas_line_to(doc.engine, canvas, 40, stroke);
        ui_canvas_stroke(doc.engine, canvas);
        assert(window_device_pixel_ratio() == adopted->pixel_ratio);
        const auto size = window_viewport_size();
        assert(size.width == std::round(adopted->width / adopted->pixel_ratio) &&
               size.height == std::round(adopted->height / adopted->pixel_ratio));
        assert(window_input_capabilities() == adopted->input);
        assert(doc.published_canvas_revision == published_canvas_revision);
        std::lock_guard lock(host.mutex);
        assert(host.requested == requested && !host.pending);
    }
    assert(ui_element(doc.engine, canvas).canvas->draws.size() == 54);
    update_window_document();
    assert(doc.published_canvas_revision == doc.engine.ui_canvas_revision);
    std::lock_guard lock(host.mutex);
    assert(host.requested == requested + 1 && host.completed == host.requested);
}
} // namespace bbl::pal

int main() {
    using namespace bbl;
    using namespace bbl::pal;
    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* canvas_window = SDL_CreateWindow("Canvas input routing", 320, 240, SDL_WINDOW_HIDDEN);
    assert(canvas_window);
    {
        Engine engine;
        const auto canvas = ui_create_element(engine, "canvas");
        ui_element(engine, canvas).external_gpu_canvas = true;
        ui_set_attribute(
            engine, canvas, "style",
            "position:absolute;left:0px;top:0px;width:100px;height:100px;pointer-events:auto;");
        ui_append_to_root(engine, canvas);
        const auto button = ui_create_element(engine, "button");
        ui_set_attribute(
            engine, button, "style",
            "position:absolute;left:120px;top:0px;width:100px;height:100px;pointer-events:auto;");
        ui_append_to_root(engine, button);
        const auto overlay = ui_create_element(engine, "canvas");
        ui_set_attribute(
            engine, overlay, "style",
            "position:absolute;left:240px;top:0px;width:80px;height:100px;pointer-events:auto;");
        ui_append_to_root(engine, overlay);
        UiRmlRuntime runtime(engine, canvas_window, 320, 240);
        update_ui_rml_runtime(runtime, 320, 240);
        SDL_Event event{};
        event.type = SDL_EVENT_MOUSE_MOTION;
        event.motion.x = 25;
        event.motion.y = 25;
        assert(handle_ui_rml_event(runtime, event));
        event = {};
        event.type = SDL_EVENT_MOUSE_BUTTON_DOWN;
        event.button.button = SDL_BUTTON_LEFT;
        event.button.down = true;
        event.button.x = 25;
        event.button.y = 25;
        assert(handle_ui_rml_event(runtime, event));
        event.type = SDL_EVENT_MOUSE_BUTTON_UP;
        event.button.down = false;
        assert(handle_ui_rml_event(runtime, event));
        event = {};
        event.type = SDL_EVENT_MOUSE_MOTION;
        event.motion.x = 145;
        event.motion.y = 25;
        assert(!handle_ui_rml_event(runtime, event));
        event.motion.x = 265;
        assert(!handle_ui_rml_event(runtime, event));
    }
    SDL_DestroyWindow(canvas_window);
    SDL_Quit();
    {
        Engine source, display;
        const auto input = ui_create_element(source, "input");
        ui_append_to_root(source, input);
        on_dom_pointer(source, DomEventTarget::node(input.value), "input", 801,
                       [](const PlatformMouseEvent&) {});
        std::unique_ptr<ExternalEvent> packet;
        apply_document(display, std::move(*snapshot_document(source)),
                       [&](std::unique_ptr<ExternalEvent> value) { packet = std::move(value); });
        ui_set_form_value(display, input, "selected");
        const auto form = dom_event(PlatformMouseEvent{.payload_kind = DomInputEventKind::Event},
                                    "input", dom_ui_path(display, input), true, false);
        dispatch_dom_pointer(display, form);
        const auto* transported = dynamic_cast<WindowEvent*>(packet.get());
        assert(transported && transported->form_value == "selected" &&
               transported->mouse.dom == form.dom);
        ui_set_form_value(display, input, "later");
        assert(transported->form_value == "selected");
        off_dom_pointer(source, DomEventTarget::node(input.value), "input", 801);
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
        const auto canvas = ui_create_element(source, "canvas");
        ui_append_to_root(source, canvas);
        ui_focus(source, canvas);
        apply_document(display, std::move(*snapshot_document(source)), {});
        assert(display.ui_focused_element == canvas && display.ui_focus_visible);
        assert(display.ui_focus_revision == source.ui_focus_revision);
        const auto canvas_since = source.ui_canvas_revision;
        const auto before_draw = source.ui_revision;
        ui_canvas_set_fill_style(source, canvas, "#123456");
        ui_canvas_fill_rect(source, canvas, 0, 0, 20, 20);
        auto canvas_snapshot = snapshot_document(source, source.ui_text_revision, canvas_since);
        assert(source.ui_revision == before_draw);
        assert(canvas_snapshot->text_updates && canvas_snapshot->text_updates->empty());
        assert(canvas_snapshot->elements.empty() && canvas_snapshot->canvas_updates.size() == 1);
        ui_canvas_clear_rect(source, canvas, 0, 0, 300, 150);
        apply_document(display, std::move(*canvas_snapshot), {});
        assert(ui_element(display, canvas).canvas->draws.size() == 1);
        apply_document(display,
                       std::move(*snapshot_document(source, source.ui_text_revision, canvas_since)),
                       {});
        assert(ui_element(display, canvas).canvas->draws.empty());
    }
    const auto initialize = [](WorkerRealm& realm) {
        auto& engine = window_document_engine();
        const auto button = ui_create_element(engine, "button");
        ui_set_attribute(engine, button, "style",
                         "position:absolute;left:20px;top:20px;width:80px;height:30px;");
        ui_set_text(engine, button, "Click");
        ui_append_to_root(engine, button);
        const auto canvas = ui_create_element(engine, "canvas");
        ui_set_attribute(engine, canvas, "style",
                         "position:absolute;left:150px;top:20px;width:40px;height:60px;");
        ui_append_to_root(engine, canvas);
        const auto frame = std::make_shared<EventLoop::AnimationCallback>();
        *frame = [&realm, weak = std::weak_ptr(frame)](double) {
            document_live.store(true);
            ++animation_count;
            if (const auto next = weak.lock())
                realm.request_animation_frame(*next);
        };
        realm.request_animation_frame(*frame);
        engine.visibility_change_callbacks.add(4, [](bool hidden) {
            assert(window_document_engine().document_hidden == hidden);
            visibility_changes.push_back(hidden);
        });
        on_dom_pointer(engine, DomEventTarget::node(button.value), "pointerdown", 1,
                       [button, canvas, frame](const PlatformMouseEvent& pointer) {
                           // A repeated hidden state dispatches no second change.
                           assert((visibility_changes == std::vector<bool>{true, false}));
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
                           // A first computed style read publishes its request and
                           // adopts the display's serialization.
                           auto& owner = window_document_engine();
                           assert(ui_computed_style(owner, button, "visibility") == "visible");
                           assert(ui_computed_style(owner, button, "z-index") == "auto");
                           assert(ui_computed_style(owner, button, "opacity") == "1");
                           check_host_metrics(canvas);
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
            visibility_changes.clear();
            clicked = false;
            dom_clicked = false;
            document_live = false;
            assert(run_window_application(initialize, options) == 0);
            assert(clicked && pending_presentations == 0);
        }
    }
}

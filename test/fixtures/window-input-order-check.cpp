#define BBLITE_WORKERS 1
#define BBLITE_OFFSCREEN_SURFACES 1
#define BBLITE_HAS_DOM_INPUT 1
#define BBLITE_HAS_SDL_GPU 1
#define BBLITE_HAS_DAWN 0
#define BBLITE_HAS_PBR_RENDERER 0
#include "pal_ui_rml.cpp"
#include <cassert>

static SDL_Window* hidden_window(const char* title, int width, int height, SDL_WindowFlags flags) {
    return SDL_CreateWindow(title, width, height, flags | SDL_WINDOW_HIDDEN);
}
#define SDL_CreateWindow hidden_window
#include "pal_window_realm.cpp"
#undef SDL_CreateWindow
#include "pal_media_query.cpp"

namespace bbl {
void set_canvas_dataset(Engine&, std::string, std::string) {
    throw std::runtime_error("Unexpected fixture dataset replay");
}
} // namespace bbl

namespace {
std::atomic<int> input_phase = 0;
std::atomic<int> pending_presentations = 0;
int animation_count = 0;
int animation_at_down = 0;
bool clicked = false;
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
    if (key == "BBLITE_INPUT_REPLAY")
        return "-,-,-,-,-,UiClick@30:30";
    return {};
}
double performance_milliseconds() { return 0; }
const char* bblite_build_stamp() { return "fixture-build-stamp"; }

struct InputOrderPresenter final : WindowPresenter {
    OffscreenDevice graphics;
    OffscreenDevice& device() override { return graphics; }
    bool can_present() override { return true; }
    bool present(std::span<const WindowCanvasFrame>, const UiRenderFrame&,
                 const std::string&) override {
        if (input_phase.load() == 1)
            ++pending_presentations;
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
    const auto initialize = [](WorkerRealm& realm) {
        auto& engine = window_document_engine();
        const auto button = ui_create_element(engine, "button");
        ui_set_attribute(engine, button, "style",
                         "position:absolute;left:20px;top:20px;width:80px;height:30px;");
        ui_set_text(engine, button, "Click");
        ui_append_to_root(engine, button);
        const auto frame = std::make_shared<EventLoop::AnimationCallback>();
        *frame = [&realm, weak = std::weak_ptr(frame)](double) {
            ++animation_count;
            if (const auto next = weak.lock())
                realm.request_animation_frame(*next);
        };
        realm.request_animation_frame(*frame);
        on_dom_pointer(engine, DomEventTarget::node(button.value), "pointerdown", 1,
                       [button, frame](const PlatformMouseEvent&) {
                           animation_at_down = animation_count;
                           input_phase.store(1);
                           // Layout must remain serviced while this source event
                           // owns the UI transaction. Deliberately span repaints.
                           ui_set_text(window_document_engine(), button, "Pending");
                           const auto bounds = window_element_size(button);
                           assert(bounds.width == 80);
                           const auto deadline = EventLoop::Clock::now() + std::chrono::seconds(5);
                           while (pending_presentations.load() < 5) {
                               assert(EventLoop::Clock::now() < deadline);
                               std::this_thread::yield();
                           }
                           input_phase.store(2);
                       });
        on_dom_pointer(engine, DomEventTarget::node(button.value), "click", 2,
                       [&realm](const PlatformMouseEvent&) {
                           assert(input_phase.load() == 2 && animation_count == animation_at_down);
                           clicked = true;
                           realm.close();
                       });
    };
    EngineOptions options;
    options.width = 320;
    options.height = 200;
    assert(run_window_application(initialize, options) == 0);
    assert(clicked && pending_presentations >= 5);
}

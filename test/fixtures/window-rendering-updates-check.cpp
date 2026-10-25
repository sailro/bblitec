#include "pal_ui_rml.cpp"
#include "window-frame-clock-fixture.hpp"
#include <cassert>
#include <functional>
#include <string>
#include <vector>

// A capture realm's animation frames on the real Window display: each frame's
// time reaches the display before the frame presents, and the frame waits for
// the display only while the document changed or time-driven work is due.
static SDL_Window* hidden_window(const char* title, int width, int height, SDL_WindowFlags flags) {
    return SDL_CreateWindow(title, width, height, flags | SDL_WINDOW_HIDDEN);
}
namespace bbl::pal {
/** The realm time of the Window display's latest update (display thread). */
std::optional<double> fixture_display_time;
void fixture_set_ui_rml_time(UiRmlRuntime& runtime, std::optional<double> milliseconds) {
    fixture_display_time = milliseconds;
    set_ui_rml_time(runtime, milliseconds);
}
} // namespace bbl::pal
#define SDL_CreateWindow hidden_window
#define WindowFrameClock FixtureWindowFrameClock
#define set_ui_rml_time fixture_set_ui_rml_time
#include "pal_window_realm.cpp"
#undef set_ui_rml_time
#undef WindowFrameClock
#undef SDL_CreateWindow
#include "pal_media_query.cpp"
#include "window-frame-unit-fixture.hpp"

namespace bbl {
void set_canvas_dataset(Engine&, std::string, std::string) {
    throw std::runtime_error("Unexpected fixture dataset replay");
}
} // namespace bbl

namespace {
constexpr double frame_delta = 10;
const std::string capture_path = "artifacts/window-rendering-updates/capture.png";
std::string max_frames;
bool capture = false;
// Realm thread: the realm's document publications before each animation frame.
std::vector<std::uint64_t> publications;
std::atomic<double> frame_time = -1;
/** The scenario's change at an animation frame's time. */
std::function<void(double)> on_frame;
// Display thread.
struct Presentation {
    double frame_time = -1;
    std::optional<double> display_time;
    std::size_t draws = 0;
    bool capture = false;
};
std::vector<Presentation> presentations;

void request_frame(bbl::pal::WorkerRealm& realm) {
    realm.request_animation_frame([&realm](double timestamp) {
        auto& host = *bbl::pal::current_document().host;
        {
            const std::lock_guard lock(host.mutex);
            publications.push_back(host.requested);
        }
        frame_time.store(timestamp);
        if (on_frame)
            on_frame(timestamp);
        request_frame(realm);
    });
}

/** Document publications during each animation frame after `first`. */
std::vector<std::uint64_t> frame_publications(std::size_t first) {
    std::vector<std::uint64_t> counts;
    for (std::size_t frame = first; frame + 1 < publications.size(); ++frame)
        counts.push_back(publications[frame + 1] - publications[frame]);
    return counts;
}

void run(bbl::pal::WorkerEntry initialize, int frames, bool with_capture = false) {
    max_frames = std::to_string(frames);
    capture = with_capture;
    publications.clear();
    presentations.clear();
    frame_time = -1;
    on_frame = nullptr;
    bbl::EngineOptions options;
    options.width = 320;
    options.height = 200;
    assert(bbl::pal::run_window_application(initialize, options) == 0);
    assert(publications.size() >= static_cast<std::size_t>(frames) / 2);
    // Every frame presents after the display's update at its time.
    for (const auto& presented : presentations)
        assert(presented.frame_time < 0 || presented.display_time == presented.frame_time);
}

bbl::UiElementHandle append(std::string_view tag, std::string style) {
    using namespace bbl;
    auto& engine = pal::window_document_engine();
    const auto element = ui_create_element(engine, tag);
    ui_set_attribute(engine, element, "style", std::move(style));
    ui_append_to_root(engine, element);
    return element;
}
} // namespace

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char* name) {
    const std::string_view key(name);
    if (key == "BBLITE_FRAME_DELTA_MS")
        return std::to_string(frame_delta);
    if (key == "BBLITE_TEST_PASS")
        return "1";
    if (key == "BBLITE_MAX_FRAMES")
        return max_frames;
    if (key == "BBLITE_SCREENSHOT")
        return capture ? capture_path : "";
    if (key == "BBLITE_SCREENSHOT_FRAME")
        return capture ? "5" : "";
    return {};
}
double performance_milliseconds() { return 0; }
double monotonic_milliseconds() { return 0; }
const char* bblite_build_stamp() { return "fixture-build-stamp"; }
void report_build_stamp() {}

struct RecordingPresenter final : WindowPresenter {
    OffscreenDevice graphics;
    OffscreenDevice& device() override { return graphics; }
    bool can_present() override { return true; }
    bool present(std::span<const WindowCanvasFrame>, const UiRenderFrame& ui,
                 const std::string& path) override {
        presentations.push_back(
            {frame_time.load(), fixture_display_time, ui.draws.size(), !path.empty()});
        return true;
    }
};
std::shared_ptr<WindowPresenter> create_window_sdl_gpu_presenter(SDL_Window*) {
    return std::make_shared<RecordingPresenter>();
}
} // namespace bbl::pal

int main() {
    using namespace bbl;
    using namespace bbl::pal;
    std::filesystem::create_directories("artifacts/window-rendering-updates");

    // A static document: no frame waits for the display.
    run(
        [](WorkerRealm& realm) {
            static_cast<void>(append("div", "width:40px;height:40px;background-color:red;"));
            request_frame(realm);
        },
        40);
    for (const auto count : frame_publications(2))
        assert(count == 0);

    // A running animation: every frame waits for the display until it ends, and
    // the capture shows the display updated at its frame's time.
    run(
        [](WorkerRealm& realm) {
            auto& engine = window_document_engine();
            const auto sheet = ui_create_element(engine, "style");
            ui_set_text(engine, sheet,
                        "@keyframes fade { from { opacity: 0; } to { opacity: 1; } }");
            ui_append_child(engine, ui_document_root(engine, UiDocumentPart::Head), sheet);
            const auto box = append("div", "width:40px;height:40px;background-color:red;");
            on_frame = [box](double timestamp) {
                if (timestamp == 3 * frame_delta)
                    ui_set_attribute(window_document_engine(), box, "style",
                                     "width:40px;height:40px;background-color:red;"
                                     "animation:fade 100ms linear;");
            };
            request_frame(realm);
        },
        40, true);
    const auto animated = frame_publications(0);
    for (std::size_t frame = 0; frame < 3; ++frame)
        assert(animated.at(frame) == 0);
    for (std::size_t frame = 3; frame <= 11; ++frame)
        assert(animated.at(frame) == 1);
    for (std::size_t frame = 16; frame < animated.size(); ++frame)
        assert(animated[frame] == 0);
    const auto captured = std::find_if(presentations.begin(), presentations.end(),
                                       [](const auto& presented) { return presented.capture; });
    assert(captured != presentations.end() && captured->frame_time >= 0 &&
           std::none_of(std::next(captured), presentations.end(),
                        [](const auto& presented) { return presented.capture; }));
    assert(animated.at(static_cast<std::size_t>(captured->frame_time / frame_delta)) == 1);

    // A blinking caret: frames wait for the display exactly when it toggles.
    run(
        [](WorkerRealm& realm) {
            auto& engine = window_document_engine();
            ui_focus(engine, append("input", "width:80px;height:20px;"));
            request_frame(realm);
        },
        160);
    std::vector<std::size_t> toggled;
    for (std::size_t index = 1; index < presentations.size(); ++index) {
        const auto& previous = presentations[index - 1];
        const auto& presented = presentations[index];
        if (previous.frame_time >= 2 * frame_delta && presented.draws != previous.draws)
            toggled.push_back(static_cast<std::size_t>(presented.frame_time / frame_delta));
    }
    std::vector<std::size_t> waited;
    const auto caret = frame_publications(0);
    for (std::size_t frame = 2; frame < caret.size(); ++frame)
        if (caret[frame] != 0)
            waited.push_back(frame);
    // RmlUi's caret blinks every 0.7 s.
    assert(toggled.size() == 2 && toggled[1] - toggled[0] == 70 && waited == toggled);
}

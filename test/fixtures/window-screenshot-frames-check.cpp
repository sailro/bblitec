#include "pal_ui_rml.cpp"
#include "window-frame-clock-fixture.hpp"
#include <cassert>
#include <fstream>

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

namespace {
const std::string final_path = "artifacts/window-screenshot-frames/final.png";
std::string checkpoint_frames;
bool capture_ui = false;
bool reject_first_checkpoint = false;
bool checked_cleanup = false;
int presentation_count = 0;
int final_presentation = 0;
std::vector<std::string> captures;

void write_file(const std::string& path, const std::string& content) {
    std::ofstream stream(path);
    stream << content;
    assert(stream.good());
}
std::string read_file(const std::string& path) {
    std::ifstream stream(path);
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}
void request_frame(bbl::pal::WorkerRealm& realm) {
    realm.request_animation_frame([&realm](double) { request_frame(realm); });
}
struct ReadyImage final : bbl::pal::OffscreenImage {};
void request_ready_frame(bbl::pal::WorkerRealm& realm, bbl::UiElementHandle canvas,
                         std::shared_ptr<bbl::pal::OffscreenRun> run, int frame = 0) {
    realm.request_animation_frame([&realm, canvas, run, frame](double) {
        run->publish(40, 40, std::make_shared<ReadyImage>());
        if (frame == 12)
            bbl::ui_set_attribute(bbl::pal::window_document_engine(), canvas, "data-ready", "true");
        request_ready_frame(realm, canvas, run, frame + 1);
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
        return "9";
    if (key == "BBLITE_SCREENSHOT_FRAME")
        return "6";
    if (key == "BBLITE_SCREENSHOT")
        return final_path;
    if (key == "BBLITE_SCREENSHOT_FRAMES")
        return checkpoint_frames;
    if (key == "BBLITE_CAPTURE_UI")
        return capture_ui ? "1" : "0";
    return {};
}
double performance_milliseconds() { return 0; }
double monotonic_milliseconds() { return 0; }
const char* bblite_build_stamp() { return "fixture-build-stamp"; }

struct ScreenshotPresenter final : WindowPresenter {
    OffscreenDevice graphics;
    OffscreenDevice& device() override { return graphics; }
    bool can_present() override { return true; }
    bool present(std::span<const WindowCanvasFrame>, const UiRenderFrame& ui,
                 const std::string& capture) override {
        if (!checked_cleanup && !checkpoint_frames.empty()) {
            for (const auto& checkpoint :
                 window_screenshot_checkpoints(checkpoint_frames, read_frame_options(), false)) {
                assert(!std::filesystem::exists(checkpoint.path));
                assert(!std::filesystem::exists(checkpoint.path + ".build-stamp"));
            }
            checked_cleanup = true;
        }
        if (!capture.empty()) {
            assert(ui.draws.empty() == !capture_ui);
            if (reject_first_checkpoint && capture != final_path) {
                reject_first_checkpoint = false;
                assert(!std::filesystem::exists(capture + ".build-stamp"));
                return false;
            }
            captures.push_back(capture);
            write_file(capture, "fresh");
        }
        ++presentation_count;
        if (capture == final_path)
            final_presentation = presentation_count;
        return true;
    }
};
std::shared_ptr<WindowPresenter> create_window_sdl_gpu_presenter(SDL_Window*) {
    return std::make_shared<ScreenshotPresenter>();
}
} // namespace bbl::pal

int main() {
    using namespace bbl;
    using namespace bbl::pal;
    FrameOptions options;
    options.screenshot_path = final_path;
    options.screenshot_frame = 6;
    assert(window_screenshot_checkpoints("", FrameOptions{}, true).empty());
    const auto parsed = window_screenshot_checkpoints("0,2,4", options, false);
    assert(parsed.size() == 3 && parsed[0].frame == 0 && parsed[1].frame == 2 &&
           parsed[2].frame == 4);
    assert(parsed[0].path == "artifacts/window-screenshot-frames/final.frame-0.png");
    const auto rejects = [&](std::string_view value, const FrameOptions& frame_options,
                             bool engine_frames = false) {
        bool rejected = false;
        try {
            static_cast<void>(window_screenshot_checkpoints(value, frame_options, engine_frames));
        } catch (const std::invalid_argument&) {
            rejected = true;
        }
        assert(rejected);
    };
    for (const auto* value : {",1", "1,", "1,,2", "1;2", "-1", "+1", " 1", "1 ", "1.0", "1e1",
                              "2,2", "4,2", "6", "7", "999999999999999999999999"})
        rejects(value, options);
    rejects("0", FrameOptions{});
    rejects("0", options, true);
    auto path_options = options;
    for (const auto& [path, expected] :
         std::array{std::pair{"a.b/output", "a.b/output.frame-2.png"},
                    std::pair{"a.b/.hidden", "a.b/.hidden.frame-2.png"},
                    std::pair{"a.b/name.old.png", "a.b/name.old.frame-2.png"},
                    std::pair{"a.b/\xc3\xa9.png", "a.b/\xc3\xa9.frame-2.png"}}) {
        path_options.screenshot_path = path;
        assert(window_screenshot_checkpoints("2", path_options, false).front().path == expected);
    }

    std::filesystem::create_directories("artifacts/window-screenshot-frames");
    const std::string unrequested = "artifacts/window-screenshot-frames/final.frame-3.png";
    write_file(unrequested, "keep");
    write_file(final_path + ".build-stamp", "final-stamp-owned-by-engine");
    const auto initialize = [](WorkerRealm& realm) {
        auto& engine = window_document_engine();
        const auto panel = ui_create_element(engine, "div");
        ui_set_attribute(engine, panel, "style", "width:40px;height:40px;background-color:red;");
        ui_append_to_root(engine, panel);
        request_frame(realm);
    };
    EngineOptions engine_options;
    engine_options.width = 320;
    engine_options.height = 200;
    for (const bool display_clock : {false, true}) {
        FixtureWindowFrameClock::enabled = display_clock;
        for (const auto& checkpoint : parsed) {
            write_file(checkpoint.path, "stale");
            write_file(checkpoint.path + ".build-stamp", "stale-stamp");
        }
        checked_cleanup = false;
        captures.clear();
        capture_ui = false;
        presentation_count = 0;
        final_presentation = 0;
        checkpoint_frames = "0,2,4";
        reject_first_checkpoint = true;
        assert(run_window_application(initialize, engine_options) == 0);
        assert(checked_cleanup && !reject_first_checkpoint);
        assert((captures == std::vector<std::string>{parsed[0].path, parsed[1].path, parsed[2].path,
                                                     final_path}));
        assert(presentation_count == final_presentation + 2);
        for (const auto& checkpoint : parsed) {
            assert(read_file(checkpoint.path) == "fresh");
            assert(read_file(checkpoint.path + ".build-stamp") == bblite_build_stamp());
        }
        assert(read_file(unrequested) == "keep");
        assert(read_file(final_path + ".build-stamp") == "final-stamp-owned-by-engine");

        checkpoint_frames.clear();
        capture_ui = true;
        captures.clear();
        presentation_count = 0;
        final_presentation = 0;
        assert(run_window_application(initialize, engine_options) == 0);
        assert(captures == std::vector<std::string>{final_path});
        assert(presentation_count == final_presentation + 2);
    }
    checkpoint_frames.clear();
    captures.clear();
    presentation_count = 0;
    final_presentation = 0;
    assert(run_window_application([](WorkerRealm& realm) {
        window_defer_capture_until_canvas_ready();
        auto& engine = window_document_engine();
        const auto canvas = ui_create_element(engine, "canvas");
        ui_set_attribute(engine, canvas, "style", "width:40px;height:40px;");
        ui_append_to_root(engine, canvas);
        request_ready_frame(realm, canvas, window_canvas(canvas)->rendering_context());
    }, engine_options) == 0);
    assert(captures == std::vector<std::string>{final_path});
    assert(final_presentation >= 13);
    captures.clear();
    assert(run_window_application([](WorkerRealm& realm) {
        window_defer_capture_until_canvas_ready();
        auto& engine = window_document_engine();
        const auto canvas = ui_create_element(engine, "canvas");
        ui_append_to_root(engine, canvas);
        static_cast<void>(window_canvas(canvas));
        ui_set_attribute(engine, canvas, "data-error", "fixture startup failure");
        request_frame(realm);
    }, engine_options) == 1);
    assert(captures.empty());
}

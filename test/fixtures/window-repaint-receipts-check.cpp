#define BBLITE_WORKERS 1
#define BBLITE_OFFSCREEN_SURFACES 1
#define BBLITE_HAS_DOM_INPUT 1
#define BBLITE_HAS_SDL_GPU 1
#define BBLITE_HAS_DAWN 0
#define BBLITE_HAS_PBR_RENDERER 0
#include "pal_ui_rml.cpp"
#include "pal_window_frame_clock.hpp"
#include <bblite/pal_animation_frame.hpp>

namespace {
using bbl::pal::EventLoop;
using namespace std::chrono_literals;
std::mutex producer_mutex;
std::condition_variable producer_changed;
std::atomic<bool> source_ready = false, slow_started = false;
std::atomic<int> fixture_callbacks = 0, retire_checks = 0, dispatched_ticks = 0;
bool release_slow = false;
int pulses = 0, attempts = 0;
const auto deadline = EventLoop::Clock::now() + 5s;

void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}
EventLoop::Clock::time_point tracked_tick(EventLoop::Clock::time_point timestamp) {
    static int prior_retire_checks = 0;
    const int retired = retire_checks.load();
    require(retired > prior_retire_checks, "RAF preceded presenter completion retirement");
    prior_retire_checks = retired;
    ++dispatched_ticks;
    return timestamp;
}
} // namespace

namespace bbl::pal {
class ReceiptFixtureClock {
public:
    explicit ReceiptFixtureClock(bool = false) {}
    bool available() const { return true; }
    std::optional<EventLoop::Clock::time_point> take_latest() {
        if (!source_ready)
            return std::nullopt;
        if (pulses == 0 || (pulses == 1 && attempts >= 2) || (pulses == 2 && slow_started)) {
            ++pulses;
            return EventLoop::Clock::time_point{} + std::chrono::milliseconds(pulses);
        }
        return std::nullopt;
    }
    bool wait_for(std::chrono::milliseconds) {
        require(EventLoop::Clock::now() < deadline, "Window repaint fixture failed to progress");
        if (pulses == 2 && !slow_started) {
            std::unique_lock lock(producer_mutex);
            require(producer_changed.wait_until(lock, deadline, [] { return slow_started.load(); }),
                    "Second RAF was never dispatched");
        } else {
            std::this_thread::yield();
        }
        return true;
    }
};
} // namespace bbl::pal

static SDL_Window* hidden_window(const char* title, int width, int height, SDL_WindowFlags flags) {
    return SDL_CreateWindow(title, width, height, flags | SDL_WINDOW_HIDDEN);
}
#define SDL_CreateWindow hidden_window
#define WindowFrameClock ReceiptFixtureClock
// Record the actual Window dispatch boundary, separately from clock consumption.
#define tick(...) tick(tracked_tick(__VA_ARGS__))
#include "pal_window_realm.cpp"
#undef tick
#undef WindowFrameClock
#undef SDL_CreateWindow
#include "pal_media_query.cpp"

namespace bbl {
void set_canvas_dataset(Engine&, std::string, std::string) {
    throw std::runtime_error("Unexpected fixture dataset replay");
}
} // namespace bbl

namespace {
void request_frame(bbl::pal::WorkerRealm& realm,
                   const std::shared_ptr<bbl::pal::OffscreenRun>& run) {
    realm.request_animation_frame([&realm, run](double) {
        const int frame = ++fixture_callbacks;
        if (frame == 2) {
            request_frame(realm, run);
            std::unique_lock lock(producer_mutex);
            slow_started = true;
            producer_changed.notify_all();
            require(producer_changed.wait_until(lock, deadline, [] { return release_slow; }),
                    "Next heartbeat did not release presentation of the old image");
        }
        run->publish(40, 40, std::make_shared<bbl::pal::OffscreenImage>());
        if (frame == 1)
            request_frame(realm, run);
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
        return "10";
    return {};
}
double performance_milliseconds() { return 0; }
double monotonic_milliseconds() {
    return std::chrono::duration<double, std::milli>(EventLoop::Clock::now().time_since_epoch())
        .count();
}
const char* bblite_build_stamp() { return "fixture-build-stamp"; }

struct ReceiptPresenter final : WindowPresenter {
    OffscreenDevice graphics;
    OffscreenDevice& device() override { return graphics; }
    bool can_present() override {
        ++retire_checks;
        return source_ready;
    }
    bool present(std::span<const WindowCanvasFrame> frames, const UiRenderFrame&,
                 const std::string&) override {
        ++attempts;
        require(frames.size() == 1, "Window lost its canvas frame");
        if (attempts <= 2) {
            require(frames[0].frame.sequence == 2 && fixture_callbacks == 1 &&
                        dispatched_ticks == 1,
                    "Completed RAF did not present its new image or retry repeated RAF");
            return attempts == 2;
        }
        if (attempts == 3) {
            require(frames[0].frame.sequence == 2 && fixture_callbacks == 2 && pulses == 3 &&
                        dispatched_ticks == 2,
                    "Slow RAF did not present its old image before dispatching the next pulse");
            {
                std::lock_guard lock(producer_mutex);
                release_slow = true;
            }
            producer_changed.notify_all();
            return true;
        }
        require(attempts == 4 && frames[0].frame.sequence == 4 && fixture_callbacks == 3 &&
                    dispatched_ticks == 3,
                "Completed next RAF did not replace the expired image");
        SDL_Event event{};
        event.type = SDL_EVENT_QUIT;
        require(SDL_PushEvent(&event), "Fixture quit event failed");
        return true;
    }
};
std::shared_ptr<WindowPresenter> create_window_sdl_presenter(SDL_Window*) {
    return std::make_shared<ReceiptPresenter>();
}
} // namespace bbl::pal

int main() {
    using namespace bbl;
    using namespace bbl::pal;
    const auto initialize = [](WorkerRealm& realm) {
        auto& engine = window_document_engine();
        const auto canvas = ui_create_element(engine, "canvas");
        ui_set_attribute(engine, canvas, "style", "width:40px;height:40px;");
        ui_append_to_root(engine, canvas);
        const auto run = window_canvas(canvas)->rendering_context();
        require(window_element_size(canvas).width == 40, "Initial canvas layout failed");
        run->publish(40, 40, std::make_shared<OffscreenImage>());
        request_frame(realm, run);
        source_ready = true;
    };
    EngineOptions options;
    options.width = 320;
    options.height = 200;
    if (run_window_application(initialize, options) != 0)
        return 1;
    require(attempts == 4 && fixture_callbacks == 3 && pulses == 3 && dispatched_ticks == 3,
            "Window repaint fixture stopped before exercising all phases");
}

#include "pal_ui_rml.cpp"
#include "pal_window_realm.cpp"
#include "pal_media_query.cpp"
#include "window-frame-unit-fixture.hpp"
#include <bblite/pal_frame_driver.hpp>
#include <cassert>

namespace bbl::pal {
int fixture_run_window_application(WorkerEntry initialize, EngineOptions options);
}
#define run_window_application fixture_run_window_application
#define main generated_main
#include "../../artifacts/mutation-observer/program.hpp"
#undef main
#undef run_window_application

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::logic_error("Unexpected fixture asset"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
double monotonic_milliseconds() { return 0; }
const char* bblite_build_stamp() { return "fixture"; }
std::shared_ptr<WindowPresenter> create_window_sdl_gpu_presenter(SDL_Window*) {
    throw std::logic_error("Unexpected fixture presenter");
}

int fixture_run_window_application(WorkerEntry initialize, EngineOptions options) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    auto services = std::make_shared<WindowServices>(nullptr, 0);
    WindowDocument owner(services, std::move(options));
    document = &owner;
    std::exception_ptr failure;
    loop.on_error([&](std::exception_ptr error) {
        failure = error;
        loop.close();
    });
    loop.run([&] { initialize(realm); });
    assert(owner.mutation_observers.empty());
    document = nullptr;
    if (failure)
        std::rethrow_exception(failure);
    return 0;
}
} // namespace bbl::pal

namespace bbl {
void set_canvas_dataset(Engine&, std::string, std::string) {
    throw std::logic_error("Unexpected fixture input replay");
}
} // namespace bbl

namespace {
int render_count = 0;
struct Image final : bbl::pal::OffscreenImage {};
bbl::pal::FrameDriver render_frames(bbl::Engine& engine) {
    for (;;) {
        ++render_count;
        engine.offscreen_run->publish(1, 1, std::make_shared<Image>());
        co_yield true;
    }
    co_return true;
}
void check_capture_readiness(bool delayed) {
    using namespace bbl;
    using namespace bbl::pal;
    const js::RealmScope scope;
    EventLoop loop;
    auto services = std::make_shared<WindowServices>(std::make_shared<OffscreenDevice>(), 2);
    WorkerRealm realm(loop, "", services);
    WindowDocument owner(services, {});
    document = &owner;
    UiElementHandle canvas;
    Engine engine;
    render_count = 0;
    loop.post([&] {
        if (delayed)
            window_defer_capture_until_canvas_ready();
        canvas = ui_create_element(owner.engine, "canvas");
        engine.offscreen_run = window_canvas(canvas)->rendering_context();
        auto driver = render_frames(engine);
        driver.start();
    });
    assert(loop.poll());
    for (int tick = 0; tick < 8; ++tick) {
        services->animation_frames->tick(EventLoop::Clock::now());
        const bool rendered = loop.poll();
        const auto frame = services->canvases.at(canvas.value)->surface->take_frame();
        if (rendered) {
            assert(frame && frame->sequence == static_cast<std::uint64_t>(render_count));
            assert(frame->capture_ready == (!delayed || tick >= 4));
        } else
            assert(!frame);
        if (delayed && tick == 3) {
            loop.post([&] { ui_set_attribute(owner.engine, canvas, "data-ready", "true"); });
            assert(loop.poll());
            assert(services->capture_ready->load());
            assert(!engine.offscreen_run->last_frame_capture_ready());
        }
    }
    assert(render_count == (delayed ? 5 : 2));
    loop.close();
    document = nullptr;
}
} // namespace

int main() try {
    assert(generated_main() == 0);
    check_capture_readiness(false);
    check_capture_readiness(true);
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
}

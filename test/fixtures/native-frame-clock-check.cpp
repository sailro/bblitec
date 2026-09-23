#include <bblite/js_realm_state.hpp>
#include <bblite/pal_frame_driver.hpp>
#include <cassert>

namespace {
double wall_time = 100;
double performance_time = 0;
double fixed_step = 0;
std::vector<double> deltas;
} // namespace

namespace bbl::pal {
double monotonic_milliseconds() { return wall_time; }
void advance_performance_milliseconds(double delta) { performance_time += delta; }
#include "frame-clock.hpp"
} // namespace bbl::pal

bbl::pal::FrameDriver render_frames(bbl::Engine& engine) {
    using namespace bbl::pal;
    FrameClock clock;
    for (int frame = 0; frame < 3; ++frame) {
        assert(OffscreenRun::current() == engine.offscreen_run.get());
        deltas.push_back(clock.advance(fixed_step));
        if (frame == 2)
            co_return true;
        EventLoop::current().post([frames = engine.offscreen_run->animation_frames(), frame] {
            // Delayed realm execution must not become the source frame delta.
            wall_time += frame ? 731 : 219;
            if (frame == 0) {
                frames->tick(EventLoop::Clock::time_point{} + std::chrono::milliseconds(10));
                frames->tick(EventLoop::Clock::time_point{} + std::chrono::milliseconds(15));
            } else {
                frames->tick(EventLoop::Clock::time_point{} + std::chrono::milliseconds(31));
            }
        });
        co_yield true;
    }
    co_return true;
}

void check_window_clock(double step) {
    using namespace bbl;
    const js::RealmScope realm;
    pal::EventLoop loop(std::make_shared<pal::EventLoop::Inbox>(),
                        pal::EventLoop::Clock::time_point{});
    auto frames = std::make_shared<pal::AnimationFrameSource>();
    pal::OffscreenSurface surface(1, 1, frames);
    pal::OffscreenDevice device;
    Engine engine;
    engine.offscreen_run = std::make_shared<pal::OffscreenRun>(surface, device);
    fixed_step = step;
    deltas.clear();
    loop.run([&] {
        auto driver = render_frames(engine);
        driver.finished().observe(
            [&](bool ran) {
                assert(ran);
                loop.close();
            },
            [](std::exception_ptr error) { std::rethrow_exception(error); });
        driver.start();
        frames->tick(pal::EventLoop::Clock::time_point{});
    });
    assert(!pal::OffscreenRun::current());
    assert(deltas ==
           (step > 0 ? std::vector<double>{0, step, step} : std::vector<double>{0, 15, 16}));
}

int main() {
    using namespace bbl::pal;
    FrameClock direct;
    assert(direct.advance(0) == 0);
    wall_time += 7.125;
    assert(direct.advance(0) == 7.125);
    FrameClock fixed;
    assert(fixed.advance(16) == 0);
    wall_time += 3;
    assert(fixed.advance(16) == 16 && performance_time == 16);
    check_window_clock(0);
    assert(performance_time == 16);
    check_window_clock(16);
    assert(performance_time == 48);
}

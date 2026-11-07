// The frame conductor with `engine._renderFn` replaced: the real conductor and
// the real animation-turn bodies (dispatch.hpp, from pal_gpu_frame.cpp), a
// renderer that logs its phases in place of GPU work.
#include "pal_frame_conductor.hpp"

#include <bblite/pal_texture_texels.hpp>
#include <cassert>
#include <cstdio>
#include <string>

namespace bbl {
void run_deferred_callbacks(Engine&) {}
void run_timeout_callbacks(Engine&) {}
void run_interval_callbacks(Engine&) {}
} // namespace bbl
namespace bbl::pal {
double performance_milliseconds() { return 16.0; }
double monotonic_milliseconds() { return 16.0; }
void advance_performance_milliseconds(double) {}
namespace {
void begin_profiled_frame() {}
} // namespace
#include "dispatch.hpp"
} // namespace bbl::pal

namespace {
std::string order;

/** Logs the browser turn's parts: events, render, the frame's end. */
struct LoggingRenderer {
    static constexpr bbl::pal::FrameAcquirePhase acquire_phase =
        bbl::pal::FrameAcquirePhase::before_uploads;
    bbl::Engine& engine;
    bbl::pal::FrameClock frame_clock;

    bool keep_running() const { return !engine.stopped; }
    // A stopped engine ends this loop before a frame could freeze.
    bool freeze() { return false; }
    bbl::pal::FramePreparation prepare() {
        order += "e";
        return bbl::pal::FramePreparation::ready;
    }
    bool acquire() { return true; }
    bool begin_animation_turn() {
        return bbl::pal::begin_animation_turn(engine, frame_clock, 16.0).has_value();
    }
    bbl::pal::FramePreparation update() {
        static_cast<void>(bbl::pal::begin_animation_turn(engine, frame_clock, 16.0));
        order += "r";
        return bbl::pal::FramePreparation::ready;
    }
    void synchronize() {}
    void encode() {}
    void present() {}
    void complete() { bbl::pal::finish_frame(engine); }
};

bbl::pal::FrameOutcome frame(LoggingRenderer& renderer) {
    return bbl::pal::conduct_frame(renderer, renderer.engine);
}

/** A callback that runs in every frame of its phase, logging `mark`. */
void every_frame(bbl::Engine& engine, char mark) {
    auto callback = std::make_shared<bbl::js::Callback<void(double)>>();
    *callback = bbl::js::Callback<void(double)>([&engine, callback, mark](double) {
        order += mark;
        bbl::request_animation_frame(engine, *callback);
    });
    bbl::request_animation_frame(engine, *callback);
}
} // namespace

int main() {
    using bbl::pal::FrameOutcome;
    bbl::Engine engine;
    LoggingRenderer renderer{engine, {}};
    // Before startEngine nothing is the frame function.
    assert(!bbl::engine_render_function(engine));
    every_frame(engine, 'b');
    bbl::arm_engine_render_function(engine);
    const auto inner = bbl::engine_render_function(engine);
    assert(inner);
    // An unreplaced frame: events, earlier RAF callbacks, render.
    assert(frame(renderer) == FrameOutcome::rendered);
    assert(order == "ebr");
    every_frame(engine, 'a');
    int wrapped = 0;
    const bbl::js::Callback<void(double)> wrapper([&](double now) {
        order += "(";
        inner(now);
        order += ")";
        ++wrapped;
    });
    bbl::set_engine_render_function(engine, wrapper);
    assert(bbl::engine_render_function(engine) == wrapper);
    // The frame in flight armed the function `_renderFn` held when it ended
    // rendering: one more frame of the earlier function, which re-arms with
    // the wrapper, as the pin's `requestAnimationFrame(engine._renderFn)`.
    order.clear();
    assert(frame(renderer) == FrameOutcome::rendered);
    assert(order == "ebra");
    order.clear();
    assert(frame(renderer) == FrameOutcome::rendered);
    assert(order == "eb(r)a" && wrapped == 1);
    // The inner function outside the frame it renders is refused.
    bool refused = false;
    try {
        inner(0.0);
    } catch (const std::logic_error&) {
        refused = true;
    }
    assert(refused);
    // A wrapper that never renders arms nothing: the loop ends.
    bbl::set_engine_render_function(engine,
                                    bbl::js::Callback<void(double)>([](double) { order += "x"; }));
    order.clear();
    assert(frame(renderer) == FrameOutcome::rendered && order == "eb(r)a");
    order.clear();
    assert(frame(renderer) == FrameOutcome::stopped && order == "ebx");
    std::puts("render-function-conductor-check: ok");
    return 0;
}

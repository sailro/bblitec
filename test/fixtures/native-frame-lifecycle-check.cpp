#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>
#include <cassert>
#include <type_traits>

namespace {
double clock_time = 100;
double performance_time = 0;
std::vector<int> events;
}

namespace bbl {
#include "frame-continuations.hpp"
void run_timeout_callbacks(Engine&) { events.push_back(8); }
void run_interval_callbacks(Engine&) { events.push_back(9); }
}

namespace bbl::pal {
double monotonic_milliseconds() { return clock_time; }
double performance_milliseconds() { return performance_time; }
void advance_performance_milliseconds(double delta) { performance_time += delta; }
struct TextGpuCapture;
#include "frame-lifecycle.hpp"
}

using namespace bbl;
using namespace bbl::pal;

void check_clock() {
    FrameClock fixed;
    const double step = 1000.0 / 60.0;
    static_assert(std::is_same_v<decltype(fixed.advance(step)), double>);
    assert(fixed.advance(step) == 0 && performance_time == 0);
    clock_time += 11;
    assert(fixed.advance(step) == step && performance_time == step);
    clock_time += 50;
    assert(fixed.advance(step) == step && performance_time == step * 2);
    FrameClock measured;
    assert(measured.advance(0) == 0);
    clock_time += 7.125;
    assert(measured.advance(0) == 7.125 && performance_time == step * 2);

    Engine engine;
    FrameClock animation;
    std::vector<double> timestamps;
    engine.animation_frame_callbacks.push_back([&](double now) { timestamps.push_back(now); });
    assert(advance_frame(engine, animation, step) == 0);
    assert(advance_frame(engine, animation, step) == step);
    assert(timestamps == std::vector<double>({step * 2, step * 3}));
    engine.stopped = true;
    assert(advance_frame(engine, animation, step) == 0 && timestamps.size() == 2);
    FrameGraphContext graph;
    std::vector<float> graph_steps;
    graph.updates.push_back([&](float delta) { graph_steps.push_back(delta); });
    assert(advance_frame(engine, graph, animation, step) == 0 && graph_steps.empty());
    engine.stopped = false;
    assert(advance_frame(engine, graph, animation, step) == step);
    assert(graph_steps == std::vector<float>({static_cast<float>(step)}));
}

void check_continuations() {
    Engine engine;
    FrameOptions options;
    options.screenshot_path = "capture.png";
    CaptureGate gate(options, 3, &engine);
    bool resolved = false;
    defer_start_continuation(engine, [&] {
        events.push_back(1);
        defer_start_continuation_until(engine, [&] { return resolved; }, [&] {
            events.push_back(2);
            defer_callback(engine, [] { events.push_back(3); });
        });
    });
    assert(engine.pending_start_continuations == 1 && !gate.drains_resolved());
    run_deferred_callbacks(engine);
    assert(events == std::vector<int>({1}) && engine.pending_start_continuations == 1);
    run_deferred_callbacks(engine);
    assert(events == std::vector<int>({1}) && !gate.drains_resolved());
    resolved = true;
    run_deferred_callbacks(engine);
    assert(events == std::vector<int>({1, 2}) && engine.pending_start_continuations == 0);
    assert(gate.drains_resolved() && engine.deferred_callbacks.size() == 1);
    run_deferred_callbacks(engine);
    assert(events == std::vector<int>({1, 2, 3}) && engine.deferred_callbacks.empty());
    events.clear();
}

void check_completion() {
    Engine engine;
    run_animation_frame_callbacks(engine);
    defer_start_continuation(engine, [&] {
        events.push_back(1);
        request_animation_frame(engine, [&](double) {
            events.push_back(2);
            request_animation_frame(engine, [](double) { events.push_back(3); });
        });
    });
    finish_frame(engine);
    assert(events == std::vector<int>({1, 8, 9}));
    assert(engine.pending_start_continuations == 0);
    events.clear();
    run_animation_frame_callbacks(engine);
    assert(events.empty());
    events.push_back(4); // Render consumes the state before post-start RAF callbacks.
    finish_frame(engine);
    assert(events == std::vector<int>({4, 2, 8, 9}));
    events.clear();
    run_animation_frame_callbacks(engine);
    finish_frame(engine);
    assert(events == std::vector<int>({3, 8, 9}));
    events.clear();
    engine.stopped = true;
    defer_callback(engine, [] { events.push_back(5); });
    finish_frame(engine);
    assert(events.empty() && engine.deferred_callbacks.size() == 1);
    engine.deferred_callbacks.clear();
}

void check_capture_budget() {
    Engine engine;
    FrameOptions options;
    options.max_frames = 3;
    assert(options.frame_budget() == 3 && !options.benchmarking());
    CaptureGate ordinary(options, options.frame_budget(), &engine);
    assert(!ordinary.requested() && !ordinary.pending());
    assert(ordinary.keep_running(true, 2) && !ordinary.keep_running(true, 3));
    assert(!ordinary.keep_running(false, 0));
    options.benchmark_frames = 100;
    assert(options.benchmarking() && options.frame_budget() == 100 + options.benchmark_warmup());
    CaptureGate benchmark(options, options.frame_budget(), &engine);
    assert(benchmark.keep_running(true, options.frame_budget() - 1));
    assert(!benchmark.keep_running(true, options.frame_budget()));

    options.screenshot_path = "capture.png";
    CaptureGate gate(options, 3, &engine);
    bool ready = false;
    engine.capture_ready.push_back([&] { return ready; });
    assert(gate.requested() && gate.pending() && !gate.drains_resolved());
    assert(gate.keep_running(true, 602) && !gate.keep_running(true, 603));
    ready = true;
    assert(gate.drains_resolved() && gate.keep_running(true, 20));
    assert(gate.keep_running(true, 27) && !gate.keep_running(true, 28));
    gate.screenshot_saved = true;
    assert(!gate.pending() && !gate.keep_running(true, 20));

    engine.stopped = true;
    CaptureGate frozen(options, 3, &engine);
    assert(frozen.keep_running(true, 0));
    frozen.screenshot_saved = true;
    assert(!frozen.keep_running(true, 0));
    FrameOptions interactive_options;
    CaptureGate interactive(interactive_options, 0, &engine);
    assert(interactive.keep_running(true, 1000));

    for (const auto path : {&FrameOptions::screenshot_path, &FrameOptions::id_buffer_path,
                           &FrameOptions::cluster_buffer_path, &FrameOptions::render_capture_path}) {
        FrameOptions requested;
        requested.*path = "output";
        CaptureGate capture(requested, 1);
        assert(capture.requested() && capture.pending() && capture.drains_resolved());
        capture.screenshot_saved = capture.id_buffer_saved = capture.cluster_buffer_saved = capture.render_capture_saved = true;
        assert(!capture.pending());
    }
}

int main() {
    check_clock();
    check_continuations();
    check_completion();
    check_capture_budget();
}

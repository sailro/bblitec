#pragma once

#include "pal_frame_conductor.hpp"
#include "pal_gpu_shared.hpp"
#include "pal_platform_events.hpp"

namespace bbl::pal {

/** Clock, capture progress and completion shared by native rendering contexts. */
struct FrameSession {
    Engine& engine;
    const FrameOptions frame_options;
    CaptureGate captures;
    FrameClock frame_clock;
    PlatformInputReplay input_replay;
    bool running = true;
    long frame = 0;
    double frame_start = 0;
    std::vector<double> samples_ms;

    explicit FrameSession(Engine& target)
        : engine(target), frame_options(read_frame_options()),
          captures(frame_options, frame_options.frame_budget(), &engine) {}
    FrameSession(const FrameSession&) = delete;
    FrameSession& operator=(const FrameSession&) = delete;

    bool keep_running() const { return captures.keep_running(running, frame); }
    void begin_measurement() { frame_start = monotonic_milliseconds(); }
    template <typename AfterRender>
    void complete(AfterRender after_render) {
        finish_frame(engine);
        after_render();
        if (frame_options.benchmarking() && frame >= frame_options.benchmark_warmup())
            samples_ms.push_back(monotonic_milliseconds() - frame_start);
        ++frame;
    }
    void complete() { complete([] {}); }
    void report(const char* backend, const std::string& driver) {
        if (frame_options.benchmarking()) report_benchmark(std::move(samples_ms), backend, driver);
    }
};

} // namespace bbl::pal

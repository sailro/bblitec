#pragma once

#include "pal_frame_conductor.hpp"
#include "pal_gpu_shared.hpp"
#include "pal_platform_events.hpp"

namespace bbl::pal {

/** Wall time between completed frames, including event handling and presentation. */
class FrameRateProfile {
    const bool enabled_ = environment_variable("BBLITE_FPS_PROFILE") == "1";
    double previous_ = 0, window_ms_ = 0;
    std::vector<double> intervals_;
public:
    void complete(long frame) {
        if (!enabled_) return;
        const double now = monotonic_milliseconds();
        if (previous_ != 0) {
            const double elapsed = now - previous_;
            intervals_.push_back(elapsed);
            window_ms_ += elapsed;
        }
        previous_ = now;
        if (window_ms_ < 1000) return;
        std::sort(intervals_.begin(), intervals_.end());
        const auto count = intervals_.size();
        const auto p99 = std::min(count - 1, static_cast<std::size_t>(std::ceil(count * 0.99)) - 1);
        std::fprintf(stderr, "[fps] frame=%ld frames=%zu elapsed_ms=%.3f fps=%.2f p99_ms=%.3f max_ms=%.3f\n",
            frame, count, window_ms_, count * 1000.0 / window_ms_, intervals_[p99], intervals_.back());
        intervals_.clear();
        window_ms_ = 0;
    }
};

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
    FrameRateProfile frame_rate_profile;

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

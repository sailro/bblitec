// The frame loop every renderer runs, whatever the scene reaches: the run
// options, the frame clock and the before- and after-render boundaries,
// the capture gate, and the benchmark, CPU and memory profile lines. It
// reads only activation macros, so its unit compiles once for every scene.
#pragma once
#include <bblite/features/has_audio.hpp>
#include <bblite/features/workers.hpp>

#include <bblite/js_gc.hpp>
#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>
#if BBLITE_HAS_AUDIO
#include <bblite/pal_audio.hpp>
#endif
#if BBLITE_WORKERS
#include <bblite/pal_offscreen.hpp>
#endif

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <iomanip>
#include <iostream>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "pal_device_options.hpp"
#include "pal_gpu_common.hpp"

namespace bbl::pal {

class TextGpuCapture;

/** Whether the scene set a backend planned at startup has changed. */
bool registered_scene_set_changed(const Engine& engine,
                                  const std::vector<std::shared_ptr<Scene>>& planned);

/** Stop this render plan whenever its scene set changes, including removal. */
bool request_renderer_restart_if_scene_set_changed(
    Engine& engine, const std::vector<std::shared_ptr<Scene>>& planned);

/**
 * The warmup every renderer's benchmark discards before sampling: a
 * tenth of the requested frames, clamped to [10, 120]. One policy for
 * both GPU frame loops and their sprite variants, so the published
 * numbers of any two renderers cover the same measured span of a run.
 */
[[nodiscard]] inline long benchmark_warmup_frames(long benchmark_frames) {
    return benchmark_frames > 0 ? std::min(120L, std::max(10L, benchmark_frames / 10)) : 0;
}

// How a measured run is driven, parsed once for whichever backend runs it.
struct FrameOptions {
    std::string screenshot_path;
    std::string id_buffer_path;
    std::string cluster_buffer_path;
    std::string shader_directory;
    std::string copy_task_filter;
    // Where to write the frame's full CPU-side description
    // (pal_render_capture.hpp), for diffing against the browser's
    // instrumented capture.
    std::string render_capture_path;
    // Kept as written rather than pre-interpreted: the background and
    // ground flags accept "1"/"true" as well as "0"/"false", and the
    // methods below hold the differing defaults (a requested background
    // is off unless asked for, a requested ground is on unless refused).
    std::string background_flag;
    std::string ground_flag;
    bool gpu_debug = false;
    bool test_pass = false;
    bool single_sample = false;
    bool capture_ui = true;
    long screenshot_frame = 0;
    long max_frames = 0;
    long benchmark_frames = 0;
    double animation_seek_seconds = 0.0;
    // A double, as `BBLITE_FRAME_DELTA_MS` is written and as the browser's
    // frame timestamps are; see `FrameClock::advance`.
    double frame_delta_ms = 0.0;

    [[nodiscard]] bool skip_copy_task(const CopyTaskOptions& copy) const {
        return !copy_task_filter.empty() && copy.has_viewport &&
               copy.name.find("-impostor-") != std::string::npos && copy.name != copy_task_filter;
    }
    [[nodiscard]] bool full_copy_viewport(const CopyTaskOptions& copy) const {
        return !copy_task_filter.empty() && copy.name == copy_task_filter;
    }

    /** Frames to run: a benchmark adds its warmup to the request. */
    [[nodiscard]] long frame_budget() const {
        return benchmark_frames > 0 ? benchmark_frames + benchmark_warmup() : max_frames;
    }
    [[nodiscard]] bool benchmarking() const { return benchmark_frames > 0; }
    /**
     * Whether a benchmark was asked for at all. Present mode keys on the
     * request rather than the count, because the recorded frame-time
     * numbers depend on immediate present being selected before the
     * count is known to be positive.
     */
    bool benchmark_requested = false;
    [[nodiscard]] long benchmark_warmup() const {
        return benchmark_warmup_frames(benchmark_frames);
    }

    /**
     * Whether the run draws the environment background: only when asked
     * for, or when the scene enables it by default and the flag says
     * nothing. Both frame loops read the flags through these three
     * methods, so a run's flags cannot mean different draws per backend.
     */
    [[nodiscard]] bool background_enabled(const EnvironmentState& environment) const {
        return background_flag == "1" || background_flag == "true" ||
               (background_flag.empty() && environment.background_enabled_by_default);
    }
    /** The skybox draws with the background when the scene carries one. */
    [[nodiscard]] bool skybox_enabled(const EnvironmentState& environment) const {
        return background_enabled(environment) && environment.has_skybox;
    }
    /** The scene's ground draws unless the flag refuses it. */
    [[nodiscard]] bool ground_enabled(const EnvironmentState& environment) const {
        return environment.has_ground && ground_flag != "0" && ground_flag != "false";
    }
};

inline DeviceOptions frame_device_options(const FrameOptions& frame) {
    return {frame.test_pass, frame.benchmark_requested, frame.gpu_debug};
}

inline long frame_option_number(const char* name) {
    const std::string value = environment_variable(name);
    return value.empty() ? 0L : std::strtol(value.c_str(), nullptr, 10);
}

FrameOptions read_frame_options();

/**
 * A measured seek runs every registered animation seeker to the
 * requested time before the first frame; both frame loops apply the same
 * request so a seeked capture renders the same pose on either backend.
 */
void apply_animation_seek(const FrameOptions& options, const Scene& scene);

/**
 * The delta a scene's before-render callbacks advance by.
 *
 * A scene that sets `fixedDeltaMs` pins it, which is how the measured
 * animated scenes stay deterministic. Everything else advances by the
 * elapsed frame time. Window realms use their supplied RAF timestamp,
 * matching the pinned engine; direct renderers sample the wall clock.
 * The first frame reports zero.
 */
class FrameClock {
public:
    // A double, as the browser's DOMHighResTimeStamp difference is: a
    // renderer hook that divides the delta by the pin's frame period
    // (`deltaMs / FRAME_MS`) reads exactly the ratio the browser computes
    // under the same fixed step, where a float step would leave it one
    // part in ten million short. Scene callbacks still take the float the
    // engine API declares.
    [[nodiscard]] double advance(double fixed_delta_ms) {
        std::optional<double> frame_timestamp;
#if BBLITE_WORKERS
        if (const auto* run = OffscreenRun::current())
            frame_timestamp = run->animation_frame_timestamp();
#endif
        const double now = frame_timestamp ? *frame_timestamp : monotonic_milliseconds();
        const bool first_frame = !previous_;
        const double measured = previous_ ? now - *previous_ : 0.0;
        previous_ = now;
        const double delta_ms = fixed_delta_ms > 0.0 && !first_frame ? fixed_delta_ms : measured;
        if (fixed_delta_ms > 0.0) {
            advance_performance_milliseconds(delta_ms);
        }
        return delta_ms;
    }

private:
    std::optional<double> previous_;
};

/** Give every pre-render application RAF callback this turn's one timestamp. */
void run_animation_frame_callbacks(Engine& engine);

/**
 * Everything a frame does before anything is drawn, for every loop that
 * has a scene: resolve the delta, run application RAF callbacks registered
 * before `startEngine`, then run the scene's own callbacks.
 *
 * A stopped engine advances none of it -- the pin's `stopEngine` clears
 * `_renderFn`, so no further frame runs at all and the canvas keeps what
 * it last drew. Here the loop keeps presenting that unchanged frame while
 * `CaptureGate` still has something pending, so a screenshot lands on the
 * frozen frame exactly as the browser harness takes one off the frozen
 * canvas.
 *
 * Returns the frame's delta, because the frame body needs the same value
 * the before-render callbacks were given -- an animated billboard pass
 * advances by it. A stopped engine returns zero rather than the measured
 * wall-clock gap: the loop keeps presenting the frame it last drew, and a
 * frozen frame advances nothing.
 */
[[nodiscard]] double advance_frame(Engine& engine, Scene& scene, FrameClock& frame_clock,
                                   double frame_delta_ms);

/**
 * The same boundary for a loop with no scene. A `SpriteRenderer` or an
 * `EffectRenderer` is its own rendering context on the engine, but an
 * application can still own a requestAnimationFrame loop and queue a
 * timeout. Both run from the same frame clock as custom-shader time.
 */
[[nodiscard]] double advance_frame(Engine& engine, FrameClock& frame_clock, double frame_delta_ms);

/** The measured update boundary for a standalone FrameGraphContext. */
[[nodiscard]] double advance_frame(Engine& engine, FrameGraphContext& context,
                                   FrameClock& frame_clock, double frame_delta_ms);

/**
 * Completes the browser frame turn after rendering has consumed its state.
 * RAF callbacks registered after the awaited `startEngine` follow the
 * engine-owned RAF callback, exactly as they do in the browser. A zero-delay
 * timeout queued anywhere in the turn is then drained at the turn boundary.
 */
void finish_frame(Engine& engine);

/**
 * Which requested captures have landed, and whether the loop may stop.
 *
 * A measured run ends when the frame budget is spent, except that a
 * capture can still be outstanding: a topology update defers it by a
 * frame, and a null swapchain acquisition advances scene callbacks
 * without consuming one. Both backends therefore extend the loop by a
 * bounded grace period, and both used to carry their own copy of the
 * rule -- including the comment saying it matched the other one.
 */
class CaptureGate {
public:
    CaptureGate(const FrameOptions& options, long limit, const Engine* engine = nullptr)
        : options_(&options), limit_(limit), engine_(engine) {}

    bool screenshot_saved = false;
    bool id_buffer_saved = false;
    bool cluster_buffer_saved = false;
    bool render_capture_saved = false;

    /**
     * The standalone loops' render capture, gated and marked here.
     *
     * The capture describes CPU state alone — the same records the
     * loop's uploads read — written once, at the frame the screenshot
     * gate names, exactly as the scene loops write theirs beside their
     * screenshots. Six drivers each spelled the gate before this owned
     * it, which is the class's founding reason. Defined in
     * pal_render_capture.hpp beside the writer it calls, so a TU that
     * includes only this header carries no undefined inline.
     */
    void maybe_write_standalone_render_capture(const char* backend, const Engine& engine,
                                               std::uint32_t width, std::uint32_t height,
                                               long frame, TextGpuCapture* text_capture = nullptr);

    /** Whether this run was asked for any capture at all. */
    [[nodiscard]] bool requested() const {
        return BBLITE_VISUAL_CAPTURE &&
               (!options_->screenshot_path.empty() || !options_->id_buffer_path.empty() ||
                !options_->cluster_buffer_path.empty() || !options_->render_capture_path.empty());
    }

    [[nodiscard]] bool pending() const {
        return (!options_->screenshot_path.empty() && !screenshot_saved) ||
               (!options_->id_buffer_path.empty() && !id_buffer_saved) ||
               (!options_->cluster_buffer_path.empty() && !cluster_buffer_saved) ||
               (!options_->render_capture_path.empty() && !render_capture_saved);
    }

    /**
     * Whether the engine's own `stopEngine` has ended the run.
     *
     * The pin cancels its animation frame and clears `_renderFn`, so no
     * further frame submits and the canvas keeps what it last drew. Here
     * the loop keeps presenting that unchanged frame only while a capture
     * is still pending, so a screenshot lands on the frozen frame exactly
     * as the browser harness takes one off the frozen canvas -- and stops
     * the moment nothing is waiting for it.
     *
     * It lives here rather than at each call site for the reason this
     * class exists at all: there are six frame loops, and a rule spelled
     * six times is a rule that diverges. A loop with no engine to consult
     * (none today) is simply never stopped.
     */
    [[nodiscard]] bool engine_stopped() const { return engine_ != nullptr && engine_->stopped; }

    /**
     * Whether every bounded multi-frame drain the scene declared has
     * resolved. A scene that declares none is ready from frame zero.
     *
     * It lives here for the reason `engine_stopped` does: the condition
     * belongs to the run rather than to one renderer, and every loop that
     * hands this gate an engine gets the same answer.
     */
    [[nodiscard]] bool drains_resolved() const {
        if (engine_ == nullptr)
            return true;
        // `startEngine` resolves after its first render. The compiler queues
        // source following that await at the matching native frame boundary;
        // capturing while it is still pending would freeze the initial scene
        // instead of the state whose browser-ready marker follows it.
        if (engine_->pending_start_continuations != 0)
            return false;
        for (const std::function<bool()>& ready : engine_->capture_ready) {
            if (!ready || !ready())
                return false;
        }
        return true;
    }

    /** Whether the loop should run another frame. */
    [[nodiscard]] bool keep_running(bool running, long frame) const {
        // A measured run ends the moment a stopped engine has nothing
        // left to capture. An INTERACTIVE one does not: the browser's
        // `stopEngine` freezes the canvas and leaves the page up, so the
        // window stays, input keeps working and the frozen scene can
        // still be orbited -- which is the manual check every integration
        // owes before it is called done.
        if (engine_stopped() && requested() && !pending()) {
            return false;
        }
        if (!running || limit_ <= 0 || frame < limit_)
            return running;
        if (!pending())
            return false;
        // Past the budget, a pending capture keeps the loop alive while the
        // program's own start-up continuations are still draining -- a
        // scene that awaits nine frame boundaries before its state is
        // final (scene 118 waits, picks, then waits again) cannot be
        // captured before they resolve, and the browser harness waits for
        // that scene's ready marker the same way -- and then for a short
        // grace counted from the frame they resolved on, because the
        // capture check runs before the frame's drain and a topology
        // change defers a capture by one more frame. The drain cap bounds
        // a program that never resolves.
        if (!drains_resolved())
            return frame < limit_ + drain_cap_frames;
        if (drains_resolved_at_ < 0)
            drains_resolved_at_ = frame;
        return frame < std::max(limit_, drains_resolved_at_) + grace_frames;
    }

    static constexpr long grace_frames = 8;
    static constexpr long drain_cap_frames = 600;

private:
    const FrameOptions* options_;
    long limit_;
    const Engine* engine_;
    /** The first frame `keep_running` saw the drains resolved, or -1. */
    mutable long drains_resolved_at_ = -1;
};

/**
 * The benchmark summary every renderer prints -- both GPU frame loops
 * and their sprite variants. The numbers are compared across backends,
 * so both the shape of the line and the statistics behind it are
 * produced in exactly one place. The contract:
 * one line opening with the "Babylon Lite <backend> benchmark |
 * driver=<driver>" identity prefix that names the renderer, then
 * `frames=` and the average / median / p95 / min / max frame CPU times
 * in milliseconds, fixed three-decimal precision. Samples are the
 * post-warmup frames (`benchmark_warmup_frames` above holds the shared
 * warmup policy); an empty run prints nothing.
 */
void report_benchmark(std::vector<double> samples, const char* backend, const std::string& driver);

/**
 * The BBLITE_CPU_PROFILE startup marks both scene frame loops print --
 * the same phases under the same field names, so the lines are parsed
 * and compared across backends. One home keeps the format from
 * drifting; only the backend label differs:
 * `[cpu][<label>-startup] phase=<name> phase_ms=<ms> elapsed_ms=<ms>`.
 *
 * The instance is called like the lambda it replaced --
 * `cpu_startup_mark("render-plan")` -- and prints nothing when
 * profiling is off, while still anchoring its clock at construction.
 */
class CpuStartupMark {
public:
    CpuStartupMark(bool enabled, const char* label)
        : enabled_(enabled), label_(label), start_(monotonic_milliseconds()), previous_(start_) {}

    void operator()(const char* phase) {
        if (!enabled_)
            return;
        const double now = monotonic_milliseconds();
        std::fprintf(stderr, "[cpu][%s-startup] phase=%s phase_ms=%.3f elapsed_ms=%.3f\n", label_,
                     phase, now - previous_, now - start_);
        previous_ = now;
    }

private:
    bool enabled_;
    const char* label_;
    double start_;
    double previous_;
};

/**
 * The per-frame BBLITE_CPU_PROFILE line, printed by both scene frame
 * loops every 30th frame and on frames taking at least 10 ms, so the field
 * order lives once. `write_ms` is Dawn's own phase -- the per-draw
 * uniform writes WebGPU's no-push-constants model forces -- and the
 * field appears only when the caller measured one, so each backend's
 * line keeps exactly the bytes it always printed.
 */
inline bool frame_profile_due(long frame, double elapsed_ms) {
    return frame % 30 == 0 || elapsed_ms >= 10;
}

void print_cpu_frame_profile(long frame, double total_ms, double acquire_ms, double update_ms,
                             double upload_ms, const std::optional<double>& write_ms,
                             double encode_submit_ms, std::size_t render_items,
                             std::size_t draw_commands);

/**
 * The per-frame BBLITE_MEM_PROFILE line, printed by every frame loop on
 * the BBLITE_CPU_PROFILE cadence (every `memory_profile_frames`th frame),
 * so `scene -- memory` parses one format. It answers whether a long run
 * settles: the working set, how many mesh records the engine holds
 * against how many the scene still draws, the CPU geometry bytes still
 * allocated (a retired mesh's are released by removeFromScene), and the
 * backend's live GPU meshes and shared-geometry cache. A loop without a
 * scene or a geometry cache (the sprite renderers) prints zeros there.
 *
 * A process can run several engines at once (a Window host's canvases,
 * each on its realm's thread). Every loop counts its own frames and reads
 * its own thread's GC registry, so each prints one ordered stream under
 * its own `engine=` number, assigned in start order.
 */
inline constexpr long memory_profile_frames = 30;

class MemoryProfile {
public:
    [[nodiscard]] bool due(long frame) const {
        return stream_ != 0 && frame % memory_profile_frames == 0;
    }
    void print(long frame, const bbl::Engine& engine, std::size_t scene_meshes,
               std::size_t gpu_meshes, std::size_t shared_geometries,
               std::size_t shared_geometry_bytes) const;
    /** The scene-loop form: the backend's mesh list and shared-geometry cache. */
    template <typename GpuMesh, typename SharedGeometry>
    void print(long frame, const bbl::Engine& engine, const bbl::Scene& scene,
               const std::vector<GpuMesh>& gpu_meshes,
               const std::vector<std::unique_ptr<SharedGeometry>>& cache) const {
        // The cache's own vertex type (`GpuVertex`), named through the entry
        // so this header stays free of the scene-shaped vertex.
        using Vertex = typename decltype(SharedGeometry::vertices)::value_type;
        std::size_t bytes = 0;
        for (const auto& geometry : cache) {
            bytes += geometry->identity.vertex_count * sizeof(Vertex) +
                     geometry->identity.index_count * sizeof(std::uint32_t);
        }
        print(frame, engine, scene.meshes.size(), gpu_meshes.size(), cache.size(), bytes);
    }

private:
    static std::uint32_t start() {
        static std::atomic<std::uint32_t> started = 0;
        return environment_variable("BBLITE_MEM_PROFILE") == "1" ? ++started : 0;
    }
    const std::uint32_t stream_ = start();
};

/**
 * Refuse a flag this backend does not implement rather than rendering
 * something else: a silent no-op would be measured as a backend delta.
 * `backend` is the caller's own label; the text names no other backend,
 * because which one implements a diagnostic is that backend's to state.
 */
void reject_unsupported_frame_options(const FrameOptions& options, const char* backend,
                                      bool supports_single_sample, bool supports_copy_task);

} // namespace bbl::pal

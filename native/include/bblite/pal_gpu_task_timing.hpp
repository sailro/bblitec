#pragma once

#include <bblite/features/gpu_task_timing.hpp>
#include <bblite/features/workers.hpp>

#include <bblite/pal_offscreen.hpp>
#include <bblite/runtime.hpp>
#include <bblite/js_promise.hpp>

#include <any>
#include <cmath>
#include <limits>

namespace bbl::pal {

struct GpuTaskTimingEntry {
    double index = 0;
    std::string name;
    double duration_ms = 0;
};

struct GpuTaskTimingSnapshot {
    std::string status;
    bool supported = false;
    bool enabled = false;
    double frame_index = 0;
    std::vector<GpuTaskTimingEntry> tasks;
    double total_duration_ms = 0;
    double dropped_task_count = 0;
    std::optional<std::string> error;
    std::any projection;
};

template <typename Result, typename Project>
Result project_gpu_task_timing_snapshot(const std::shared_ptr<GpuTaskTimingSnapshot>& snapshot,
                                        Project&& project) {
    if (!snapshot)
        throw std::logic_error("GPU timing snapshot is missing.");
    if (!snapshot->projection.has_value())
        snapshot->projection = std::forward<Project>(project)(*snapshot);
    const auto* result = std::any_cast<Result>(&snapshot->projection);
    if (!result)
        throw std::logic_error("GPU timing snapshot has an incompatible projection.");
    return *result;
}

struct GpuTaskTimingRecord {
    double index = 0;
    std::string name;
    double begin_query_index = 0;
    double end_query_index = 0;
};

struct GpuTaskTimingReadback {
    std::shared_ptr<GpuTimestampReadback> readback;
    double frame_index = 0;
    std::vector<GpuTaskTimingRecord> records;
    double dropped_task_count = 0;
};

/** The source task whose passes are being timed (`ActiveTaskTiming`). */
struct GpuActiveTaskTiming {
    double begin_query_index = -1;
    double end_query_index = -1;
    double pass_count = 0;
    bool conflicted = false;
    bool dropped = false;
};

using GpuTaskTimingPublisher = std::function<void(std::shared_ptr<GpuTaskTimingSnapshot>)>;

inline std::uint32_t gpu_timestamp_index(double value) {
    if (value < 0 || value > std::numeric_limits<std::uint32_t>::max() ||
        std::trunc(value) != value)
        throw std::runtime_error("GPU timestamp index exceeds the native API range.");
    return static_cast<std::uint32_t>(value);
}

/** Policy methods are generated from the pinned GPU task timer. */
struct GpuTaskTimer {
    std::shared_ptr<OffscreenDevice> device;
    std::shared_ptr<GpuTimestampQuerySet> query_set;
    std::vector<GpuTaskTimingRecord> records;
    double task_capacity;
    double max_in_flight;
    std::optional<GpuActiveTaskTiming> active_task_timing;
    double next_query_index = 0;
    double next_task_index = 0;
    /** `gpuTaskTimerExecute`'s task index, held from its task's begin to its end. */
    double task_index = 0;
    double frame_index = 0;
    double last_published_frame_index = 0;
    double dropped_task_count = 0;
    double in_flight = 0;
    bool skip_frame = false;
    bool disposed = false;
    std::vector<GpuTaskTimingReadback> pending_readbacks;
    GpuTaskTimingPublisher publish;

    GpuTaskTimer(std::shared_ptr<OffscreenDevice> owner, double capacity, double maximum)
        : device(std::move(owner)),
          query_set(device->create_gpu_timestamp_query_set(gpu_timestamp_index(capacity * 2))),
          task_capacity(capacity), max_in_flight(maximum) {}

    void restore_timing_encoder();
    void begin_frame();
    /** Native execution brackets one source task with begin_task and end_task. */
    void begin_task();
    void end_task(const std::string& name);
    /** The timestamps of one source pass of the active task, if it gets any. */
    std::optional<GpuTaskPassTimestamps> pass_timestamps(bool has_timestamp_writes);
    void finish_frame();
    void publish_snapshot(std::shared_ptr<GpuTaskTimingSnapshot> snapshot);
    void poll();
    void dispose();
    void complete_readback(const GpuTaskTimingReadback& pending,
                           const std::vector<std::uint64_t>& raw);
    void fail_readback(const GpuTaskTimingReadback& pending, const std::string& error);

    GpuTimestampWrite timestamp_write(double index, bool beginning) const {
        return {query_set, gpu_timestamp_index(index), beginning};
    }
    GpuTaskPassTimestamps pass_writes(double begin, double end) const {
        return {timestamp_write(begin, true), timestamp_write(end, false)};
    }
    GpuTaskPassTimestamps end_write(double end) const {
        return {std::nullopt, timestamp_write(end, false)};
    }

    void enqueue_readback(double query_count, double frame,
                          std::vector<GpuTaskTimingRecord> frame_records, double dropped) {
        auto readback = device->resolve_gpu_timestamps(query_set, gpu_timestamp_index(query_count));
        pending_readbacks.push_back(
            {std::move(readback), frame, std::move(frame_records), dropped});
    }
};

/** `GpuFrameTimer`: the frame's query pair and its in-flight readbacks. */
struct GpuFrameTimer {
    std::shared_ptr<GpuTimestampQuerySet> query_set;
    std::vector<std::shared_ptr<GpuTimestampReadback>> pending;
    double last_ms = 0;
    double in_flight = 0;
};

struct GpuTaskTimingState {
    /** `setGpuTimingEnabled`: wanted state, the timer (unset, null or live) and its frame hooks. */
    bool frame_timer_wanted = false;
    std::optional<std::shared_ptr<GpuFrameTimer>> frame_timer;
    std::function<GpuTimestampWrite()> frame_timer_begin;
    std::function<GpuTimestampWrite()> frame_timer_end;
    std::function<void()> frame_timer_resolve;
    /** `engine.gpuFrameTimeMs`. */
    double gpu_frame_time_ms = 0;
    /** The frame in flight carries the opening marker. */
    bool frame_timer_begun = false;
    bool supported = false;
    bool wanted = false;
    double epoch = 0;
    std::shared_ptr<GpuTaskTimingSnapshot> result;
    std::shared_ptr<GpuTaskTimer> timer;
    std::function<void()> disable;
    std::shared_ptr<OffscreenDevice> device;

    std::shared_ptr<GpuTaskTimer> create_timer(double capacity, double max_in_flight) const {
        if (!device || !supported)
            throw std::runtime_error("This engine does not provide GPU timestamps.");
        return std::make_shared<GpuTaskTimer>(device, capacity, max_in_flight);
    }

    std::function<void()> install_timer(const std::shared_ptr<GpuTaskTimer>& installed,
                                        GpuTaskTimingPublisher publisher) {
        installed->publish = std::move(publisher);
        return [weak = std::weak_ptr<GpuTaskTimer>(installed)] {
            if (const auto value = weak.lock())
                value->dispose();
        };
    }
};

inline std::shared_ptr<GpuTaskTimingState> gpu_task_timing_state(Engine& engine) {
    if (!engine.gpu_task_timing) {
        auto state = std::make_shared<GpuTaskTimingState>();
#if BBLITE_WORKERS
        if (engine.offscreen_run && !engine.device_disposed) {
            state->device = std::shared_ptr<OffscreenDevice>(engine.offscreen_run,
                                                             &engine.offscreen_run->device());
            state->supported = state->device->supports_gpu_timestamps();
        }
#endif
        engine.gpu_task_timing = std::move(state);
    }
    return engine.gpu_task_timing;
}

inline std::shared_ptr<GpuTaskTimer> active_gpu_task_timer(const Engine& engine) {
    return engine.gpu_task_timing && engine.gpu_task_timing->wanted ? engine.gpu_task_timing->timer
                                                                    : nullptr;
}

/** Source task names, retained by each native frame-task facade. */
inline const std::string& gpu_timing_task_name(const FrameTaskRecord& task) {
    switch (task.kind) {
    case FrameTaskKind::render:
        return task.render.name;
    case FrameTaskKind::geometry:
        return task.geometry.name;
    case FrameTaskKind::copy:
        return task.copy.name;
    case FrameTaskKind::screen_space:
        return task.screen_space.name;
    case FrameTaskKind::post_process:
        return task.post_process.name;
    case FrameTaskKind::effect:
        return task.effect.name;
    case FrameTaskKind::compute:
        throw std::logic_error("Compute timing is recorded with its source command list.");
    }
    throw std::logic_error("Unknown native frame task kind.");
}

/**
 * Whether the source's copy task may copy without a pass (`tryBuildFastPath`),
 * where this port always blits. Formats, sizes and texture usage are known
 * only to the backends, so any copy the remaining conditions admit counts.
 */
inline bool copy_task_may_skip_pass(const Engine& engine, const CopyTaskOptions& copy) {
    if (copy.has_viewport || copy.resolve_target.value != invalid_handle)
        return false;
    const RenderTargetRecord& target = handle_at(engine.render_targets, copy.target);
    if (target.swapchain || !target.has_color || target.samples != 1)
        return false;
    return copy.source.source != RenderTextureSource::render_target ||
           handle_at(engine.render_targets, copy.source.target).samples == 1;
}

#if BBLITE_GPU_TASK_TIMING
inline void begin_gpu_task_timing_frame(Engine& engine) {
    if (const auto timer = active_gpu_task_timer(engine)) {
        timer->poll();
        timer->begin_frame();
    }
}

inline void finish_gpu_task_timing_frame(Engine& engine) {
    if (const auto timer = active_gpu_task_timer(engine))
        timer->finish_frame();
}

/** The frame timer's opening marker, written first into the frame's commands. */
inline std::optional<GpuTimestampWrite> gpu_frame_timer_begin(Engine& engine) {
    if (!engine.gpu_task_timing)
        return std::nullopt;
    auto& state = *engine.gpu_task_timing;
    state.frame_timer_begun = static_cast<bool>(state.frame_timer_begin);
    return state.frame_timer_begun ? std::optional(state.frame_timer_begin()) : std::nullopt;
}

/** The closing marker, written last before the frame's commands are submitted. */
inline std::optional<GpuTimestampWrite> gpu_frame_timer_end(Engine& engine) {
    if (!engine.gpu_task_timing || !engine.gpu_task_timing->frame_timer_begun ||
        !engine.gpu_task_timing->frame_timer_end)
        return std::nullopt;
    return engine.gpu_task_timing->frame_timer_end();
}

/** After the frame's submission, as the source's `_gpuTimerResolve`. */
inline void resolve_gpu_frame_timer(Engine& engine) {
    if (!engine.gpu_task_timing)
        return;
    auto& state = *engine.gpu_task_timing;
    if (std::exchange(state.frame_timer_begun, false) && state.frame_timer_resolve)
        state.frame_timer_resolve();
}

/**
 * Native execution of one frame graph's source tasks. `scoped_task` brackets a
 * task as `gpuTaskTimerExecute` does, and native code asks `pass` for the
 * timestamps of each pass the source task opens, as the source's patched
 * encoder does. One source shadow task spans the adjacent native caster tasks.
 */
class GpuTaskTimingSequence {
public:
    explicit GpuTaskTimingSequence(const Engine& engine, const Scene* scene = nullptr)
        : timer_(active_gpu_task_timer(engine)), scene_(scene) {
        if (!timer_ || !scene || !scene->state->shadow_task_name)
            return;
        const std::vector<TaskHandle> passes = scene->frame_passes();
        const bool has_casters = std::any_of(passes.begin(), passes.end(), [&](TaskHandle handle) {
            const auto& task = handle_at(engine.frame_tasks, handle);
            return task.kind == FrameTaskKind::render &&
                   task.render.shadow_generator.value != invalid_handle;
        });
        // The source's shadow task still runs; with no generator to render
        // it opens no pass.
        if (!has_casters) {
            timer_->begin_task();
            timer_->end_task(shadow_name());
        }
    }
    GpuTaskTimingSequence(const GpuTaskTimingSequence&) = delete;
    GpuTaskTimingSequence& operator=(const GpuTaskTimingSequence&) = delete;
    ~GpuTaskTimingSequence() noexcept(false) {
        if (std::uncaught_exceptions() == 0)
            finish_shadows();
    }

    auto scoped_task(const Engine& engine, TaskHandle handle) {
        const bool began = begin(engine, handle_at(engine.frame_tasks, handle));
        return js::finally([this, &engine, handle, began] {
            if (began && std::uncaught_exceptions() == 0)
                end(gpu_timing_task_name(handle_at(engine.frame_tasks, handle)));
        });
    }

    /** The timestamps of one pass the current source task opens, if it gets any. */
    std::optional<GpuTaskPassTimestamps> pass() {
        if (!timer_)
            return std::nullopt;
        ++passes_;
        return timer_->pass_timestamps(false);
    }

    /** The current task opens no pass in the source either. */
    void passless() { passless_ = true; }

    /** A source pass structure this port does not reproduce cannot be timed. */
    void refuse(const char* passes) const {
        if (timer_)
            throw std::runtime_error(std::string("GPU task timing does not represent the "
                                                 "source passes of ") +
                                     passes + ".");
    }

private:
    bool begin(const Engine& engine, const FrameTaskRecord& task) {
        if (!timer_)
            return false;
        if (task.kind == FrameTaskKind::screen_space)
            refuse("screen-space effect tasks");
        if (task.kind == FrameTaskKind::post_process && task.post_process.taa)
            refuse("temporal anti-aliasing tasks");
        if (task.kind == FrameTaskKind::copy && copy_task_may_skip_pass(engine, task.copy))
            refuse("copies the source may make without a pass");
        const bool shadow = task.kind == FrameTaskKind::render &&
                            task.render.shadow_generator.value != invalid_handle;
        if (!shadow)
            finish_shadows();
        if (task.kind == FrameTaskKind::compute)
            return false;
        if (shadow) {
            if (!shadows_started_) {
                (void)shadow_name(); // refuses a label-less task before it opens
                timer_->begin_task();
                shadows_started_ = true;
            }
            return false;
        }
        timer_->begin_task();
        passes_ = 0;
        passless_ = false;
        return true;
    }

    void end(const std::string& name) {
        // A native branch that asks for no pass would drop its task silently.
        if (passes_ == 0 && !passless_)
            throw std::logic_error("Native execution of task '" + name + "' timed no pass.");
        timer_->end_task(name);
    }

    void finish_shadows() {
        if (shadows_started_) {
            timer_->end_task(shadow_name());
            shadows_started_ = false;
        }
    }

    /** The source shadow task's label, read when it is recorded, as the source reads it. */
    const std::string& shadow_name() const {
        if (!scene_ || !scene_->state->shadow_task_name)
            throw std::logic_error("Native shadow passes have no source task label.");
        return *scene_->state->shadow_task_name;
    }
    std::shared_ptr<GpuTaskTimer> timer_;
    const Scene* scene_;
    bool shadows_started_ = false;
    std::size_t passes_ = 0;
    bool passless_ = false;
};
#else
/** Builds without `engine:gpu-task-timing` time nothing. */
inline void begin_gpu_task_timing_frame(Engine&) {}
inline void finish_gpu_task_timing_frame(Engine&) {}
inline std::optional<GpuTimestampWrite> gpu_frame_timer_begin(Engine&) { return std::nullopt; }
inline std::optional<GpuTimestampWrite> gpu_frame_timer_end(Engine&) { return std::nullopt; }
inline void resolve_gpu_frame_timer(Engine&) {}

class GpuTaskTimingSequence {
public:
    explicit GpuTaskTimingSequence(const Engine&, const Scene* = nullptr) {}
    auto scoped_task(const Engine&, TaskHandle) const {
        return js::finally([] {});
    }
    std::optional<GpuTaskPassTimestamps> pass() const { return std::nullopt; }
    void passless() const {}
    void refuse(const char*) const {}
};
#endif

} // namespace bbl::pal

namespace bbl {
std::shared_ptr<pal::GpuTaskTimingSnapshot>
make_gpu_task_timing_snapshot(std::string status, bool supported, bool enabled, double frame_index,
                              std::vector<pal::GpuTaskTimingEntry> tasks, double dropped_task_count,
                              double total_duration_ms,
                              std::optional<std::string> error = std::nullopt);
bool is_render_task_gpu_timing_supported(std::shared_ptr<pal::GpuTaskTimingState> engine);
std::shared_ptr<pal::GpuTaskTimingSnapshot>
get_render_task_gpu_timings(std::shared_ptr<pal::GpuTaskTimingState> engine);
js::Promise<std::shared_ptr<pal::GpuTaskTimingSnapshot>>
set_render_task_gpu_timing_enabled(std::shared_ptr<pal::GpuTaskTimingState> engine, bool enabled);
} // namespace bbl

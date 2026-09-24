#pragma once

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

struct GpuTaskTimingTask {
    GpuTimestampWrite begin;
    GpuTimestampWrite end;
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
    double frame_index = 0;
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

    void begin_frame();
    std::optional<GpuTaskTimingTask> begin_task(const std::string& name);
    void end_task(const GpuTimestampWrite& end, const std::string& name);
    void finish_frame();
    void poll();
    void dispose();
    void complete_readback(const GpuTaskTimingReadback& pending,
                           const std::vector<std::uint64_t>& raw);
    void fail_readback(const GpuTaskTimingReadback& pending, const std::string& error);

    GpuTaskTimingTask writes(double begin, double end) const {
        return {{query_set, gpu_timestamp_index(begin), true},
                {query_set, gpu_timestamp_index(end), false}};
    }

    void enqueue_readback(double query_count, double frame,
                          std::vector<GpuTaskTimingRecord> frame_records, double dropped) {
        auto readback = device->resolve_gpu_timestamps(query_set, gpu_timestamp_index(query_count));
        pending_readbacks.push_back(
            {std::move(readback), frame, std::move(frame_records), dropped});
    }
};

struct GpuTaskTimingState {
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

/** One source shadow task expands to several adjacent native caster passes. */
template <typename Write> class GpuTaskTimingSequence {
public:
    GpuTaskTimingSequence(const Engine& engine, Write write, const Scene* scene = nullptr)
        : timer_(active_gpu_task_timer(engine)), write_(std::move(write)) {
        if (!timer_ || !scene || !scene->state->shadow_task_name)
            return;
        shadow_name_ = scene->state->shadow_task_name;
        const bool has_casters =
            std::any_of(scene->tasks.begin(), scene->tasks.end(), [&](TaskHandle handle) {
                const auto& task = handle_at(engine.frame_tasks, handle);
                return task.kind == FrameTaskKind::render &&
                       task.render.shadow_generator.value != invalid_handle;
            });
        if (!has_casters) {
            if (const auto timed = timer_->begin_task(*shadow_name_)) {
                write_(timed->begin);
                timer_->end_task(timed->end, *shadow_name_);
                write_(timed->end);
            }
        }
    }
    GpuTaskTimingSequence(const GpuTaskTimingSequence&) = delete;
    GpuTaskTimingSequence& operator=(const GpuTaskTimingSequence&) = delete;
    ~GpuTaskTimingSequence() noexcept(false) {
        if (std::uncaught_exceptions() == 0)
            finish_shadows();
    }

    auto scoped_task(const Engine& engine, TaskHandle handle) {
        const auto marker = begin(handle_at(engine.frame_tasks, handle));
        return js::finally([this, &engine, handle, marker] {
            if (marker && std::uncaught_exceptions() == 0)
                end(*marker, handle_at(engine.frame_tasks, handle));
        });
    }

    std::optional<GpuTimestampWrite> begin(const FrameTaskRecord& task) {
        if (!timer_)
            return std::nullopt;
        const bool shadow = task.kind == FrameTaskKind::render &&
                            task.render.shadow_generator.value != invalid_handle;
        if (!shadow)
            finish_shadows();
        if (task.kind == FrameTaskKind::compute)
            return std::nullopt;
        if (shadow && shadows_started_)
            return std::nullopt;
        if (shadow && !shadow_name_)
            throw std::logic_error("Native shadow passes have no source task label.");
        const auto timed = timer_->begin_task(shadow ? *shadow_name_ : gpu_timing_task_name(task));
        if (shadow)
            shadows_started_ = true;
        if (!timed)
            return std::nullopt;
        write_(timed->begin);
        if (shadow) {
            shadows_end_ = timed->end;
            return std::nullopt;
        }
        return timed->end;
    }

    void end(const GpuTimestampWrite& marker, const FrameTaskRecord& task) {
        timer_->end_task(marker, gpu_timing_task_name(task));
        write_(marker);
    }

private:
    void finish_shadows() {
        if (shadows_end_) {
            timer_->end_task(*shadows_end_, *shadow_name_);
            write_(*shadows_end_);
            shadows_end_.reset();
        }
        shadows_started_ = false;
    }
    std::shared_ptr<GpuTaskTimer> timer_;
    Write write_;
    bool shadows_started_ = false;
    std::optional<std::string> shadow_name_;
    std::optional<GpuTimestampWrite> shadows_end_;
};

} // namespace bbl::pal

namespace bbl {
std::shared_ptr<pal::GpuTaskTimingSnapshot>
make_gpu_task_timing_snapshot(std::string status, bool supported, bool enabled, double frame_index,
                              std::vector<pal::GpuTaskTimingEntry> tasks, double dropped_task_count,
                              std::optional<std::string> error = std::nullopt);
bool is_render_task_gpu_timing_supported(std::shared_ptr<pal::GpuTaskTimingState> engine);
std::shared_ptr<pal::GpuTaskTimingSnapshot>
get_render_task_gpu_timings(std::shared_ptr<pal::GpuTaskTimingState> engine);
js::Promise<std::shared_ptr<pal::GpuTaskTimingSnapshot>>
set_render_task_gpu_timing_enabled(std::shared_ptr<pal::GpuTaskTimingState> engine, bool enabled);
} // namespace bbl

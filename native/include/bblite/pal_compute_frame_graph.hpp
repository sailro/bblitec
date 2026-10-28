#pragma once
#include <bblite/features/gpu_task_timing.hpp>

#include <bblite/pal_compute_task_execution.hpp>
#include <bblite/pal_frame_post_submit.hpp>
#include <span>
#if BBLITE_GPU_TASK_TIMING
#include <bblite/pal_gpu_task_timing.hpp>
#endif

namespace bbl {
void prepend_compute_frame_task(Engine&, std::vector<TaskHandle>&, TaskHandle);
void append_compute_frame_task(std::vector<TaskHandle>&, TaskHandle);
void record_compute_frame_task(const std::shared_ptr<ComputeTask>&);
double execute_compute_frame_tasks(std::span<const std::shared_ptr<ComputeTask>>);
inline std::string compute_frame_task_name(const Engine& engine, TaskHandle handle) {
    if (handle.value == invalid_handle)
        return {};
    const auto& task = handle_at(engine.frame_tasks, handle);
    if (task.compute)
        return task.compute->name;
    return task.kind == FrameTaskKind::render &&
                   task.render.shadow_generator.value != invalid_handle
               ? "shadow"
               : "";
}
/** One source shadow task expands to all of its native caster/cascade passes. */
inline std::size_t compute_frame_native_insertion_index(const Engine& engine,
                                                        const std::vector<TaskHandle>& tasks,
                                                        double source_index) {
    if (source_index == 0.0)
        return 0;
    if (source_index != 1.0)
        throw std::runtime_error("Unsupported source compute prefix insertion index.");
    std::size_t index = 0;
    while (index < tasks.size() && compute_frame_task_name(engine, tasks[index]) == "shadow")
        ++index;
    return index;
}
inline TaskHandle retain_compute_frame_task(Engine& engine,
                                            const std::shared_ptr<ComputeTask>& task) {
    if (task->engine.get() != &engine)
        throw std::runtime_error("Compute frame task belongs to a different engine.");
    for (std::size_t index = 0; index < engine.frame_tasks.size(); ++index)
        if (engine.frame_tasks[index].compute == task)
            return {static_cast<std::uint32_t>(index)};
    if (engine.frame_tasks.size() >= invalid_handle)
        throw std::runtime_error("Native frame task handle space exhausted.");
    const TaskHandle handle{static_cast<std::uint32_t>(engine.frame_tasks.size())};
    FrameTaskRecord record;
    record.kind = FrameTaskKind::compute;
    record.compute = task;
    engine.frame_tasks.push_back(std::move(record));
    return handle;
}
inline void add_task(Scene& scene, const std::shared_ptr<ComputeTask>& task) {
    if (!scene.engine)
        throw std::runtime_error("Scene is not associated with an engine.");
    append_compute_frame_task(scene.tasks, retain_compute_frame_task(*scene.engine, task));
}
inline void add_task_at_start(Scene& scene, const std::shared_ptr<ComputeTask>& task) {
    if (!scene.engine)
        throw std::runtime_error("Scene is not associated with an engine.");
    prepend_compute_frame_task(*scene.engine, scene.tasks,
                               retain_compute_frame_task(*scene.engine, task));
}
inline void add_task(FrameGraphContext& graph, const std::shared_ptr<ComputeTask>& task) {
    if (!graph.engine)
        throw std::runtime_error("Frame graph is not associated with an engine.");
    append_compute_frame_task(graph.tasks, retain_compute_frame_task(*graph.engine, task));
}
inline void add_task_at_start(FrameGraphContext& graph, const std::shared_ptr<ComputeTask>& task) {
    if (!graph.engine)
        throw std::runtime_error("Frame graph is not associated with an engine.");
    prepend_compute_frame_task(*graph.engine, graph.tasks,
                               retain_compute_frame_task(*graph.engine, task));
}

struct ComputeFramePrefix {
    std::vector<std::shared_ptr<ComputeTask>> tasks;
    bool leading_shadows = false;
};

/** Source system shadows may precede the first user compute tasks. */
inline ComputeFramePrefix collect_compute_frame_prefix(const Engine& engine) {
    ComputeFramePrefix prefix;
    bool render_started = false;
    for (const auto& scene : engine.scenes()) {
        if (!scene)
            continue;
#if BBLITE_GPU_TASK_TIMING
        if (prefix.tasks.empty() && !render_started && scene->state->shadow_task_name &&
            pal::active_gpu_task_timer(engine))
            prefix.leading_shadows = true;
#endif
        for (const auto handle : scene->frame_passes()) {
            const auto& record = handle_at(engine.frame_tasks, handle);
            if (!frame_task_executes(record))
                continue;
            if (record.kind != FrameTaskKind::compute) {
                if (prefix.tasks.empty() && !render_started &&
                    record.kind == FrameTaskKind::render &&
                    record.render.shadow_generator.value != invalid_handle) {
                    prefix.leading_shadows = true;
                    continue;
                }
                render_started = true;
                continue;
            }
            if (render_started)
                throw std::runtime_error(
                    "Compute tasks after rendering require an interleaved queue adapter.");
            if (!record.compute)
                throw std::runtime_error("Compute frame task has no retained source task.");
            prefix.tasks.push_back(record.compute);
        }
    }
    for (const auto& graph : engine.frame_graph_contexts())
        for (const auto handle : graph->tasks)
            if (handle_at(engine.frame_tasks, handle).kind == FrameTaskKind::compute)
                throw std::runtime_error(
                    "Standalone compute frame graphs require a native queue adapter.");
    return prefix;
}

/** The frame's prefix already recorded (its encoder finished). */
inline bool compute_frame_prefix_recorded(const Engine& engine) {
    return engine.current_compute_encoder && engine.current_compute_encoder->finished;
}

inline bool compute_frame_prefix_deferred(const Engine& engine) {
    if (engine.stopped || compute_frame_prefix_recorded(engine))
        return false;
    const auto prefix = collect_compute_frame_prefix(engine);
    return prefix.leading_shadows && !prefix.tasks.empty();
}

/** Execute after a leading system-shadow submission, or before rendering when none exists. */
inline void begin_compute_frame_prefix(Engine& engine, bool shadows_submitted = false) {
    if (engine.stopped)
        return;
    const auto prefix = collect_compute_frame_prefix(engine);
    if (prefix.tasks.empty() || (prefix.leading_shadows && !shadows_submitted))
        return;
    if (compute_frame_prefix_recorded(engine))
        throw std::runtime_error("Compute frame encoder is already active.");
    if (!engine.offscreen_run)
        throw std::runtime_error("Compute frame requires an owned graphics device.");
    // The frame's encoder when a frame scope opened it (`FramePostSubmitScope`).
    if (!engine.current_compute_encoder)
        engine.current_compute_encoder = frame_compute_encoder(engine);
    const auto encoder = engine.current_compute_encoder;
    try {
        for (const auto& task : prefix.tasks)
            if (!task->pass && !task->execute)
                record_compute_frame_task(task);
#if BBLITE_GPU_TASK_TIMING
        if (const auto timer = pal::active_gpu_task_timer(engine)) {
            encoder->timed_pass = [timer] { return timer->pass_timestamps(false); };
            for (const auto& task : prefix.tasks) {
                if (!task->execution_enabled)
                    continue;
                timer->begin_task();
                (void)execute_compute_frame_tasks(std::span(&task, 1));
                timer->end_task(task->name);
            }
            encoder->timed_pass = nullptr;
        } else
#endif
            (void)execute_compute_frame_tasks(prefix.tasks);
        encoder->finish();
        encoder->submit();
    } catch (...) {
        engine.current_compute_encoder.reset();
        throw;
    }
}
/** Match the source post-submit boundary after the frame's render queue submission. */
inline void finish_compute_frame_prefix(Engine& engine) {
    if (!engine.current_compute_encoder)
        return;
    try {
        if (engine.gpu_timer_resolve)
            engine.gpu_timer_resolve(engine.current_compute_encoder, true);
    } catch (...) {
        engine.current_compute_encoder.reset();
        throw;
    }
    engine.current_compute_encoder.reset();
}
} // namespace bbl

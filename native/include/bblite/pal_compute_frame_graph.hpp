#pragma once
#include <bblite/pal_compute_task_execution.hpp>

namespace bbl {
void prepend_compute_frame_task(Engine&, std::vector<TaskHandle>&, TaskHandle);
void append_compute_frame_task(std::vector<TaskHandle>&, TaskHandle);
void record_compute_frame_task(const std::shared_ptr<ComputeTask>&);
double execute_compute_frame_tasks(const std::vector<std::shared_ptr<ComputeTask>>&);
inline std::string compute_frame_task_name(const Engine& engine, TaskHandle handle) {
    if (handle.value == invalid_handle)
        return {};
    const auto& task = engine.frame_tasks.at(handle.value);
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
    for (const auto& scene : engine.registered_scenes) {
        if (!scene)
            continue;
        for (const auto handle : scene->tasks) {
            const auto& record = engine.frame_tasks.at(handle.value);
            if (record.execution_enabled == false)
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
    for (const auto& graph : engine.registered_frame_graph_contexts)
        for (const auto handle : graph->tasks)
            if (engine.frame_tasks.at(handle.value).kind == FrameTaskKind::compute)
                throw std::runtime_error(
                    "Standalone compute frame graphs require a native queue adapter.");
    return prefix;
}

inline bool compute_frame_prefix_deferred(const Engine& engine) {
    if (engine.stopped || engine.current_compute_encoder)
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
    if (engine.current_compute_encoder)
        throw std::runtime_error("Compute frame encoder is already active.");
    if (!engine.offscreen_run)
        throw std::runtime_error("Compute frame requires an owned graphics device.");
    auto encoder =
        std::make_shared<pal::ComputeCommandEncoder>(std::shared_ptr<pal::OffscreenDevice>(
            engine.offscreen_run, &engine.offscreen_run->device()));
    engine.current_compute_encoder = encoder;
    try {
        for (const auto& task : prefix.tasks)
            if (!task->pass && !task->execute)
                record_compute_frame_task(task);
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
        if (engine.compute_one_shot_frame_submitted)
            engine.compute_one_shot_frame_submitted();
    } catch (...) {
        engine.current_compute_encoder.reset();
        throw;
    }
    engine.current_compute_encoder.reset();
}
} // namespace bbl

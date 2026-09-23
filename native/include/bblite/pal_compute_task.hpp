#pragma once

#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>

namespace bbl {
struct ComputeDispatch;
struct ComputeUniformArena;
namespace pal {
struct ComputeCommandEncoder;
}

/** Native ownership of a recorded frame-graph compute pass. */
struct ComputeTaskPass {
    virtual ~ComputeTaskPass() = default;
    virtual void dispose() = 0;
    virtual double execute() {
        throw std::runtime_error("Compute task pass has no execution body.");
    }
    virtual void gc_trace(const js::TraceVisitor&) const {}
};

struct ComputeTask {
    std::shared_ptr<Engine> engine;
    std::string name;
    bool execution_enabled = false;
    bool disposed = false;
    js::Array<std::shared_ptr<ComputeDispatch>> dispatches;
    js::Array<std::shared_ptr<ComputeTaskPass>> passes;
    std::shared_ptr<ComputeTaskPass> pass;
    js::Array<std::shared_ptr<ComputeUniformArena>> uniform_arenas;
    js::Callback<void()> flush_owned;
    js::Callback<void()> dispose_owned;
    js::Callback<void(std::shared_ptr<pal::ComputeCommandEncoder>)> one_shot_recorded;
    js::Callback<void()> one_shot_dispose;
    js::Callback<void()> dispose;
    js::Callback<void()> record;
    js::Callback<double()> execute;

    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(engine);
        visitor(dispatches);
        visitor(passes);
        visitor(pass);
        visitor(uniform_arenas);
        visitor(flush_owned);
        visitor(dispose_owned);
        visitor(one_shot_recorded);
        visitor(one_shot_dispose);
        visitor(dispose);
        visitor(record);
        visitor(execute);
    }
};

std::shared_ptr<ComputeTask> create_compute_task(std::shared_ptr<Engine> engine,
                                                 std::optional<std::string> name = {});
inline std::string& compute_task_name(const std::shared_ptr<ComputeTask>& task) {
    return task->name;
}
inline bool& compute_task_execution_enabled(const std::shared_ptr<ComputeTask>& task) {
    return task->execution_enabled;
}
inline bool compute_task_disposed(const std::shared_ptr<ComputeTask>& task) {
    return task->disposed;
}
inline js::Callback<void()>& compute_task_dispose(const std::shared_ptr<ComputeTask>& task) {
    return task->dispose;
}
inline js::Callback<void()>& compute_task_record(const std::shared_ptr<ComputeTask>& task) {
    return task->record;
}
} // namespace bbl

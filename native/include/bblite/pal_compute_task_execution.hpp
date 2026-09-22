#pragma once
#include <bblite/pal_compute_task.hpp>
#include <bblite/pal_compute_dispatch.hpp>
#include <bblite/pal_compute_command.hpp>
#include <bblite/js_promise_all.hpp>

namespace bbl {
struct ComputeValidatedBindings {
    std::set<std::shared_ptr<ComputeBindingSet>> values;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(values); }
};
struct ComputeRecordingCache {
    std::shared_ptr<ComputeValidatedBindings> validated;
    js::Array<std::shared_ptr<pal::ComputeBindGroup>> last_groups;
    ComputeOffsetGroups last_offsets;
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(validated);
        visitor(last_offsets);
    }
};
struct ComputeRecordedPass final : ComputeTaskPass {
    std::string name;
    std::shared_ptr<ComputeTask> parent;
    js::Callback<bool()> enabled;
    js::Callback<void(pal::ComputePassEncoder&)> body;
    js::Callback<void()> before;
    js::Callback<void()> execute_func;
    std::set<std::shared_ptr<void>> dependencies;
    double execute() override;
    void dispose() override;
    void gc_trace(const js::TraceVisitor& visitor) const override {
        visitor(parent);
        visitor(enabled);
        visitor(body);
        visitor(before);
        visitor(execute_func);
    }
};
void initialize_compute_task_execution(const std::shared_ptr<ComputeTask>&);
void add_compute_dispatch(const std::shared_ptr<ComputeTask>&,
                          const std::shared_ptr<ComputeDispatch>&);
void remove_compute_dispatch(const std::shared_ptr<ComputeTask>&,
                             const std::shared_ptr<ComputeDispatch>&);
void submit_compute_tasks(const std::vector<std::shared_ptr<ComputeTask>>&);
js::Promise<js::PromiseVoid> prepare_compute_task(std::shared_ptr<ComputeTask>);
} // namespace bbl

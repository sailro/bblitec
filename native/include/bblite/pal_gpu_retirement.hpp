#pragma once

#include <bblite/js_promise.hpp>
#include <algorithm>
#include <functional>
#include <iostream>
#include <memory>
#include <vector>

namespace bbl::pal {

using GpuRetirement = std::function<void()>;
using GpuRetirementBatch = std::shared_ptr<std::vector<GpuRetirement>>;
using GpuRetirementBatches = std::vector<GpuRetirementBatch>;
using GpuRetirementSet = std::shared_ptr<GpuRetirementBatches>;
using GpuCompletion = js::Promise<js::PromiseVoid>;

/** Representation and platform seams; the pinned module owns the retirement protocol. */
struct GpuRetirementState {
    GpuRetirementBatch pending;
    GpuRetirementSet retiring;
    std::function<void(std::shared_ptr<GpuRetirementState>)> flush;
    std::function<GpuCompletion()> submitted_work_done;
};

template <typename T, typename Make> T& gpu_ensure(T& value, Make make) {
    if (!value)
        value = make();
    return value;
}
inline void gpu_set_add(const GpuRetirementSet& values, const GpuRetirementBatch& value) {
    if (std::find(values->begin(), values->end(), value) == values->end())
        values->push_back(value);
}
inline bool gpu_set_delete(const GpuRetirementSet& values, const GpuRetirementBatch& value) {
    return std::erase(*values, value) != 0;
}
inline GpuRetirementBatch gpu_splice_all(const GpuRetirementBatch& value) {
    auto result = std::make_shared<std::vector<GpuRetirement>>();
    result->swap(*value);
    return result;
}
inline void gpu_retirement_error(const std::string& message, std::exception_ptr error) {
    std::cerr << message << " " << js::promise_error_message(error) << '\n';
}

} // namespace bbl::pal

namespace bbl {
void run_gpu_resource_callbacks(pal::GpuRetirementBatch disposers);
void retire_gpu_resources(std::shared_ptr<pal::GpuRetirementState> engine,
                          pal::GpuRetirement retirement);
void retire_gpu_resource_batch(std::shared_ptr<pal::GpuRetirementState> engine,
                               pal::GpuRetirementBatch disposers);
void flush_gpu_resource_retirements(std::shared_ptr<pal::GpuRetirementState> engine);
pal::GpuCompletion
wait_for_gpu_resource_retirements(std::shared_ptr<pal::GpuRetirementState> engine);
void dispose_gpu_resource_retirements(std::shared_ptr<pal::GpuRetirementState> engine);
} // namespace bbl

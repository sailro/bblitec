#pragma once
#include <bblite/pal_compute_task.hpp>
#include <bblite/pal_compute_command.hpp>
#include <bblite/pal_async_engine.hpp>
#include <bblite/js_error.hpp>
#include <bblite/pal_frame_post_submit.hpp>

namespace bbl {
struct ComputeOneShot {
    std::shared_ptr<ComputeTask> task;
    js::Promise<js::PromiseVoid> completion;
    double generation = 0;
    bool armed = false, disposed = false;
    js::Callback<void()> resolve;
    js::Callback<void(std::exception_ptr)> reject;
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(task);
        visitor(completion);
        visitor(resolve);
        visitor(reject);
    }
};
using ComputeOneShotBatch = js::Map<std::shared_ptr<ComputeOneShot>, double>;
struct ComputeOneShotCompletion {
    js::Callback<void()> resolve;
    js::Callback<void(std::exception_ptr)> reject;
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(resolve);
        visitor(reject);
    }
};
struct ComputeOneShotState {
    std::weak_ptr<Engine> engine;
    js::Set<std::shared_ptr<ComputeOneShot>> shots;
    js::WeakMap<std::shared_ptr<ComputeOneShotBatch>> recorded;
    js::Callback<void()> remove_post_submit;
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(shots);
        visitor(recorded);
        visitor(remove_post_submit);
    }
};
/** The installed engine callback owns each live state; this index owns neither. */
struct ComputeOneShotRegistry {
    std::map<std::weak_ptr<Engine>, std::weak_ptr<ComputeOneShotState>,
             std::owner_less<std::weak_ptr<Engine>>>
        values;
};
inline std::shared_ptr<ComputeOneShotState>
find_compute_one_shot_state(const std::shared_ptr<Engine>& engine) {
    auto& values = js::realm_scratch<ComputeOneShotRegistry>().values;
    const auto found = values.find(engine);
    return found == values.end() ? nullptr : found->second.lock();
}
std::shared_ptr<ComputeOneShot> create_compute_one_shot(const std::shared_ptr<ComputeTask>& task);
js::Promise<js::PromiseVoid> arm_compute_one_shot(const std::shared_ptr<ComputeOneShot>& oneShot);
void dispose_compute_one_shot(const std::shared_ptr<ComputeOneShot>& oneShot);
inline js::Promise<js::PromiseVoid>
compute_one_shot_completion(const std::shared_ptr<ComputeOneShot>& oneShot) {
    return oneShot->completion;
}
} // namespace bbl

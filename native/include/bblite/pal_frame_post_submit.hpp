#pragma once
#include <bblite/pal_compute_command.hpp>
#include <bblite/pal_event_loop.hpp>

namespace bbl {
struct FramePostSubmitHook {
    js::Callback<void(std::shared_ptr<pal::ComputeCommandEncoder>)> run;
    js::Callback<void()> cancel;
    std::shared_ptr<pal::ComputeCommandEncoder> encoder;
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(run);
        visitor(cancel);
    }
};
struct FramePostSubmitState {
    js::Set<std::shared_ptr<FramePostSubmitHook>> hooks;
    js::Callback<void(std::shared_ptr<pal::ComputeCommandEncoder>, bool)> dispatch;
    std::shared_ptr<pal::ComputeCommandEncoder> last_dispatched_encoder;
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(hooks);
        visitor(dispatch);
    }
};
struct FramePostSubmitRegistry {
    std::map<std::weak_ptr<Engine>, std::weak_ptr<FramePostSubmitState>,
             std::owner_less<std::weak_ptr<Engine>>> values;
};
inline std::shared_ptr<FramePostSubmitState> find_frame_post_submit_state(const std::shared_ptr<Engine>& engine) {
    auto& values = js::realm_scratch<FramePostSubmitRegistry>().values;
    const auto found = values.find(engine);
    return found == values.end() ? nullptr : found->second.lock();
}
} // namespace bbl

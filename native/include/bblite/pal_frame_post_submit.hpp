#pragma once
#include <bblite/pal_compute_command.hpp>
#include <bblite/pal_event_loop.hpp>
#include <bblite/runtime.hpp>

#include <utility>

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
             std::owner_less<std::weak_ptr<Engine>>>
        values;
};
inline std::shared_ptr<FramePostSubmitState>
find_frame_post_submit_state(const std::shared_ptr<Engine>& engine) {
    auto& values = js::realm_scratch<FramePostSubmitRegistry>().values;
    const auto found = values.find(engine);
    return found == values.end() ? nullptr : found->second.lock();
}

/** engine.ts `renderFrame`'s frame encoder, on the engine's offscreen device when it owns one. */
inline std::shared_ptr<pal::ComputeCommandEncoder> frame_compute_encoder(const Engine& engine) {
    return std::make_shared<pal::ComputeCommandEncoder>(
        engine.offscreen_run ? std::shared_ptr<pal::OffscreenDevice>(
                                   engine.offscreen_run, &engine.offscreen_run->device())
                             : nullptr);
}

/**
 * engine.ts `renderFrame`'s frame scope in a scene renderer: from the frame's
 * update, `current_compute_encoder` names the frame (the encoder a compute
 * prefix records into, `begin_compute_frame_prefix`), so frame-scoped
 * post-submit hooks key to it. Once the frame's command buffer is submitted
 * its hooks run (`gpu_timer_resolve`) and `finish_optional_frame(true)`
 * follows; a frame that ends unsubmitted finishes with `false`.
 */
class FramePostSubmitScope {
public:
    explicit FramePostSubmitScope(Engine& engine) : engine_(&engine) {
        if (!engine.current_compute_encoder)
            engine.current_compute_encoder = frame_compute_encoder(engine);
        encoder_ = engine.current_compute_encoder;
    }
    FramePostSubmitScope(const FramePostSubmitScope&) = delete;
    FramePostSubmitScope& operator=(const FramePostSubmitScope&) = delete;
    ~FramePostSubmitScope() {
        if (!engine_)
            return;
        try {
            close(false);
        } catch (...) {
            // The frame's own failure is what propagates.
        }
    }
    /** After the frame's submission (a compute prefix already resolved its own). */
    void submitted() { close(true); }

private:
    void close(bool submitted) {
        Engine& engine = *std::exchange(engine_, nullptr);
        if (engine.current_compute_encoder == encoder_) {
            if (submitted && engine.gpu_timer_resolve)
                engine.gpu_timer_resolve(encoder_, true);
            engine.current_compute_encoder.reset();
        }
        if (engine.finish_optional_frame)
            engine.finish_optional_frame(submitted);
    }

    Engine* engine_;
    std::shared_ptr<pal::ComputeCommandEncoder> encoder_;
};

/** frame-post-submit.ts (generated `upstream/src/frame_post_submit.cpp`, `engine:frame-post-submit`). */
void release_frame_post_submit_state(const std::shared_ptr<Engine>& engine,
                                     const std::shared_ptr<FramePostSubmitState>& state);
js::Callback<void()>
add_frame_post_submit_hook(const std::shared_ptr<Engine>& engine, const std::string& scope,
                           js::Callback<void(std::shared_ptr<pal::ComputeCommandEncoder>)> hook,
                           js::Callback<void()> cancel = {});
} // namespace bbl

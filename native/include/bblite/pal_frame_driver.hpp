#pragma once

#if defined(BBLITE_WORKERS) && BBLITE_WORKERS
#include <bblite/js_data.hpp>
#include <bblite/js_promise.hpp>
#include <bblite/pal_animation_frame.hpp>
#include <bblite/pal_offscreen.hpp>
#include <bblite/runtime.hpp>

namespace bbl::pal {

class OffscreenContinuation final : public ContinuationContext {
  public:
    explicit OffscreenContinuation(std::shared_ptr<OffscreenRun> run) : run_(std::move(run)) {}
    void enter() override { binding_.emplace(*run_); }
    void leave() noexcept override { binding_.reset(); }
  private:
    std::shared_ptr<OffscreenRun> run_;
    std::optional<OffscreenRun::Binding> binding_;
};

/** A renderer keeps its existing local GPU state between realm animation tasks. */
class FrameDriver {
    struct State {
        EventLoop* loop = &EventLoop::current();
        EventLoop::ContinuationId continuation = 0;
        js::Promise<js::PromiseVoid> ready;
        js::Promise<bool> finished;
        bool started = false;
        std::uint64_t capture_remaining = 0;
        void schedule() const {
            loop->request_animation_frame([loop = loop, id = continuation](double) { loop->resume_continuation(id); });
        }
    };
  public:
    js::Promise<js::PromiseVoid> ready() const { return state_->ready; }
    js::Promise<bool> finished() const { return state_->finished; }
    void start() const {
        if (state_->started) return;
        state_->started = true;
        state_->schedule();
    }
    struct promise_type {
        std::shared_ptr<State> state = std::make_shared<State>();
        std::shared_ptr<ContinuationContext> context;
        explicit promise_type(Engine& engine) {
            if (!engine.offscreen_run) throw std::logic_error("A realm renderer requires a canvas presentation endpoint.");
            const auto& frames = engine.offscreen_run->animation_frames();
            if (!frames) throw std::logic_error("A realm renderer requires its owner Window's animation frame source.");
            frames->subscribe(state->loop->inbox());
            state->capture_remaining = engine.offscreen_run->capture_frame_count();
            context = std::make_shared<OffscreenContinuation>(engine.offscreen_run);
        }
        FrameDriver get_return_object() {
            state->continuation = state->loop->own_continuation(std::coroutine_handle<promise_type>::from_promise(*this), context);
            return FrameDriver(state);
        }
        std::suspend_always initial_suspend() const noexcept { return {}; }
        std::suspend_never final_suspend() const noexcept { return {}; }
        std::suspend_always yield_value(bool rendered) {
            if (rendered) state->ready.resolve(js::PromiseVoid{});
            // Keep the final GPU frame and suspended renderer alive until the
            // Window has captured every engine and tears down the realm.
            if (rendered && state->capture_remaining && --state->capture_remaining == 0) return {};
            state->schedule();
            return {};
        }
        void return_value(bool ran) { state->finished.resolve(ran); }
        void unhandled_exception() {
            try { throw; }
            catch (const WorkerTerminated&) {}
            catch (...) {
                state->ready.reject(std::current_exception());
                state->finished.reject(std::current_exception());
            }
        }
        ~promise_type() { if (state->continuation) state->loop->release_continuation(state->continuation); }
    };
  private:
    explicit FrameDriver(std::shared_ptr<State> state) : state_(std::move(state)) {}
    std::shared_ptr<State> state_;
};

using SceneRun = FrameDriver;
} // namespace bbl::pal

#define BBLITE_RUN_RETURN(value) co_return value
#define BBLITE_FRAME_YIELD(rendered) co_yield rendered
#else
namespace bbl::pal { using SceneRun = bool; }
#define BBLITE_RUN_RETURN(value) return value
#define BBLITE_FRAME_YIELD(rendered) static_cast<void>(0)
#endif

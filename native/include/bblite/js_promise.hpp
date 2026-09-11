#pragma once

#include <bblite/js_callback.hpp>
#include <bblite/pal_event_loop.hpp>

#include <optional>
#include <variant>

namespace bbl::js {

/** A fulfilled Promise<void> still has one internal settlement value. */
struct PromiseVoid {};
template <typename T> class Promise;

namespace promise_detail {
template <typename T> struct State {
    using Fulfilled = Callback<void(const T&)>;
    using Rejected = Callback<void(std::exception_ptr)>;
    struct Reaction {
        Fulfilled fulfilled;
        Rejected rejected;
        void gc_trace(const TraceVisitor& visitor) const { visitor(fulfilled); visitor(rejected); }
    };
    pal::EventLoop* loop = &pal::EventLoop::current();
    std::thread::id owner = std::this_thread::get_id();
    std::variant<std::monostate, T, std::exception_ptr> outcome;
    std::vector<Reaction> reactions;
    bool resolving = false;
    bool handled = false;
    void require_owner() const {
        if (owner != std::this_thread::get_id()) throw std::logic_error("A Promise crossed realm ownership.");
    }
    void gc_trace(const TraceVisitor& visitor) const {
        if (const auto* value = std::get_if<T>(&outcome)) visitor(*value);
        for (const auto& reaction : reactions) visitor(reaction);
    }
};
template <typename T> struct Result { using type = T; };
template <> struct Result<void> { using type = PromiseVoid; };
template <typename T> struct Result<Promise<T>> { using type = T; };
template <typename T> using ResultType = typename Result<T>::type;
} // namespace promise_detail

/** Realm-local promise state. Every reaction, including a settled one, is a microtask. */
template <typename T> class Promise {
    using State = promise_detail::State<T>;
    using Reaction = typename State::Reaction;
  public:
    Promise() : state_(make_gc_shared<State>()) {}
    void gc_trace(const TraceVisitor& visitor) const { visitor(state_); }
    bool pending() const { state_->require_owner(); return std::holds_alternative<std::monostate>(state_->outcome); }

    static Promise resolved(T value) { Promise promise; promise.resolve(std::move(value)); return promise; }
    static Promise rejected(std::exception_ptr error) { Promise promise; promise.reject(error); return promise; }

    void resolve(T value) const {
        state_->require_owner();
        if (state_->resolving) return;
        state_->resolving = true;
        settle(std::move(value));
    }
    void resolve(const Promise& other) const {
        state_->require_owner();
        if (state_->resolving) return;
        state_->resolving = true;
        if (state_ == other.state_) { settle(std::make_exception_ptr(std::runtime_error("Promise cannot resolve to itself"))); return; }
        other.observe(
            make_closure(std::tuple{*this}, [](auto& environment, const T& value) { std::get<0>(environment).settle(value); }),
            make_closure(std::tuple{*this}, [](auto& environment, std::exception_ptr error) { std::get<0>(environment).settle(error); }));
    }
    void reject(std::exception_ptr error) const {
        state_->require_owner();
        if (state_->resolving) return;
        state_->resolving = true;
        settle(error);
    }
    void observe(typename State::Fulfilled fulfilled, typename State::Rejected rejected) const {
        state_->require_owner();
        state_->handled = true;
        Reaction reaction{std::move(fulfilled), std::move(rejected)};
        if (std::holds_alternative<std::monostate>(state_->outcome)) state_->reactions.push_back(std::move(reaction));
        else enqueue(std::move(reaction));
    }
    template <typename F> auto then(F callback) const {
        using Returned = std::invoke_result_t<F&, const T&>;
        using U = promise_detail::ResultType<Returned>;
        Promise<U> next;
        observe(make_closure(std::tuple{std::move(callback), next}, [](auto& environment, const T& value) {
            auto& [callback, next] = environment;
            try {
                if constexpr (std::is_void_v<Returned>) { callback(value); next.resolve(PromiseVoid{}); }
                else next.resolve(callback(value));
            } catch (const pal::WorkerTerminated&) { throw; }
            catch (...) { next.reject(std::current_exception()); }
        }), make_closure(std::tuple{next}, [](auto& environment, std::exception_ptr error) { std::get<0>(environment).reject(error); }));
        return next;
    }
    template <typename F> Promise catch_error(F callback) const {
        Promise next;
        observe(make_closure(std::tuple{next}, [](auto& environment, const T& value) { std::get<0>(environment).resolve(value); }),
            make_closure(std::tuple{std::move(callback), next}, [](auto& environment, std::exception_ptr error) {
                auto& [callback, next] = environment;
                try {
                    if constexpr (std::is_void_v<std::invoke_result_t<F&, std::exception_ptr>>) {
                        static_assert(std::is_same_v<T, PromiseVoid>, "A value promise needs a recovery value.");
                        callback(error); next.resolve(PromiseVoid{});
                    } else next.resolve(callback(error));
                } catch (const pal::WorkerTerminated&) { throw; }
                catch (...) { next.reject(std::current_exception()); }
            }));
        return next;
    }

    struct promise_type {
        Promise result;
        pal::EventLoop* loop = &pal::EventLoop::current();
        pal::EventLoop::ContinuationId continuation = 0;
        Promise get_return_object() {
            continuation = loop->own_continuation(std::coroutine_handle<promise_type>::from_promise(*this));
            return result;
        }
        std::suspend_never initial_suspend() const noexcept { return {}; }
        std::suspend_never final_suspend() const noexcept { return {}; }
        void return_value(T value) { result.resolve(std::move(value)); }
        void return_value(const Promise& value) { result.resolve(value); }
        void unhandled_exception() {
            try { throw; }
            catch (const pal::WorkerTerminated&) {} // Realm shutdown discards this activation.
            catch (...) { result.reject(std::current_exception()); }
        }
        ~promise_type() { if (continuation) loop->release_continuation(continuation); }
    };
    struct Awaiter {
        std::shared_ptr<State> state;
        bool await_ready() const noexcept { return false; }
        template <typename P> void await_suspend(std::coroutine_handle<P> continuation) {
            const auto id = continuation.promise().continuation;
            auto* loop = state->loop;
            Promise(state).observe([loop, id](const T&) { loop->resume_continuation(id); },
                                   [loop, id](std::exception_ptr) { loop->resume_continuation(id); });
        }
        T await_resume() const {
            if (const auto* error = std::get_if<std::exception_ptr>(&state->outcome)) std::rethrow_exception(*error);
            return std::get<T>(state->outcome);
        }
    };
    Awaiter operator co_await() const { state_->require_owner(); return Awaiter{state_}; }

  private:
    explicit Promise(std::shared_ptr<State> state) : state_(std::move(state)) {}
    template <typename Outcome> void settle(Outcome value) const {
        if (!std::holds_alternative<std::monostate>(state_->outcome)) return;
        state_->outcome = std::move(value);
        if (std::holds_alternative<std::exception_ptr>(state_->outcome) && !state_->handled) {
            state_->loop->after_microtasks([state = state_] {
                if (state->handled) return;
                state->loop->post([state] {
                    if (!state->handled) state->loop->report_unhandled_rejection(std::get<std::exception_ptr>(state->outcome));
                });
            });
        }
        auto reactions = std::move(state_->reactions);
        for (auto& reaction : reactions) enqueue(std::move(reaction));
    }
    void enqueue(Reaction reaction) const {
        state_->loop->queue_microtask([state = state_, reaction = std::move(reaction)] {
            if (const auto* value = std::get_if<T>(&state->outcome)) reaction.fulfilled(*value);
            else reaction.rejected(std::get<std::exception_ptr>(state->outcome));
        });
    }
    std::shared_ptr<State> state_;
};

inline std::string promise_error_string(std::exception_ptr error) {
    try { std::rethrow_exception(error); }
    catch (const std::exception& problem) { return std::string("Error: ") + problem.what(); }
    catch (...) { return "Error"; }
}

} // namespace bbl::js

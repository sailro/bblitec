#pragma once

#include <bblite/js_callback.hpp>
#include <bblite/pal_event_loop.hpp>

#include <optional>
#include <variant>

namespace bbl::js {

/** A fulfilled Promise<void> still has one internal settlement value. */
struct PromiseVoid {};
template <typename T> class Promise;

template <typename T, typename Convert> struct PromiseAdoption {
    Promise<T> source;
    Convert convert;
};

template <typename T, typename Convert>
auto adopt_promise(Promise<T> source, Convert convert) {
    return PromiseAdoption<T, Convert>{std::move(source), std::move(convert)};
}

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
    template <typename> friend class Promise;
    using State = promise_detail::State<T>;
    using Reaction = typename State::Reaction;
    struct View {
        virtual ~View() = default;
        virtual const void* get() const noexcept = 0;
        virtual void require_owner() const = 0;
        virtual pal::EventLoop* event_loop() const = 0;
        virtual bool pending() const = 0;
        virtual T result() const = 0;
        virtual void observe(typename State::Fulfilled, typename State::Rejected) const = 0;
        virtual void gc_trace(const TraceVisitor&) const = 0;
    };
    template <typename U, typename Convert> struct ResultView final : View {
        Promise<U> source;
        Convert convert;
        ResultView(Promise<U> input, Convert conversion) : source(std::move(input)), convert(std::move(conversion)) {}
        const void* get() const noexcept override { return source.get(); }
        void require_owner() const override { source.require_owner(); }
        pal::EventLoop* event_loop() const override { return source.event_loop(); }
        bool pending() const override { return source.pending(); }
        T result() const override { return convert(source.result_value()); }
        void observe(typename State::Fulfilled fulfilled, typename State::Rejected rejected) const override {
            source.observe(make_closure(std::tuple{convert, std::move(fulfilled)}, [](auto& environment, const U& value) {
                std::get<1>(environment)(std::get<0>(environment)(value));
            }), std::move(rejected));
        }
        void gc_trace(const TraceVisitor& visitor) const override { visitor(source); visitor(convert); }
    };
  public:
    Promise() : state_(make_gc_shared<State>()) {}
    const void* get() const noexcept { return view_ ? view_->get() : state_.get(); }
    template <typename U> bool operator==(const Promise<U>& other) const noexcept { return get() == other.get(); }
    void gc_trace(const TraceVisitor& visitor) const { visitor(state_); visitor(view_); }
    bool pending() const { require_owner(); return view_ ? view_->pending() : std::holds_alternative<std::monostate>(state_->outcome); }

    /** Change only the native result view; identity and reaction registration stay on the original promise. */
    template <typename U, typename Convert> static Promise view(Promise<U> source, Convert convert) {
        return Promise({}, make_gc_shared<ResultView<U, Convert>>(std::move(source), std::move(convert)));
    }

    static Promise resolved(T value) { Promise promise; promise.resolve(std::move(value)); return promise; }
    static Promise rejected(std::exception_ptr error) { Promise promise; promise.reject(error); return promise; }

    void resolve(T value) const {
        require_resolver();
        if (state_->resolving) return;
        state_->resolving = true;
        settle(std::move(value));
    }
    void resolve(const Promise& other) const {
        adopt(other, [](const T& value) { return value; });
    }
    template <typename U, typename Convert> void adopt(const Promise<U>& other, Convert convert) const {
        require_resolver();
        if (state_->resolving) return;
        state_->resolving = true;
        if (get() == other.get()) { settle(std::make_exception_ptr(std::runtime_error("Promise cannot resolve to itself"))); return; }
        // Resolution locks immediately; invoking the adopted promise's then
        // protocol is a separate job, even when it is already fulfilled.
        state_->loop->queue_microtask([result = *this, other, convert = std::move(convert)]() mutable {
            other.observe(
                make_closure(std::tuple{result, std::move(convert)}, [](auto& environment, const U& value) {
                    try { std::get<0>(environment).settle(std::get<1>(environment)(value)); }
                    catch (const pal::WorkerTerminated&) { throw; }
                    catch (...) { std::get<0>(environment).settle(std::current_exception()); }
                }),
                make_closure(std::tuple{result}, [](auto& environment, std::exception_ptr error) { std::get<0>(environment).settle(error); }));
        });
    }
    void reject(std::exception_ptr error) const {
        require_resolver();
        if (state_->resolving) return;
        state_->resolving = true;
        settle(error);
    }
    void observe(typename State::Fulfilled fulfilled, typename State::Rejected rejected) const {
        require_owner();
        if (view_) { view_->observe(std::move(fulfilled), std::move(rejected)); return; }
        state_->handled = true;
        Reaction reaction{std::move(fulfilled), std::move(rejected)};
        if (std::holds_alternative<std::monostate>(state_->outcome)) state_->reactions.push_back(std::move(reaction));
        else enqueue(std::move(reaction));
    }
    template <typename F> auto then(F callback) const {
        using Returned = std::invoke_result_t<F&, const T&>;
        using U = promise_detail::ResultType<Returned>;
        Promise<U> next;
        observe(settling_reaction<const T&>(std::move(callback), next),
            make_closure(std::tuple{next}, [](auto& environment, std::exception_ptr error) { std::get<0>(environment).reject(error); }));
        return next;
    }
    template <typename F, typename G> auto then(F fulfilled, G rejected) const {
        using U = promise_detail::ResultType<std::invoke_result_t<F&, const T&>>;
        Promise<U> next;
        observe(settling_reaction<const T&>(std::move(fulfilled), next),
            settling_reaction<std::exception_ptr>(std::move(rejected), next));
        return next;
    }
    template <typename F> Promise catch_error(F callback) const {
        Promise next;
        observe(make_closure(std::tuple{next}, [](auto& environment, const T& value) { std::get<0>(environment).resolve(value); }),
            settling_reaction<std::exception_ptr>(std::move(callback), next));
        return next;
    }

    Promise finally() const {
        return then([](const T& value) { return value; });
    }
    template <typename F> Promise finally(F callback) const {
        auto fulfilled = make_closure(std::tuple{callback}, [](auto& environment, const T& value) {
            return cleanup_result(std::get<0>(environment)).then(
                make_closure(std::tuple{value}, [](auto& saved, const auto&) { return std::get<0>(saved); }));
        });
        auto rejected = make_closure(std::tuple{std::move(callback)}, [](auto& environment, std::exception_ptr error) {
            return cleanup_result(std::get<0>(environment)).then(
                make_closure(std::tuple{error}, [](auto& saved, const auto&) -> T { std::rethrow_exception(std::get<0>(saved)); }));
        });
        return then(std::move(fulfilled), std::move(rejected));
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
        template <typename U, typename Convert> void return_value(PromiseAdoption<U, Convert> value) {
            result.adopt(value.source, std::move(value.convert));
        }
        void unhandled_exception() {
            try { throw; }
            catch (const pal::WorkerTerminated&) {} // Realm shutdown discards this activation.
            catch (...) { result.reject(std::current_exception()); }
        }
        ~promise_type() { if (continuation) loop->release_continuation(continuation); }
    };
    struct Awaiter {
        std::shared_ptr<State> state;
        std::shared_ptr<View> view;
        bool await_ready() const noexcept { return false; }
        template <typename P> void await_suspend(std::coroutine_handle<P> continuation) {
            const auto id = continuation.promise().continuation;
            const Promise source(state, view);
            auto* loop = source.event_loop();
            source.observe([loop, id](const T&) { loop->resume_continuation(id); },
                           [loop, id](std::exception_ptr) { loop->resume_continuation(id); });
        }
        T await_resume() const {
            return Promise(state, view).result_value();
        }
    };
    Awaiter operator co_await() const { require_owner(); return Awaiter{state_, view_}; }

  private:
    template <typename F> static auto cleanup_result(F& callback) {
        using Returned = std::invoke_result_t<F&>;
        using U = promise_detail::ResultType<Returned>;
        if constexpr (std::is_void_v<Returned>) {
            callback();
            return Promise<PromiseVoid>::resolved({});
        } else if constexpr (std::is_same_v<Returned, Promise<U>>) return callback();
        else return Promise<U>::resolved(callback());
    }

    template <typename Argument, typename F, typename U>
    static auto settling_reaction(F callback, Promise<U> next) {
        return make_closure(std::tuple{std::move(callback), next}, [](auto& environment, Argument value) {
            auto& [callback, next] = environment;
            try {
                if constexpr (std::is_void_v<std::invoke_result_t<F&, Argument>>) {
                    static_assert(std::is_same_v<U, PromiseVoid>, "A value promise needs a settlement value.");
                    callback(value); next.resolve(PromiseVoid{});
                } else next.resolve(callback(value));
            } catch (const pal::WorkerTerminated&) { throw; }
            catch (...) { next.reject(std::current_exception()); }
        });
    }

    explicit Promise(std::shared_ptr<State> state, std::shared_ptr<View> view = {}) : state_(std::move(state)), view_(std::move(view)) {}
    void require_owner() const { if (view_) view_->require_owner(); else state_->require_owner(); }
    void require_resolver() const {
        require_owner();
        if (view_) throw std::logic_error("A promise result view does not expose a resolver.");
    }
    pal::EventLoop* event_loop() const { return view_ ? view_->event_loop() : state_->loop; }
    T result_value() const {
        if (view_) return view_->result();
        if (const auto* error = std::get_if<std::exception_ptr>(&state_->outcome)) std::rethrow_exception(*error);
        return std::get<T>(state_->outcome);
    }
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
    std::shared_ptr<View> view_;
};

inline std::string promise_error_message(std::exception_ptr error) {
    try { std::rethrow_exception(error); }
    catch (const std::exception& problem) { return problem.what(); }
    catch (...) { return ""; }
}

inline std::string promise_error_string(std::exception_ptr error) {
    try { std::rethrow_exception(error); }
    catch (const std::exception& problem) { return std::string("Error: ") + problem.what(); }
    catch (...) { return "Error"; }
}

} // namespace bbl::js

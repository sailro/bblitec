#pragma once

#include <bblite/features/workers.hpp>

#include <bblite/js_callback.hpp>
#include <bblite/js_data.hpp>
#include <bblite/js_error.hpp>
#include <bblite/js_gc.hpp>
#if BBLITE_WORKERS
#include <bblite/pal_event_loop.hpp>
#endif

#include <algorithm>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace bbl::js {

/** The DOMException `AbortSignal.abort()` and `controller.abort()` use without a reason. */
[[nodiscard]] inline Error abort_error(std::string message = "signal is aborted without reason") {
    return std::make_exception_ptr(make_dom_exception(std::move(message), "AbortError"));
}

/**
 * A realm-owned AbortSignal (DOM Standard). Copies share one signal object. Abort runs the
 * native abort algorithms (transport cancellation) first, then the `abort` listeners in
 * registration order, synchronously and once; a listener added after abort never runs.
 * Listeners are keyed by (callback identity, capture), as `addEventListener` keys them.
 */
class AbortSignal {
public:
    using Listener = Callback<void()>;
    /** A native abort algorithm: transport-side data only, no JavaScript values. */
    using Algorithm = std::function<void(const Error&)>;
    using AlgorithmId = std::uint64_t;

    AbortSignal() = default;
    [[nodiscard]] static AbortSignal create() {
        AbortSignal signal;
        signal.state_ = make_gc_shared<State>();
        return signal;
    }

    [[nodiscard]] bool aborted() const { return state().aborted; }
    /** `signal.reason`: absent (undefined) until aborted. */
    [[nodiscard]] Nullable<Error> reason() const {
        const auto& current = state();
        return current.reason ? Nullable<Error>(*current.reason) : Nullable<Error>();
    }
    /** `signal.throwIfAborted()`. */
    void throw_if_aborted() const {
        if (state().aborted)
            std::rethrow_exception(*state().reason);
    }

    /** `signal.addEventListener("abort", listener, { capture, once })`; `identity` is the
     * listener's function identity, which `remove_abort_listener` names. */
    void add_abort_listener(std::size_t identity, Listener listener, bool once = false,
                            bool capture = false) const {
        if (!listener)
            return;
        auto& current = state();
        for (const auto& entry : current.listeners)
            if (!entry->removed && entry->identity == identity && entry->capture == capture)
                return;
        current.listeners.push_back(
            make_gc_shared<Entry>(Entry{identity, std::move(listener), once, capture, false}));
    }
    void add_abort_listener(const Listener& listener, bool once = false,
                            bool capture = false) const {
        add_abort_listener(listener.identity(), listener, once, capture);
    }
    /** `signal.removeEventListener("abort", listener, { capture })`. */
    void remove_abort_listener(std::size_t identity, bool capture = false) const {
        auto& current = state();
        const auto found = std::find_if(
            current.listeners.begin(), current.listeners.end(), [&](const auto& entry) {
                return !entry->removed && entry->identity == identity && entry->capture == capture;
            });
        if (found == current.listeners.end())
            return;
        (*found)->removed = true;
        current.listeners.erase(found);
    }
    void remove_abort_listener(const Listener& listener, bool capture = false) const {
        remove_abort_listener(listener.identity(), capture);
    }

    /** Register a native abort algorithm; one already aborted signal runs none. */
    [[nodiscard]] AlgorithmId add_algorithm(Algorithm algorithm) const {
        auto& current = state();
        if (current.aborted)
            throw std::logic_error("An aborted signal takes no abort algorithm.");
        const auto id = current.next_algorithm++;
        current.algorithms.emplace_back(id, std::move(algorithm));
        return id;
    }
    void remove_algorithm(AlgorithmId id) const {
        if (!state_)
            return;
        auto& algorithms = state_->algorithms;
        algorithms.erase(std::remove_if(algorithms.begin(), algorithms.end(),
                                        [&](const auto& entry) { return entry.first == id; }),
                         algorithms.end());
    }

    /** The DOM's "signal abort": a missing reason is a new AbortError DOMException. */
    void signal_abort(std::optional<Error> reason = std::nullopt) const {
        auto& current = state();
        if (current.aborted)
            return;
        current.aborted = true;
        current.reason = reason ? std::move(*reason) : abort_error();
        const Error settled = *current.reason;
        auto algorithms = std::move(current.algorithms);
        current.algorithms.clear();
        for (auto& [id, algorithm] : algorithms) {
            static_cast<void>(id);
            algorithm(settled);
        }
        // Dispatch walks a snapshot; a listener removed by an earlier one does not run.
        const auto listeners = current.listeners;
        for (const auto& entry : listeners) {
            if (entry->removed)
                continue;
            if (entry->once) {
                entry->removed = true;
                std::erase(current.listeners, entry);
            }
            invoke(entry->callback);
        }
    }

    [[nodiscard]] const void* get() const noexcept { return state_.get(); }
    explicit operator bool() const noexcept { return static_cast<bool>(state_); }
    [[nodiscard]] friend bool operator==(const AbortSignal& left, const AbortSignal& right) {
        return left.state_ == right.state_;
    }
    void gc_trace(const TraceVisitor& visitor) const { visitor(state_); }

private:
    struct Entry {
        std::size_t identity = 0;
        Listener callback;
        bool once = false;
        bool capture = false;
        bool removed = false;
        void gc_trace(const TraceVisitor& visitor) const { visitor(callback); }
    };
    struct State {
        bool aborted = false;
        std::optional<Error> reason;
        std::vector<std::shared_ptr<Entry>> listeners;
        std::vector<std::pair<AlgorithmId, Algorithm>> algorithms;
        AlgorithmId next_algorithm = 1;
        void gc_trace(const TraceVisitor& visitor) const {
            visitor(reason);
            visitor(listeners);
        }
    };

    State& state() const {
        if (!state_)
            throw std::runtime_error("AbortSignal receiver is absent.");
        return *state_;
    }
    static void invoke(const Listener& listener) {
#if BBLITE_WORKERS
        // A listener's exception is reported; abort() and later listeners continue.
        pal::EventLoop::current().dispatch_synchronous_callback([listener] { listener(); });
#else
        listener();
#endif
    }

    std::shared_ptr<State> state_;
};

/**
 * A realm-owned AbortController. A controller owns exactly one signal, so the signal's
 * object is the controller's identity; copies share both.
 */
class AbortController {
public:
    AbortController() = default;
    [[nodiscard]] static AbortController create() {
        AbortController controller;
        controller.signal_ = AbortSignal::create();
        return controller;
    }
    /** `controller.signal`: the same signal object on every read. */
    [[nodiscard]] const AbortSignal& signal() const {
        if (!signal_)
            throw std::runtime_error("AbortController receiver is absent.");
        return signal_;
    }
    /** `controller.abort(reason?)`. */
    void abort(std::optional<Error> reason = std::nullopt) const {
        signal().signal_abort(std::move(reason));
    }
    [[nodiscard]] const void* get() const noexcept { return signal_.get(); }
    explicit operator bool() const noexcept { return static_cast<bool>(signal_); }
    [[nodiscard]] friend bool operator==(const AbortController& left,
                                         const AbortController& right) {
        return left.signal_ == right.signal_;
    }
    void gc_trace(const TraceVisitor& visitor) const { visitor(signal_); }

private:
    AbortSignal signal_;
};

} // namespace bbl::js

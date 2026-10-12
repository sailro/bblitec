#pragma once

// The asynchronous half of what the record lowerer
// (src/lowering/pinned-record-lowerer.ts) spells: `new Promise(executor)`
// with its resolving functions, `await` of a value that may be absent, and
// the `finally` guard of an async function, which an abandoned activation
// does not run. Async functions themselves are C++20 coroutines over
// `js::Promise` (`js_promise.hpp`).

#include <bblite/js_promise.hpp>
#include <bblite/pinned_values.hpp>

#include <exception>
#include <stdexcept>
#include <tuple>
#include <type_traits>
#include <utility>

namespace bbl::pinned {

/** The resolve function `new Promise<T>` hands its executor (none for `Promise<void>`). */
template <class T>
using PromiseResolve = std::conditional_t<std::is_same_v<T, js::PromiseVoid>, js::Callback<void()>,
                                          js::Callback<void(T)>>;
using PromiseReject = js::Callback<void(js::Error)>;

/**
 * `new Promise<T>((resolve, reject) => ...)`: the executor runs now; its
 * resolving functions settle the promise once (later calls do nothing); an
 * executor that throws rejects it. Rejecting with no reason rejects with
 * `undefined`.
 */
template <class T, class Executor>
[[nodiscard]] js::Promise<T> construct_promise(Executor&& executor) {
    js::Promise<T> promise;
    PromiseResolve<T> resolve;
    if constexpr (std::is_same_v<T, js::PromiseVoid>)
        resolve = js::make_closure(std::tuple{promise}, [](auto& captured) {
            std::get<0>(captured).resolve(js::PromiseVoid{});
        });
    else
        resolve = js::make_closure(std::tuple{promise}, [](auto& captured, T value) {
            std::get<0>(captured).resolve(std::move(value));
        });
    PromiseReject reject(
        js::make_closure(std::tuple{promise}, [](auto& captured, js::Error reason) {
            const std::exception_ptr thrown = reason;
            std::get<0>(captured).reject(thrown ? thrown : std::make_exception_ptr(ThrownValue()));
        }));
    try {
        executor(resolve, reject);
    } catch (const pal::WorkerTerminated&) {
        throw;
    } catch (...) {
        promise.reject(std::current_exception());
    }
    return promise;
}

/** `Promise.reject(reason)`. */
template <class T> [[nodiscard]] js::Promise<T> rejected_promise(const js::Error& reason) {
    const std::exception_ptr thrown = reason;
    return js::Promise<T>::rejected(thrown ? thrown : std::make_exception_ptr(ThrownValue()));
}

/** `await promise?.method()`: an absent promise awaits `undefined`. */
[[nodiscard]] inline js::Promise<js::PromiseVoid>
present_promise(const js::Nullable<js::Promise<js::PromiseVoid>>& value) {
    return value ? *value : js::Promise<js::PromiseVoid>::resolved({});
}

/** Whether the realm is releasing its suspended activations (an abandoned activation runs no `finally`). */
[[nodiscard]] inline bool realm_discarding() {
    try {
        return pal::EventLoop::current().aborting();
    } catch (const std::logic_error&) {
        return false;
    }
}

/**
 * A `finally` block of an async function: run on every exit of its scope
 * (explicitly before an exception propagates), but not when the realm
 * destroys the suspended activation.
 */
template <class F> class AsyncFinally {
public:
    explicit AsyncFinally(F action) : action_(std::move(action)) {}
    AsyncFinally(const AsyncFinally&) = delete;
    AsyncFinally& operator=(const AsyncFinally&) = delete;
    ~AsyncFinally() noexcept(false) {
        if (pending_ && !realm_discarding())
            run();
    }
    void run() {
        if (!pending_)
            return;
        pending_ = false;
        action_();
    }

private:
    F action_;
    bool pending_ = true;
};

template <class F> [[nodiscard]] AsyncFinally<std::decay_t<F>> async_finally(F&& action) {
    return AsyncFinally<std::decay_t<F>>(std::forward<F>(action));
}

} // namespace bbl::pinned

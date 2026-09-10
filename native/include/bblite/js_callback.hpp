#pragma once

#include <bblite/js_gc.hpp>
#if defined(BBLITE_WORKERS) && BBLITE_WORKERS
#include <bblite/js_realm_state.hpp>
#endif

#include <cstddef>
#include <functional>
#include <limits>
#include <memory>
#include <tuple>
#include <type_traits>
#include <utility>

namespace bbl::js {

template <typename Sig>
class Callback;

/** A compiler-described closure. The invoker receives the live environment,
 * so tracing observes replaced captures and shared mutable cells as they are. */
template <typename Environment, typename Invoke>
struct Closure {
    Environment environment;
    Invoke invoke;
    template <typename... Args>
    std::invoke_result_t<Invoke&, Environment&, Args...> operator()(Args&&... args) {
        return invoke(environment, std::forward<Args>(args)...);
    }
    void gc_trace(const TraceVisitor& visitor) const { visitor(environment); }
};

template <typename Invoke, typename Signature>
struct ClosureInvoker;

template <typename Invoke, typename R, bool Noexcept, typename... Args>
struct ClosureInvoker<Invoke, R (*)(Args...) noexcept(Noexcept)> {
    static R call(Args... args) noexcept(Noexcept) {
        Invoke invoke;
        return invoke(std::forward<Args>(args)...);
    }
};

template <typename Environment, typename Invoke>
[[nodiscard]] auto make_closure(Environment environment, Invoke invoke) {
    static_assert(std::is_empty_v<Invoke>, "Closure invokers must not hide captures.");
    if constexpr (requires {
        requires std::is_trivially_default_constructible_v<Invoke>;
        requires std::is_trivially_destructible_v<Invoke>;
        requires std::is_pointer_v<decltype(+invoke)>;
        requires std::is_function_v<std::remove_pointer_t<decltype(+invoke)>>;
    }) {
        // Keep nested lambda scope names out of callback and GC ownership RTTI.
        // Ordinary dispatch avoids the compiler's large lambda conversion thunks.
        return Closure<Environment, decltype(+invoke)>{
            std::move(environment), &ClosureInvoker<Invoke, decltype(+invoke)>::call};
    } else {
        return Closure<Environment, Invoke>{std::move(environment), std::move(invoke)};
    }
}

/** Direct recursive calls share automatic callable storage. */
template <typename... Functions>
struct RecursiveGroup {
    std::tuple<Functions...> functions;
    template <std::size_t Index, typename... Args>
    std::invoke_result_t<std::tuple_element_t<Index, std::tuple<Functions...>>&, RecursiveGroup&, Args...>
    call(Args&&... args) {
        return std::get<Index>(functions)(*this, std::forward<Args>(args)...);
    }
};

template <typename... Functions>
[[nodiscard]] auto make_recursive_group(Functions... functions) {
    return RecursiveGroup<Functions...>{std::tuple<Functions...>{std::move(functions)...}};
}

inline std::size_t next_callback_identity() {
#if defined(BBLITE_WORKERS) && BBLITE_WORKERS
    return realm_state.callback_identity++;
#else
    static std::size_t next = std::numeric_limits<std::size_t>::max() / 2;
    return next++;
#endif
}

/** A JavaScript function object: copies share identity and mutable captures. */
template <typename R, typename... Args>
class Callback<R(Args...)> {
    struct Body {
        virtual ~Body() = default;
        virtual R call(Args... args) = 0;
        virtual bool present() const = 0;
    };
    template <typename F> struct Callable final : Body {
        explicit Callable(F body) : function(std::move(body)) {}
        F function;
        R call(Args... args) override { return function(std::forward<Args>(args)...); }
        bool present() const override {
            if constexpr (requires { function.operator bool(); }) return function.operator bool();
            else if constexpr (std::is_pointer_v<F>) return function != nullptr;
            else return true;
        }
        void gc_trace(const TraceVisitor& visitor) const { visitor(function); }
    };
  public:
    Callback() = default;
    Callback(std::nullptr_t) noexcept {}
    template <typename F>
        requires (!std::is_same_v<std::remove_cvref_t<F>, Callback>)
    Callback(F&& body)
        : Callback(next_callback_identity(), std::forward<F>(body)) {}
    template <typename F>
    Callback(std::size_t identity, F&& body)
        : identity_(identity),
          body_(make_gc_shared<Callable<std::decay_t<F>>>(
              std::forward<F>(body))) {}

    R operator()(Args... args) const {
        const auto body = body_;
        if (!body) throw std::bad_function_call();
        if (recursive_owner_) {
            // Recursive reads need their cell even if the call replaces itself.
            const auto owner = recursive_owner_;
            return body->call(std::forward<Args>(args)...);
        }
        return body->call(std::forward<Args>(args)...);
    }
    explicit operator bool() const { return body_ && body_->present(); }
    [[nodiscard]] std::size_t identity() const { return identity_; }
    void gc_trace(const TraceVisitor& visitor) const { visitor(body_); visitor(recursive_owner_); }
    // Erasing identity still shares mutable captures and retains any recursive
    // owner. Copying the pointed-to function would lose the aliasing owner.
    [[nodiscard]] std::function<R(Args...)> body() const {
        return *this ? std::function<R(Args...)>(*this) : std::function<R(Args...)>{};
    }
    [[nodiscard]] static Callback retain(std::shared_ptr<Callback> owner) {
        if (!owner) throw std::bad_function_call();
        Callback retained;
        retained.identity_ = owner->identity_;
        // The cell can be reassigned during invocation. Pin its current body
        // independently while retaining the cell for weak recursive reads.
        retained.body_ = owner->body_;
        retained.recursive_owner_ = std::move(owner);
        return retained;
    }
    [[nodiscard]] friend bool operator==(const Callback& left, const Callback& right) {
        return left.identity_ == right.identity_;
    }

  private:
    std::size_t identity_ = 0;
    // A dispatch snapshot retains the closure without resetting its local state.
    std::shared_ptr<Body> body_;
    std::shared_ptr<Callback> recursive_owner_;
};

// A recursive body holds only a weak reference to its own storage. Every
// outward function value retains that storage, including a self reference
// passed to another callback, so the final outward release reclaims it.
template <typename R, typename... Args>
[[nodiscard]] Callback<R(Args...)> retain_callback(
    std::shared_ptr<Callback<R(Args...)>> owner) {
    return Callback<R(Args...)>::retain(std::move(owner));
}

} // namespace bbl::js

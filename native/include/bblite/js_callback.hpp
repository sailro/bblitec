#pragma once

#include <bblite/js_gc.hpp>

#include <cstddef>
#include <functional>
#include <limits>
#include <memory>
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
    decltype(auto) operator()(Args&&... args) {
        return invoke(environment, std::forward<Args>(args)...);
    }
    void gc_trace(const TraceVisitor& visitor) const { visitor(environment); }
};

template <typename Environment, typename Invoke>
[[nodiscard]] auto make_closure(Environment environment, Invoke invoke) {
    static_assert(std::is_empty_v<Invoke>, "Closure invokers must not hide captures.");
    return Closure<Environment, Invoke>{std::move(environment), std::move(invoke)};
}

inline std::size_t next_callback_identity() {
    static std::size_t next = std::numeric_limits<std::size_t>::max() / 2;
    return next++;
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
            if constexpr (requires { static_cast<bool>(function); }) return static_cast<bool>(function);
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
        const Callback retained = *this;
        if (!retained.body_) throw std::bad_function_call();
        return retained.body_->call(std::forward<Args>(args)...);
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

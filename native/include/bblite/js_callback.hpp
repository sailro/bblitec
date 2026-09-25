#pragma once

#include <bblite/js_gc.hpp>
#include <bblite/js_realm_state.hpp>

#include <cstddef>
#include <functional>
#include <limits>
#include <memory>
#include <tuple>
#include <type_traits>
#include <utility>

namespace bbl::js {

template <typename Sig> class Callback;

/** A compiler-described closure. The invoker receives the live environment,
 * so tracing observes replaced captures and shared mutable cells as they are. */
template <typename Environment, typename Invoke> struct Closure {
    Environment environment;
    Invoke invoke;
    template <typename... Args>
    std::invoke_result_t<Invoke&, Environment&, Args...> operator()(Args&&... args) {
        return invoke(environment, std::forward<Args>(args)...);
    }
    void gc_trace(const TraceVisitor& visitor) const { visitor(environment); }
};

namespace gc {
/** A closure owns traced edges only through its environment. */
template <typename Environment, typename Invoke>
struct Traceable<Closure<Environment, Invoke>> : Traceable<Environment> {};
} // namespace gc

template <typename Invoke, typename Signature> struct ClosureInvoker;

template <typename Invoke, typename R, bool Noexcept, typename... Args>
struct ClosureInvoker<Invoke, R (*)(Args...) noexcept(Noexcept)> {
    static R call(Args... args) noexcept(Noexcept) {
        Invoke invoke;
        return invoke(std::forward<Args>(args)...);
    }
};

template <typename Environment, typename Invoke>
[[nodiscard]] auto make_closure(Environment environment, Invoke invoke) {
    static_assert(std::is_empty_v<Invoke> || std::is_function_v<std::remove_pointer_t<Invoke>>,
                  "Closure invokers must not hide captures.");
    if constexpr (requires {
                      requires std::is_empty_v<Invoke>;
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
template <typename... Functions> struct RecursiveGroup {
    std::tuple<Functions...> functions;
    template <std::size_t Index, typename... Args>
    std::invoke_result_t<std::tuple_element_t<Index, std::tuple<Functions...>>&, RecursiveGroup&,
                         Args...>
    call(Args&&... args) {
        return std::get<Index>(functions)(*this, std::forward<Args>(args)...);
    }
};

template <typename... Functions> [[nodiscard]] auto make_recursive_group(Functions... functions) {
    return RecursiveGroup<Functions...>{std::tuple<Functions...>{std::move(functions)...}};
}

inline std::size_t next_callback_identity() { return realm_state.callback_identity++; }

/** A JavaScript function object: copies share identity and mutable captures. */
template <typename R, typename... Args> class Callback<R(Args...)> {
    struct Body {
        virtual ~Body() = default;
        virtual R call(Args... args) = 0;
        virtual bool present() const = 0;
    };
    template <typename F> struct Callable final : Body {
        explicit Callable(F body) : function(std::move(body)) {}
        F function;
        R call(Args... args) override {
            if constexpr (std::is_pointer_v<F>) {
                if (!function)
                    throw std::bad_function_call();
            }
            return function(std::forward<Args>(args)...);
        }
        bool present() const override {
            if constexpr (requires { function.operator bool(); })
                return function.operator bool();
            else if constexpr (std::is_pointer_v<F>)
                return function != nullptr;
            else
                return true;
        }
        /** Only a body that can own a traced edge describes one, so `make_gc_shared`
         * registers exactly those. */
        void gc_trace(const TraceVisitor& visitor) const
            requires gc_traceable<F>
        {
            visitor(function);
        }
    };

public:
    class Invocation {
    public:
        explicit Invocation(const Callback& callback)
            : body_(callback.body_), recursive_owner_(callback.recursive_owner_) {}
        R operator()(Args... args) const {
            if (!body_)
                throw std::bad_function_call();
            return body_->call(std::forward<Args>(args)...);
        }
        explicit operator bool() const { return body_ && body_->present(); }
        void gc_trace(const TraceVisitor& visitor) const {
            visitor(body_);
            visitor(recursive_owner_);
        }

    private:
        std::shared_ptr<Body> body_;
        std::shared_ptr<Callback> recursive_owner_;
    };

    Callback() = default;
    Callback(std::nullptr_t) noexcept {}
    template <typename F>
        requires(!std::is_same_v<std::remove_cvref_t<F>, Callback>)
    Callback(F&& body) : Callback(next_callback_identity(), std::forward<F>(body)) {}
    template <typename F>
    Callback(std::size_t identity, F&& body)
        : identity_(identity),
          body_(make_gc_shared<Callable<std::decay_t<F>>>(std::forward<F>(body))) {}

    R operator()(Args... args) const { return snapshot()(std::forward<Args>(args)...); }
    /** Retain once before argument evaluation, including recursive cells replaced by the call. */
    [[nodiscard]] Invocation snapshot() const { return Invocation(*this); }
    explicit operator bool() const { return body_ && body_->present(); }
    [[nodiscard]] std::size_t identity() const { return identity_; }
    void gc_trace(const TraceVisitor& visitor) const {
        visitor(body_);
        visitor(recursive_owner_);
    }
    // Erasing identity still shares mutable captures and retains any recursive
    // owner. Copying the pointed-to function would lose the aliasing owner.
    [[nodiscard]] std::function<R(Args...)> body() const {
        return *this ? std::function<R(Args...)>(*this) : std::function<R(Args...)>{};
    }
    [[nodiscard]] static Callback retain(std::shared_ptr<Callback> owner) {
        if (!owner)
            throw std::bad_function_call();
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

template <typename R, typename... Args>
[[nodiscard]] auto snapshot_callback(const Callback<R(Args...)>& callback) {
    return callback.snapshot();
}

/** Native stored functions already own their lexical receiver. A bound function
 * has fresh identity and retains the supplied thisArg as a JavaScript bound function does. */
template <typename R, typename... Args, typename Receiver>
[[nodiscard]] Callback<R(Args...)> bind_callback(Callback<R(Args...)> target, Receiver receiver) {
    return make_closure(std::tuple{std::move(target), std::move(receiver)},
                        [](auto& captures, Args... args) -> R {
                            return std::get<0>(captures)(std::forward<Args>(args)...);
                        });
}
template <typename R, typename... Args, typename Receiver>
[[nodiscard]] Callback<R(Args...)> bind_callback(std::function<R(Args...)> target,
                                                 Receiver receiver) {
    return bind_callback(Callback<R(Args...)>(std::move(target)), std::move(receiver));
}

template <typename Function> class NativeInvocation {
public:
    explicit NativeInvocation(Function function) : function_(function) {}
    template <typename... Args>
    std::invoke_result_t<Function, Args...> operator()(Args&&... args) const {
        if (!function_)
            throw std::bad_function_call();
        return function_(std::forward<Args>(args)...);
    }
    explicit operator bool() const { return function_ != nullptr; }

private:
    Function function_;
};

template <typename R, bool Noexcept, typename... Args>
[[nodiscard]] auto snapshot_callback(R (*function)(Args...) noexcept(Noexcept)) {
    return NativeInvocation<decltype(function)>{function};
}

template <typename Function>
    requires(std::is_empty_v<Function> &&
             requires(const Function& function) {
                 requires std::is_pointer_v<decltype(+function)>;
                 requires std::is_function_v<std::remove_pointer_t<decltype(+function)>>;
             })
[[nodiscard]] auto snapshot_callback(const Function& function) {
    return snapshot_callback(+function);
}

// A signature adapter keeps the function's identity and traced environment.
template <typename Target, typename Source, typename Invoke>
[[nodiscard]] Target adapt_callback(Source source, Invoke invoke) {
    if (!source)
        return {};
    const auto identity = source.identity();
    return Target{identity, make_closure(std::move(source), std::move(invoke))};
}

// A recursive body holds only a weak reference to its own storage. Every
// outward function value retains that storage, including a self reference
// passed to another callback, so the final outward release reclaims it.
template <typename R, typename... Args>
[[nodiscard]] Callback<R(Args...)> retain_callback(std::shared_ptr<Callback<R(Args...)>> owner) {
    return Callback<R(Args...)>::retain(std::move(owner));
}

} // namespace bbl::js

#pragma once

#include <cstddef>
#include <functional>
#include <limits>
#include <memory>
#include <type_traits>
#include <utility>

namespace bbl::js {

template <typename Sig>
class Callback;

// A plain std::function has no shared body field, so its outward value needs
// a small owning closure. Allocation of that closure is library-dependent.
template <typename R, typename... Args>
[[nodiscard]] std::function<R(Args...)> retain_callback(
    std::shared_ptr<std::function<R(Args...)>> owner) {
    if (!owner) throw std::bad_function_call();
    return [owner = std::move(owner)](Args... args) -> R {
        const auto retained = owner;
        return (*retained)(std::forward<Args>(args)...);
    };
}

inline std::size_t next_callback_identity() {
    static std::size_t next = std::numeric_limits<std::size_t>::max() / 2;
    return next++;
}

/** A JavaScript function object: copies share identity and mutable captures. */
template <typename R, typename... Args>
class Callback<R(Args...)> {
  public:
    Callback() = default;
    template <typename F>
        requires (!std::is_same_v<std::remove_cvref_t<F>, Callback>)
    Callback(F&& body)
        : Callback(next_callback_identity(), std::forward<F>(body)) {}
    template <typename F>
    Callback(std::size_t identity, F&& body)
        : identity_(identity),
          body_(std::make_shared<std::function<R(Args...)>>(
              std::forward<F>(body))) {}

    R operator()(Args... args) const {
        const auto retained = body_;
        if (!retained) throw std::bad_function_call();
        return (*retained)(std::forward<Args>(args)...);
    }
    explicit operator bool() const { return body_ && static_cast<bool>(*body_); }
    [[nodiscard]] std::size_t identity() const { return identity_; }
    // Erasing identity still shares mutable captures and retains any recursive
    // owner. Copying the pointed-to function would lose the aliasing owner.
    [[nodiscard]] std::function<R(Args...)> body() const {
        return *this ? retain_callback(body_) : std::function<R(Args...)>{};
    }
    [[nodiscard]] static Callback retain(std::shared_ptr<Callback> owner) {
        if (!owner) throw std::bad_function_call();
        Callback retained;
        retained.identity_ = owner->identity_;
        auto* body = owner->body_.get();
        // Reuse the owner's control block and existing function body. A
        // recursive invocation creates no new function or heap allocation.
        retained.body_ = {std::move(owner), body};
        return retained;
    }
    [[nodiscard]] friend bool operator==(const Callback& left, const Callback& right) {
        return left.identity_ == right.identity_;
    }

  private:
    std::size_t identity_ = 0;
    // A dispatch snapshot retains the closure without resetting its local state.
    std::shared_ptr<std::function<R(Args...)>> body_;
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

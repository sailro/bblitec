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
        return body()(std::forward<Args>(args)...);
    }
    explicit operator bool() const { return body_ && static_cast<bool>(*body_); }
    [[nodiscard]] std::size_t identity() const { return identity_; }
    [[nodiscard]] const std::function<R(Args...)>& body() const {
        static const std::function<R(Args...)> empty;
        return body_ ? *body_ : empty;
    }
    [[nodiscard]] friend bool operator==(const Callback& left, const Callback& right) {
        return left.identity_ == right.identity_;
    }

  private:
    std::size_t identity_ = 0;
    // A dispatch snapshot retains the closure without resetting its local state.
    std::shared_ptr<std::function<R(Args...)>> body_;
};

} // namespace bbl::js

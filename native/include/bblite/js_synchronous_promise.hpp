#pragma once

// A constructed promise in a program without an application realm. Its
// executor runs synchronously and its resolving functions may escape into
// callbacks; the activation that awaits it reads the settlement at the await.
// A promise still pending there suspends that activation for good in
// JavaScript unless something settles it later, so the await unwinds the
// activation to the statement that discarded its promise, skipping its catch
// and finally blocks, and a later settlement refuses at run time.

#include <bblite/js_gc.hpp>
#include <bblite/js_promise.hpp>

#include <exception>
#include <memory>
#include <stdexcept>
#include <utility>
#include <variant>

namespace bbl::js {

/**
 * Unwinds an activation that awaits a pending constructed promise. Not a
 * `std::exception`, so a caught Error never sees it; generated `catch (...)`
 * clauses pass it on and generated finally blocks skip while it unwinds.
 */
struct PendingActivation {};

namespace detail {
inline bool& activation_abandoned_flag() noexcept {
    static bool abandoned = false;
    return abandoned;
}
} // namespace detail

/** Whether a pending await is unwinding its activation. */
[[nodiscard]] inline bool activation_abandoned() noexcept {
    return detail::activation_abandoned_flag();
}

/** The statement that discarded the abandoned activation's promise: unwinding ends here. */
inline void end_abandoned_activation() noexcept { detail::activation_abandoned_flag() = false; }

template <typename T> class SynchronousPromise {
    struct State {
        std::variant<std::monostate, T, std::exception_ptr> outcome;
        bool abandoned = false;
        void gc_trace(const TraceVisitor& visitor) const {
            if (const auto* value = std::get_if<T>(&outcome))
                visitor(*value);
        }
    };

public:
    /** The first settlement wins, as it does for JavaScript's resolving functions. */
    void resolve(T value) const {
        if (settleable())
            state_->outcome.template emplace<1>(std::move(value));
    }
    void reject(std::exception_ptr error) const {
        if (settleable())
            state_->outcome.template emplace<2>(std::move(error));
    }

    /** The awaited result: the value, the rejection rethrown, or the activation abandoned. */
    [[nodiscard]] T await_result() const {
        if (const auto* value = std::get_if<T>(&state_->outcome))
            return *value;
        if (const auto* error = std::get_if<std::exception_ptr>(&state_->outcome))
            std::rethrow_exception(*error);
        state_->abandoned = true;
        detail::activation_abandoned_flag() = true;
        throw PendingActivation{};
    }

    void gc_trace(const TraceVisitor& visitor) const { visitor(state_); }

private:
    [[nodiscard]] bool settleable() const {
        if (state_->abandoned) {
            throw std::logic_error(
                "A constructed promise settled after the activation awaiting it had ended; "
                "the synchronous lowering cannot resume it.");
        }
        return std::holds_alternative<std::monostate>(state_->outcome);
    }

    std::shared_ptr<State> state_ = make_gc_shared<State>();
};

} // namespace bbl::js

#pragma once

#include <coroutine>
#include <exception>
#include <stdexcept>
#include <utility>

namespace bbl::pal {

/** Suspended native frame state, owned until the application loop releases it. */
template <typename Result> class Iteration {
public:
    struct promise_type {
        Result result{};
        std::exception_ptr error;
        Iteration get_return_object() {
            return Iteration(std::coroutine_handle<promise_type>::from_promise(*this));
        }
        std::suspend_always initial_suspend() const noexcept { return {}; }
        std::suspend_always final_suspend() const noexcept { return {}; }
        std::suspend_always yield_value(bool) const noexcept { return {}; }
        void return_value(Result value) { result = std::move(value); }
        void unhandled_exception() noexcept { error = std::current_exception(); }
    };

    Iteration() = default;
    Iteration(const Iteration&) = delete;
    Iteration& operator=(const Iteration&) = delete;
    Iteration(Iteration&& other) noexcept : handle_(std::exchange(other.handle_, {})) {}
    Iteration& operator=(Iteration&& other) noexcept {
        if (this != &other) {
            reset();
            handle_ = std::exchange(other.handle_, {});
        }
        return *this;
    }
    ~Iteration() { reset(); }
    void reset() noexcept {
        if (handle_)
            std::exchange(handle_, {}).destroy();
    }
    /** Resume exactly one iteration; exceptions return to the C++ caller. */
    bool advance() {
        if (!handle_)
            throw std::logic_error("No application iteration.");
        if (!handle_.done())
            handle_.resume();
        if (handle_.promise().error)
            std::rethrow_exception(handle_.promise().error);
        return !handle_.done();
    }
    Result result() const {
        if (!handle_ || !handle_.done())
            throw std::logic_error("Application iteration is pending.");
        if (handle_.promise().error)
            std::rethrow_exception(handle_.promise().error);
        return handle_.promise().result;
    }

private:
    explicit Iteration(std::coroutine_handle<promise_type> handle) : handle_(handle) {}
    std::coroutine_handle<promise_type> handle_;
};

} // namespace bbl::pal

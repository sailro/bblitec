#pragma once

#include <bblite/js_data.hpp>
#include <bblite/js_promise.hpp>

namespace bbl::js {

template <typename T> Promise<T> generator_yield_value(T value) {
    return Promise<T>::resolved(std::move(value));
}
template <typename T> Promise<T> generator_yield_value(Promise<T> value) { return value; }
template <typename T, typename U, typename Convert>
Promise<T> generator_yield_value(PromiseAdoption<U, Convert> value) {
    Promise<T> result;
    result.adopt(value.source, std::move(value.convert));
    return result;
}

template <typename T> struct AsyncGeneratorPromise;
template <typename T> struct AsyncGeneratorFrame;

/** One asynchronous iterator identity, with ordered next/return requests. */
template <typename T> class AsyncIterator {
public:
    using promise_type = AsyncGeneratorPromise<T>;
    using Result = typename Iterator<T>::Result;
    AsyncIterator() = default;
    explicit AsyncIterator(std::shared_ptr<AsyncGeneratorFrame<T>> state)
        : state_(std::move(state)) {}
    Promise<Result> next() const { return state_->request(false); }
    Promise<Result> return_() const { return state_->request(true); }
    friend bool operator==(const AsyncIterator&, const AsyncIterator&) = default;
    const void* get() const noexcept { return state_.get(); }
    void gc_trace(const TraceVisitor& visitor) const { visitor(state_); }

private:
    std::shared_ptr<AsyncGeneratorFrame<T>> state_;
};

template <typename T> struct AsyncGeneratorPromise {
    std::weak_ptr<AsyncGeneratorFrame<T>> frame;
    pal::EventLoop* loop = &pal::EventLoop::current();
    pal::EventLoop::ContinuationId continuation = 0;
    std::exception_ptr error;
    bool closing = false;
    AsyncIterator<T> get_return_object();
    std::suspend_always initial_suspend() const noexcept { return {}; }
    std::suspend_always final_suspend() noexcept {
        if (auto owner = frame.lock())
            owner->finish(error);
        return {};
    }
    struct Yield {
        AsyncGeneratorPromise* promise;
        bool await_ready() const noexcept { return false; }
        void await_suspend(std::coroutine_handle<>) const noexcept {}
        void await_resume() const {
            if (promise->closing)
                throw GeneratorClose{};
        }
    };
    Yield yield_value(T value) {
        frame.lock()->yield(std::move(value));
        return {this};
    }
    void return_void() const noexcept {}
    void unhandled_exception() noexcept {
        try {
            throw;
        } catch (const GeneratorClose&) {
        } catch (...) {
            error = std::current_exception();
        }
    }
    ~AsyncGeneratorPromise() {
        if (auto owner = frame.lock()) {
            owner->handle = {};
            owner->keepAlive.reset();
        }
        if (continuation)
            loop->release_continuation(continuation);
    }
};

template <typename T>
struct AsyncGeneratorFrame : std::enable_shared_from_this<AsyncGeneratorFrame<T>> {
    using Result = typename AsyncIterator<T>::Result;
    struct Request {
        Promise<Result> result;
        bool close;
    };
    std::coroutine_handle<AsyncGeneratorPromise<T>> handle;
    std::shared_ptr<AsyncGeneratorFrame> keepAlive;
    std::deque<Request> requests;
    pal::EventLoop* loop = &pal::EventLoop::current();
    bool started = false;
    bool running = false;
    bool complete = false;
    explicit AsyncGeneratorFrame(std::coroutine_handle<AsyncGeneratorPromise<T>> frame)
        : handle(frame) {}
    ~AsyncGeneratorFrame() {
        if (handle) {
            const GeneratorDisposal disposing;
            handle.destroy();
        }
    }
    Promise<Result> request(bool close) {
        loop->checkpoint();
        Promise<Result> result;
        if (complete) {
            result.resolve(Result{true, {}});
            return result;
        }
        requests.push_back({result, close});
        if (requests.size() == 1 && !running)
            pump();
        return result;
    }
    void pump() {
        if (running || requests.empty() || complete)
            return;
        keepAlive = this->shared_from_this();
        if (!started && requests.front().close) {
            complete = true;
            std::exchange(handle, {}).destroy();
            finish({});
            return;
        }
        started = true;
        running = true;
        handle.promise().closing = requests.front().close;
        loop->resume_continuation(handle.promise().continuation);
    }
    void settled() {
        // Release the activation only after co_yield/final_suspend has returned.
        loop->queue_microtask([owner = this->shared_from_this()] {
            if (owner->complete && owner->handle)
                std::exchange(owner->handle, {}).destroy();
            if (owner->requests.empty())
                owner->keepAlive.reset();
            else
                owner->pump();
        });
    }
    void yield(T value) {
        running = false;
        const auto result = requests.front().result;
        requests.pop_front();
        result.resolve(Result{false, Nullable<T>(std::move(value))});
        settled();
    }
    void finish(std::exception_ptr error) {
        complete = true;
        running = false;
        if (error && !requests.empty()) {
            requests.front().result.reject(error);
            requests.pop_front();
        }
        while (!requests.empty()) {
            requests.front().result.resolve(Result{true, {}});
            requests.pop_front();
        }
        settled();
    }
};

template <typename T> AsyncIterator<T> AsyncGeneratorPromise<T>::get_return_object() {
    auto handle = std::coroutine_handle<AsyncGeneratorPromise>::from_promise(*this);
    auto owner = std::make_shared<AsyncGeneratorFrame<T>>(handle);
    frame = owner;
    continuation = loop->own_continuation(handle);
    return AsyncIterator<T>(std::move(owner));
}

} // namespace bbl::js

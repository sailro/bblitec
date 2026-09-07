#pragma once

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cmath>
#include <coroutine>
#include <cstdint>
#include <deque>
#include <exception>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <queue>
#include <stdexcept>
#include <thread>
#include <utility>
#include <variant>
#include <vector>

namespace bbl::pal {

/** Native transport data only. Implementations must not retain JS objects. */
struct ExternalEvent {
    virtual ~ExternalEvent() = default;
};

/** A control-flow abort, distinct from a source-language exception. */
struct WorkerTerminated {};

/** An optional native binding restored around a suspended platform operation. */
struct ContinuationContext {
    virtual ~ContinuationContext() = default;
    virtual void enter() = 0;
    virtual void leave() noexcept = 0;
};

/** One realm's scheduler. It has no dependency on Engine, SDL or a GPU. */
class EventLoop {
  public:
    using Clock = std::chrono::steady_clock;
    using Task = std::function<void()>;
    using TimerId = std::uint64_t;
    using AnimationFrameId = std::uint64_t;
    using AnimationCallback = std::function<void(double)>;
    using EventHandler = std::function<void(std::unique_ptr<ExternalEvent>)>;
    using ErrorHandler = std::function<void(std::exception_ptr)>;

    /** The only scheduler state shared with other threads. */
    class Inbox {
      public:
        /** Coalesce display ticks while this realm is busy. Only the owner
         * stores/invokes animation callbacks; the host supplies native time. */
        void animation_frame(Clock::time_point timestamp) {
            {
                std::lock_guard lock(mutex_);
                if (closed_ || terminated() || !animation_requested_) return;
                if (!animation_timestamp_) tasks_.emplace_back(AnimationTick{});
                animation_timestamp_ = timestamp;
            }
            wake_.notify_one();
        }

        bool post(std::unique_ptr<ExternalEvent> event) {
            if (!event) throw std::invalid_argument("Cannot post an empty event.");
            {
                std::lock_guard lock(mutex_);
                if (closed_ || terminated_.load(std::memory_order_relaxed)) return false;
                tasks_.emplace_back(std::move(event));
            }
            wake_.notify_one();
            return true;
        }

        void terminate() noexcept {
            // The owner clears callback storage. Destroying it here could
            // release non-atomic JS identities on the requesting thread.
            {
                std::lock_guard lock(mutex_);
                terminated_.store(true, std::memory_order_relaxed);
            }
            wake_.notify_one();
        }

        bool terminated() const noexcept {
            return terminated_.load(std::memory_order_relaxed);
        }

      private:
        friend class EventLoop;
        struct AnimationTick {};
        using QueuedTask = std::variant<Task, std::unique_ptr<ExternalEvent>, AnimationTick>;
        std::mutex mutex_;
        std::condition_variable wake_;
        std::deque<QueuedTask> tasks_;
        std::atomic<bool> terminated_{false};
        bool closed_ = false;
        bool attached_ = false;
        bool animation_requested_ = false;
        std::optional<Clock::time_point> animation_timestamp_;
    };

    explicit EventLoop(std::shared_ptr<Inbox> inbox = std::make_shared<Inbox>(),
                       Clock::time_point origin = Clock::now())
        : inbox_(std::move(inbox)), owner_(std::this_thread::get_id()), origin_(origin) {
        if (!inbox_) throw std::invalid_argument("An event loop requires an inbox.");
        std::lock_guard lock(inbox_->mutex_);
        if (inbox_->attached_ || inbox_->closed_) throw std::logic_error("Inbox already has a realm owner.");
        inbox_->attached_ = true;
    }
    EventLoop(const EventLoop&) = delete;
    EventLoop& operator=(const EventLoop&) = delete;
    ~EventLoop() { discard(); }

    std::shared_ptr<Inbox> inbox() const { return inbox_; }
    double now() const {
        return std::chrono::duration<double, std::milli>(Clock::now() - origin_).count();
    }

    static EventLoop& current() {
        if (!current_) throw std::logic_error("No active realm event loop.");
        return *current_;
    }

    void checkpoint() const {
        if (inbox_->terminated()) throw WorkerTerminated{};
    }
    bool aborting() const { return discarding_ || inbox_->terminated(); }

    using ContinuationId = std::uint64_t;
    ContinuationId own_continuation(std::coroutine_handle<> continuation, std::shared_ptr<ContinuationContext> context = {}) {
        require_owner();
        const auto id = next_continuation_++;
        continuations_.emplace(id, Continuation{continuation, std::move(context)});
        return id;
    }
    void release_continuation(ContinuationId id) { require_owner(); continuations_.erase(id); }
    void resume_continuation(ContinuationId id) {
        require_owner();
        checkpoint();
        const auto found = continuations_.find(id);
        if (found != continuations_.end()) {
            const auto continuation = found->second;
            ContinuationScope scope(continuation.context);
            continuation.handle.resume();
        }
    }

    void on_event(EventHandler handler) { require_owner(); event_handler_ = std::move(handler); }
    void on_error(ErrorHandler handler) { require_owner(); error_handler_ = std::move(handler); }
    void defer_cleanup(Task cleanup) { require_owner(); cleanups_.push_back(std::move(cleanup)); }

    /** A native event invokes each source listener with its own cleanup checkpoint. */
    void dispatch_callback(Task callback) {
        require_owner();
        turn(std::move(callback));
    }

    void post(Task task) {
        require_owner();
        if (!task) throw std::invalid_argument("Cannot queue an empty task.");
        std::lock_guard lock(inbox_->mutex_);
        if (!inbox_->closed_ && !inbox_->terminated()) inbox_->tasks_.emplace_back(std::move(task));
    }

    void queue_microtask(Task task) {
        require_owner();
        if (!task) throw std::invalid_argument("Cannot queue an empty microtask.");
        checkpoint();
        microtasks_.push_back(std::move(task));
    }

    TimerId set_timer(Task task, Clock::duration delay, bool repeat = false) {
        require_owner();
        if (!task) throw std::invalid_argument("Cannot schedule an empty timer.");
        if (closed()) return 0;
        delay = std::max(delay, Clock::duration::zero());
        const auto nesting = timer_nesting_ + 1;
        if (timer_nesting_ > 5) delay = std::max(delay, Clock::duration(std::chrono::milliseconds(4)));
        const TimerId id = next_timer_++;
        if (id == 0) throw std::overflow_error("Timer identifiers exhausted.");
        const auto due = Clock::now() + delay;
        timers_.emplace(id, Timer{std::move(task), delay, repeat, nesting});
        deadlines_.push(Deadline{due, id});
        return id;
    }

    TimerId set_timeout(Task task, double milliseconds, bool repeat = false) {
        // Web IDL long conversion, followed by the HTML timer's zero clamp.
        double converted = std::isfinite(milliseconds) ? std::fmod(std::trunc(milliseconds), 4294967296.0) : 0.0;
        if (converted < 0.0) converted += 4294967296.0;
        if (converted >= 2147483648.0) converted -= 4294967296.0;
        return set_timer(std::move(task), std::chrono::milliseconds(static_cast<std::int64_t>(std::max(0.0, converted))), repeat);
    }

    void clear_timer(TimerId id) {
        require_owner();
        if (!timers_.erase(id)) return;
        // Canceled far-future entries must not accumulate behind an earlier
        // live deadline. Amortized compaction keeps the heap bounded without
        // adding an indexed queue to the ordinary timer dispatch path.
        if (deadlines_.size() > timers_.size() * 2 + 64) {
            decltype(deadlines_) retained;
            while (!deadlines_.empty()) {
                const auto next = deadlines_.top();
                deadlines_.pop();
                if (timers_.contains(next.id)) retained.push(next);
            }
            deadlines_.swap(retained);
        }
    }

    AnimationFrameId request_animation_frame(AnimationCallback callback) {
        require_owner();
        if (!callback) throw std::invalid_argument("Cannot request an empty animation callback.");
        if (closed()) return 0;
        const auto id = next_animation_frame_++;
        if (!id) throw std::overflow_error("Animation frame identifiers exhausted.");
        animation_callbacks_.emplace(id, std::move(callback));
        std::lock_guard lock(inbox_->mutex_);
        inbox_->animation_requested_ = true;
        return id;
    }
    void cancel_animation_frame(AnimationFrameId id) { require_owner(); animation_callbacks_.erase(id); }

    /** close() finishes the current task and its microtasks, discarding later tasks. */
    void close() {
        require_owner();
        std::deque<Inbox::QueuedTask> discarded;
        {
            std::lock_guard lock(inbox_->mutex_);
            inbox_->closed_ = true;
            inbox_->animation_requested_ = false;
            inbox_->animation_timestamp_.reset();
            discarded.swap(inbox_->tasks_);
        }
        timers_.clear();
        animation_callbacks_.clear();
        deadlines_ = {};
    }

    /** Run module initialization, then service tasks until close or termination. */
    void run(Task initialize = {}) {
        require_owner();
        Activation active(*this);
        try {
            if (initialize) turn(std::move(initialize));
            while (dispatch_one(true)) {}
        } catch (const WorkerTerminated&) {
            // Termination is not reported as an application error.
        } catch (...) {
            discard();
            throw;
        }
        discard();
    }

    /** Embedding hosts can service this realm without blocking their own loop. */
    bool poll() {
        require_owner();
        Activation active(*this);
        return dispatch_one(false);
    }

  private:
    struct Continuation {
        std::coroutine_handle<> handle;
        std::shared_ptr<ContinuationContext> context;
    };
    struct ContinuationScope {
        std::shared_ptr<ContinuationContext> context;
        explicit ContinuationScope(std::shared_ptr<ContinuationContext> value) : context(std::move(value)) {
            if (context) context->enter();
        }
        ~ContinuationScope() { if (context) context->leave(); }
    };
    struct Activation {
        explicit Activation(EventLoop& loop) {
            if (current_) throw std::logic_error("Reentrant realm dispatch is unsupported.");
            current_ = &loop;
        }
        ~Activation() { current_ = nullptr; }
    };
    struct Timer {
        Task callback;
        Clock::duration delay;
        bool repeat;
        unsigned nesting;
    };
    struct Deadline {
        Clock::time_point due;
        TimerId id;
        bool operator>(const Deadline& other) const {
            return due > other.due || (due == other.due && id > other.id);
        }
    };

    void require_owner() const {
        if (owner_ != std::this_thread::get_id()) throw std::logic_error("Realm accessed from another thread.");
    }
    bool closed() const {
        std::lock_guard lock(inbox_->mutex_);
        return inbox_->closed_ || inbox_->terminated();
    }
    void discard() {
        discarding_ = true;
        close();
        microtasks_.clear();
        // A promise's frame unregisters itself in its destructor. Every
        // suspended activation is released by this realm's owning thread.
        while (!continuations_.empty()) {
            const auto continuation = continuations_.begin()->second;
            ContinuationScope scope(continuation.context);
            continuation.handle.destroy();
        }
        auto cleanups = std::move(cleanups_);
        for (auto& cleanup : cleanups) cleanup();
        event_handler_ = {};
        error_handler_ = {};
    }
    void invoke(Task task) {
        checkpoint();
        try {
            task();
        } catch (const WorkerTerminated&) {
            throw;
        } catch (...) {
            checkpoint();
            if (!error_handler_) throw;
            const auto handler = error_handler_;
            handler(std::current_exception());
        }
        checkpoint();
    }
    void turn(Task task) {
        invoke(std::move(task));
        // A microtask can dispatch an event synchronously. Its callback cleanup
        // must not recursively drain the queue already being processed.
        if (draining_microtasks_) return;
        draining_microtasks_ = true;
        struct Reset { bool& value; ~Reset() { value = false; } } reset{draining_microtasks_};
        while (!microtasks_.empty()) {
            auto microtask = std::move(microtasks_.front());
            microtasks_.pop_front();
            invoke(std::move(microtask));
        }
    }
    void fire_timer(TimerId id) {
        const auto found = timers_.find(id);
        if (found == timers_.end()) return;
        const Timer timer = found->second;
        if (!timer.repeat) timers_.erase(found);
        const unsigned previous_nesting = std::exchange(timer_nesting_, timer.nesting);
        struct Reset { unsigned& target; unsigned value; ~Reset() { target = value; } } reset{timer_nesting_, previous_nesting};
        invoke(timer.callback);
        if (timer.repeat && timers_.contains(id)) {
            auto& next = timers_.at(id);
            if (next.nesting > 5) next.delay = std::max(next.delay, Clock::duration(std::chrono::milliseconds(4)));
            ++next.nesting;
            deadlines_.push(Deadline{Clock::now() + next.delay, id});
        }
    }
    void queue_due_timers() {
        const auto now = Clock::now();
        while (!deadlines_.empty()) {
            const auto next = deadlines_.top();
            if (!timers_.contains(next.id)) { deadlines_.pop(); continue; }
            if (next.due > now) break;
            deadlines_.pop();
            post([this, id = next.id] { fire_timer(id); });
        }
    }
    void fire_animation_frame() {
        Clock::time_point timestamp;
        {
            std::lock_guard lock(inbox_->mutex_);
            timestamp = *inbox_->animation_timestamp_;
            inbox_->animation_timestamp_.reset();
            inbox_->animation_requested_ = false;
        }
        // A callback requested during this batch belongs to the next repaint.
        std::vector<AnimationFrameId> batch;
        batch.reserve(animation_callbacks_.size());
        for (const auto& [id, callback] : animation_callbacks_) {
            static_cast<void>(callback);
            batch.push_back(id);
        }
        const auto milliseconds = std::chrono::duration<double, std::milli>(timestamp - origin_).count();
        for (const auto id : batch) {
            const auto found = animation_callbacks_.find(id);
            if (found == animation_callbacks_.end()) continue;
            auto callback = std::move(found->second);
            animation_callbacks_.erase(found);
            turn([&] { callback(milliseconds); });
        }
    }
    bool dispatch_one(bool wait) {
        checkpoint();
        queue_due_timers();
        Inbox::QueuedTask task;
        {
            std::unique_lock lock(inbox_->mutex_);
            if (inbox_->closed_) return false;
            while (inbox_->tasks_.empty() && !inbox_->closed_ && !inbox_->terminated()) {
                if (!wait) return false;
                const auto ready = [&] { return !inbox_->tasks_.empty() || inbox_->closed_ || inbox_->terminated(); };
                if (deadlines_.empty()) inbox_->wake_.wait(lock, ready);
                else inbox_->wake_.wait_until(lock, deadlines_.top().due, ready);
                lock.unlock();
                queue_due_timers();
                lock.lock();
            }
            checkpoint();
            if (inbox_->closed_) return false;
            task = std::move(inbox_->tasks_.front());
            inbox_->tasks_.pop_front();
        }
        if (auto* callback = std::get_if<Task>(&task)) {
            turn(std::move(*callback));
        } else if (std::holds_alternative<Inbox::AnimationTick>(task)) {
            fire_animation_frame();
        } else {
            // Keep the move-only packet on this stack; callbacks are invoked
            // synchronously by turn and cannot retain this native reference.
            turn([&] {
                if (!event_handler_) throw std::logic_error("No receiver for external event.");
                const auto handler = event_handler_;
                handler(std::move(std::get<std::unique_ptr<ExternalEvent>>(task)));
            });
        }
        return true;
    }

    inline static thread_local EventLoop* current_ = nullptr;
    std::shared_ptr<Inbox> inbox_;
    std::thread::id owner_;
    Clock::time_point origin_;
    std::deque<Task> microtasks_;
    std::map<TimerId, Timer> timers_;
    std::priority_queue<Deadline, std::vector<Deadline>, std::greater<Deadline>> deadlines_;
    TimerId next_timer_ = 1;
    AnimationFrameId next_animation_frame_ = 1;
    std::map<AnimationFrameId, AnimationCallback> animation_callbacks_;
    unsigned timer_nesting_ = 0;
    bool draining_microtasks_ = false;
    bool discarding_ = false;
    ContinuationId next_continuation_ = 1;
    std::map<ContinuationId, Continuation> continuations_;
    std::vector<Task> cleanups_;
    EventHandler event_handler_;
    ErrorHandler error_handler_;
};

} // namespace bbl::pal

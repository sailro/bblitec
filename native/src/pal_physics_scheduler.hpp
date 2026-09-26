#pragma once

#include <LinearMath/btThreads.h>
#include <algorithm>
#include <atomic>
#include <charconv>
#include <condition_variable>
#include <cstdlib>
#include <deque>
#include <future>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string_view>
#include <thread>
#include <type_traits>
#include <utility>
#include <vector>
#if defined(_M_X64) || defined(_M_IX86) || defined(__x86_64__) || defined(__i386__)
#include <immintrin.h>
#endif

namespace bbl::pal {

/** Stable workers and ordered sums for Bullet's parallel-loop interface. */
class PhysicsWorkerPool final : public btITaskScheduler {
    static constexpr unsigned spin_iterations = 4096;
    struct Work {
        int begin, end, grain;
        Work(int first, int last, int width) : begin(first), end(last), grain(width) {}
        virtual ~Work() = default;
        virtual void invoke(int first, int last) const = 0;
    };
    std::mutex error_mutex_;
    const Work* work_ = nullptr;
    std::exception_ptr error_;
    alignas(64) std::atomic<int> next_ = 0;
    alignas(64) std::atomic<std::uint64_t> generation_ = 0;
    alignas(64) std::atomic<std::size_t> finished_ = 0;
    bool initialized_ = false;
    const std::thread::id owner_ = std::this_thread::get_id();
    std::vector<btScalar> sums_;
    std::vector<std::jthread> workers_;

    static void spin_pause() {
#if defined(_M_X64) || defined(_M_IX86) || defined(__x86_64__) || defined(__i386__)
        _mm_pause();
#else
        std::atomic_signal_fence(std::memory_order_seq_cst);
#endif
    }

    void consume(const Work& work) {
        for (;;) {
            const int first =
                work.begin + next_.fetch_add(1, std::memory_order_relaxed) * work.grain;
            if (first >= work.end)
                return;
            try {
                work.invoke(first, std::min(first + work.grain, work.end));
            } catch (...) {
                std::lock_guard lock(error_mutex_);
                if (!error_)
                    error_ = std::current_exception();
            }
        }
    }

    bool can_parallelize(int count, int grain) const {
        return !workers_.empty() && count / grain >= getNumThreads() &&
               std::this_thread::get_id() == owner_ && work_ == nullptr;
    }

    void dispatch(const Work& work) {
        work_ = &work;
        error_ = {};
        finished_ = 0;
        next_ = 0;
        generation_.fetch_add(1, std::memory_order_release);
        generation_.notify_all();
        consume(work);
        for (unsigned spin = 0;
             spin < spin_iterations && finished_.load(std::memory_order_acquire) != workers_.size();
             ++spin)
            spin_pause();
        for (auto count = finished_.load(std::memory_order_acquire); count != workers_.size();
             count = finished_.load(std::memory_order_acquire))
            finished_.wait(count, std::memory_order_acquire);
        work_ = nullptr;
        if (error_)
            std::rethrow_exception(error_);
    }

public:
    PhysicsWorkerPool() : btITaskScheduler("bblite native workers") {}
    ~PhysicsWorkerPool() override {
        for (auto& worker : workers_)
            worker.request_stop();
        generation_.fetch_add(1, std::memory_order_release);
        generation_.notify_all();
    }
    int getMaxNumThreads() const override {
        return static_cast<int>(
            std::clamp(std::thread::hardware_concurrency(), 1u, BT_MAX_THREAD_COUNT));
    }
    int getNumThreads() const override { return static_cast<int>(workers_.size()) + 1; }
    void setNumThreads(int count) override {
        if (initialized_ || count < 1 || count > getMaxNumThreads())
            throw std::logic_error("Physics workers require one valid initialization.");
        initialized_ = true;
        for (int index = 1; index < count; ++index)
            workers_.emplace_back([this](std::stop_token stop) {
                std::uint64_t observed = 0;
                for (;;) {
                    // Keep short solver phases off the OS parking path, then sleep.
                    for (unsigned spin = 0; spin < spin_iterations &&
                                            generation_.load(std::memory_order_acquire) == observed;
                         ++spin)
                        spin_pause();
                    generation_.wait(observed, std::memory_order_acquire);
                    if (stop.stop_requested())
                        return;
                    observed = generation_.load(std::memory_order_acquire);
                    consume(*work_);
                    if (finished_.fetch_add(1, std::memory_order_acq_rel) + 1 == workers_.size())
                        finished_.notify_one();
                }
            });
    }
    void parallelFor(int begin, int end, int grain, const btIParallelForBody& body) override {
        if (begin > end || grain <= 0)
            throw std::invalid_argument("Invalid parallel physics range.");
        if (!can_parallelize(end - begin, grain)) {
            body.forLoop(begin, end);
            return;
        }
        struct ForWork final : Work {
            const btIParallelForBody& body;
            ForWork(int first, int last, int width, const btIParallelForBody& operation)
                : Work(first, last, width), body(operation) {}
            void invoke(int first, int last) const override { body.forLoop(first, last); }
        } work(begin, end, grain, body);
        dispatch(work);
    }
    btScalar parallelSum(int begin, int end, int grain, const btIParallelSumBody& body) override {
        if (begin > end || grain <= 0)
            throw std::invalid_argument("Invalid parallel physics range.");
        if (!can_parallelize(end - begin, grain))
            return body.sumLoop(begin, end);
        sums_.resize(static_cast<std::size_t>((end - begin + grain - 1) / grain));
        struct SumWork final : Work {
            const btIParallelSumBody& body;
            std::vector<btScalar>& sums;
            SumWork(int first, int last, int width, const btIParallelSumBody& operation,
                    std::vector<btScalar>& results)
                : Work(first, last, width), body(operation), sums(results) {}
            void invoke(int first, int last) const override {
                sums[static_cast<std::size_t>((first - begin) / grain)] = body.sumLoop(first, last);
            }
        } work(begin, end, grain, body, sums_);
        dispatch(work);
        btScalar total = 0;
        for (const auto value : sums_)
            total += value;
        return total;
    }
};

/** Bullet has one process-wide scheduler and a stable main-thread index. */
class PhysicsScheduler {
    std::mutex mutex_;
    std::condition_variable changed_;
    std::deque<std::packaged_task<void()>> jobs_;
    int thread_count_ = 1;
    std::exception_ptr initialization_error_;
    std::jthread owner_;

public:
    PhysicsScheduler() {
        std::promise<void> initialized;
        auto ready = initialized.get_future();
        owner_ = std::jthread([this,
                               initialized = std::move(initialized)](std::stop_token stop) mutable {
            std::unique_ptr<PhysicsWorkerPool> scheduler;
            try {
                scheduler = std::make_unique<PhysicsWorkerPool>();
                thread_count_ = std::min(8, scheduler->getMaxNumThreads());
                if (const char* setting = std::getenv("BBLITE_PHYSICS_THREADS")) {
                    const std::string_view value(setting);
                    const auto parsed =
                        std::from_chars(value.data(), value.data() + value.size(), thread_count_);
                    if (parsed.ec != std::errc{} || parsed.ptr != value.data() + value.size() ||
                        thread_count_ < 1 || thread_count_ > scheduler->getMaxNumThreads())
                        throw std::invalid_argument(
                            "BBLITE_PHYSICS_THREADS must be an integer within Bullet's available thread count.");
                }
                btSetTaskScheduler(scheduler.get());
                scheduler->setNumThreads(thread_count_);
                initialized.set_value();
            } catch (...) {
                initialization_error_ = std::current_exception();
                if (btGetTaskScheduler() == scheduler.get())
                    btSetTaskScheduler(nullptr);
                initialized.set_value();
                return;
            }
            for (;;) {
                std::packaged_task<void()> job;
                {
                    std::unique_lock lock(mutex_);
                    changed_.wait(lock, [&] { return stop.stop_requested() || !jobs_.empty(); });
                    if (jobs_.empty())
                        break;
                    job = std::move(jobs_.front());
                    jobs_.pop_front();
                }
                job();
            }
            btSetTaskScheduler(nullptr);
        });
        ready.get();
    }

    ~PhysicsScheduler() {
        owner_.request_stop();
        changed_.notify_one();
    }

    int thread_count() const { return thread_count_; }

    template <typename Action> auto run(Action&& action) -> std::invoke_result_t<Action> {
        if (initialization_error_)
            std::rethrow_exception(initialization_error_);
        if (std::this_thread::get_id() == owner_.get_id())
            return std::forward<Action>(action)();
        std::packaged_task<std::invoke_result_t<Action>()> task(std::forward<Action>(action));
        auto result = task.get_future();
        {
            std::lock_guard lock(mutex_);
            if (owner_.get_stop_token().stop_requested())
                throw std::runtime_error("The physics scheduler is shutting down.");
            jobs_.emplace_back([task = std::move(task)]() mutable { task(); });
        }
        changed_.notify_one();
        return result.get();
    }
};

inline PhysicsScheduler& physics_scheduler() {
    static PhysicsScheduler scheduler;
    return scheduler;
}

} // namespace bbl::pal

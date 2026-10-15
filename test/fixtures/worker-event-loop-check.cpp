#include <bblite/pal_event_loop.hpp>
#include <bblite/pal_animation_frame.hpp>
#include <bblite/pal_native_job.hpp>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <future>
#include <iostream>
#include <mutex>
#include <optional>
#include <semaphore>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>

namespace {
using bbl::pal::EventLoop;
using bbl::pal::ExternalEvent;
using namespace std::chrono_literals;

void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}

struct NumberEvent final : ExternalEvent {
    explicit NumberEvent(int n) : value(n) {}
    int value;
};

void ordering_and_cancellation() {
    EventLoop loop;
    std::vector<std::string> order;
    loop.run([&] {
        require(&EventLoop::current() == &loop, "Wrong active realm");
        loop.on_event([&](std::unique_ptr<ExternalEvent> event) {
            const auto* number = dynamic_cast<NumberEvent*>(event.get());
            require(number != nullptr, "Wrong message type");
            order.push_back("message" + std::to_string(number->value));
            loop.queue_microtask([&] { order.push_back("message microtask"); });
        });
        loop.inbox()->post(std::make_unique<NumberEvent>(1));
        loop.inbox()->post(std::make_unique<NumberEvent>(2));
        loop.queue_microtask([&] {
            order.push_back("microtask");
            loop.queue_microtask([&] { order.push_back("nested microtask"); });
        });
        auto cancelled = loop.set_timer([&] { order.push_back("cancelled timer"); }, 0ms);
        loop.post([&loop, cancelled] { loop.clear_timer(cancelled); });
        loop.set_timer(
            [&] {
                order.push_back("timer");
                loop.post([&] { order.push_back("discarded task"); });
                loop.queue_microtask([&] { order.push_back("closing microtask"); });
                loop.close();
                order.push_back("close returned");
            },
            0ms);
        order.push_back("initialization completed");
    });
    const std::vector<std::string> expected{
        "initialization completed", "microtask",         "nested microtask",  "message1",
        "message microtask",        "message2",          "message microtask", "timer",
        "close returned",           "closing microtask",
    };
    require(order == expected, "Task/microtask/timer order changed");
    require(!loop.inbox()->post(std::make_unique<NumberEvent>(3)),
            "Closed realm accepted a message");
}

void display_animation_frames() {
    bbl::pal::AnimationFrameSource display;
    const auto origin = EventLoop::Clock::now();
    EventLoop main(std::make_shared<EventLoop::Inbox>(), origin);
    EventLoop worker(std::make_shared<EventLoop::Inbox>(), origin);
    display.subscribe(main.inbox());
    display.subscribe(worker.inbox());
    display.subscribe(main.inbox()); // Multiple engines in a realm share a tick.
    std::vector<double> main_frames;
    std::vector<double> worker_frames;
    std::vector<bbl::pal::AnimationFrameSource::Batch> batches;
    const auto all_pending = [&] {
        return std::none_of(batches.begin(), batches.end(),
                            [](const auto& batch) { return batch.ready(); });
    };
    EventLoop::AnimationFrameId cancelled = 0;
    main.post([&] {
        main.request_animation_frame([&](double time) {
            require(all_pending(), "Repaint completed before its callback");
            main_frames.push_back(time);
            main.queue_microtask([&] {
                require(all_pending(), "Repaint completed before its microtasks");
                main.queue_microtask([&] {
                    require(all_pending(), "Repaint completed before its nested microtasks");
                    main.cancel_animation_frame(cancelled);
                });
            });
            main.request_animation_frame([&](double next) { main_frames.push_back(next); });
        });
        cancelled = main.request_animation_frame(
            [](double) { throw std::runtime_error("Cancelled frame ran"); });
    });
    worker.post([&] {
        worker.request_animation_frame([&](double time) { worker_frames.push_back(time); });
    });
    main.poll();
    worker.poll();
    // The main realm stays busy across many repaints. The worker dispatches
    // independently; the main receives one latest tick, never a catch-up burst.
    for (int tick = 1; tick <= 100; ++tick) {
        batches.push_back(display.tick(origin + tick * 1ms));
        worker.poll();
    }
    require(worker_frames == std::vector<double>{1},
            "Worker animation depended on main dispatch or repeated a one-shot request");
    require(all_pending(), "Coalesced repaint ignored an unfinished subscriber");
    main.poll();
    require(main_frames == std::vector<double>{100}, "Busy realm accumulated animation frames");
    require(std::all_of(batches.begin(), batches.end(),
                        [](const auto& batch) { return batch.ready(); }),
            "Coalesced repaint receipts did not complete together");
    require(!main.poll(), "New animation callback ran without a new repaint");
    display.tick(origin + 101ms);
    main.poll();
    require(main_frames == std::vector<double>({100, 101}),
            "Animation frames acquired timer nesting delays");
    main.post([&] {
        main.request_animation_frame(
            [](double) { throw std::runtime_error("Frame survived close"); });
        main.close();
    });
    main.poll();
    display.tick(origin + 102ms);
    require(!main.poll(), "Closed realm received an animation frame");
}

void fixed_animation_clock() {
    bbl::pal::AnimationFrameSource display;
    const auto origin = EventLoop::Clock::now();
    EventLoop loop(std::make_shared<EventLoop::Inbox>(), origin);
    display.subscribe(loop.inbox());
    std::vector<std::string> order;
    EventLoop::TimerId interval = 0;
    loop.post([&] {
        loop.set_timeout([&] { order.push_back("real"); }, 0);
        loop.use_fixed_animation_time(10);
        loop.set_timeout([&] { order.push_back("timeout"); }, 25);
        interval = loop.set_timeout(
            [&] {
                order.push_back("interval:" + std::to_string(static_cast<int>(loop.now())));
                if (loop.now() == 30) {
                    loop.clear_timer(interval);
                    loop.set_timeout([&] { order.push_back("late"); }, 0);
                }
            },
            1, true);
        loop.request_animation_frame([&](double time) {
            require(time == 0 && loop.now() == 0, "Fixed frame epoch");
            order.push_back("frame");
        });
    });
    while (loop.poll()) {
    }
    for (int frame = 0; frame < 5; ++frame) {
        display.tick(origin + std::chrono::milliseconds(1000 + frame * 3));
        while (loop.poll()) {
        }
    }
    require(order == std::vector<std::string>{"real", "frame", "interval:10", "interval:20",
                                              "timeout", "interval:30", "late"},
            "Fixed frame timers must drain once per frame, after RAF, without wall-clock catch-up");
    require(loop.now() == 40, "Fixed clock followed display frequency");
    loop.close();
}

void animation_receipt_next_batch() {
    using Batch = bbl::pal::AnimationFrameSource::Batch;
    bbl::pal::AnimationFrameSource display;
    const auto origin = EventLoop::Clock::now();
    EventLoop loop(std::make_shared<EventLoop::Inbox>(), origin);
    display.subscribe(loop.inbox());
    Batch first, active_only, next;
    std::vector<int> order;
    require(first.ready(), "Empty repaint receipt did not complete immediately");
    loop.post([&] {
        loop.request_animation_frame([&](double timestamp) {
            require(timestamp == 1 && !first.ready(), "First repaint completed before dispatch");
            order.push_back(1);
            active_only = display.tick(origin + 1500us);
            require(!active_only.ready(), "Tick ignored an active one-shot callback");
            loop.request_animation_frame([&](double later) {
                require(later == 2 && first.ready() && !next.ready(),
                        "Next repaint lost its independent completion");
                order.push_back(4);
                loop.queue_microtask([&] {
                    require(!next.ready(), "Next repaint completed before its microtask");
                    order.push_back(5);
                });
            });
            next = display.tick(origin + 2ms);
            require(!next.ready(), "Tick during active repaint was prematurely completed");
            loop.queue_microtask([&] {
                require(!first.ready() && !active_only.ready() && !next.ready(),
                        "Active repaint receipts changed early");
                order.push_back(2);
            });
        });
        loop.request_animation_frame([&](double) {
            require(!first.ready() && !next.ready(), "Receipt ignored another callback in batch");
            order.push_back(3);
        });
    });
    loop.poll();
    first = display.tick(origin + 1ms);
    require(!first.ready(), "Queued repaint completed before dispatch");
    loop.poll();
    require(first.ready() && active_only.ready() && !next.ready(),
            "First completion released a later queued repaint");
    require(order == std::vector<int>({1, 2, 3}), "Next request ran in the current repaint batch");
    loop.poll();
    require(next.ready() && order == std::vector<int>({1, 2, 3, 4, 5}),
            "Next repaint or microtasks did not finish");
    require(display.tick(origin + 3ms).ready() && !loop.poll(),
            "Unrequested repaint queued realm work");
}

void animation_receipt_cancellation() {
    using Batch = bbl::pal::AnimationFrameSource::Batch;
    bbl::pal::AnimationFrameSource display;
    const auto timestamp = EventLoop::Clock::now();
    EventLoop loop;
    display.subscribe(loop.inbox());
    require(display.tick(timestamp).ready() && !loop.poll(),
            "Unrequested initial repaint queued realm work");
    EventLoop::AnimationFrameId callback = 0;
    loop.post([&] {
        callback = loop.request_animation_frame(
            [](double) { throw std::runtime_error("Cancelled repaint callback ran"); });
    });
    loop.poll();
    const auto cancelled = display.tick(timestamp);
    loop.cancel_animation_frame(callback);
    require(!cancelled.ready(), "Accepted cancellation bypassed its queued batch");
    loop.poll();
    require(cancelled.ready(), "Empty cancelled batch stranded its receipt");
    require(display.tick(timestamp).ready() && !loop.poll(),
            "Cancelled one-shot request queued another repaint");

    for (const bool terminate : {false, true}) {
        EventLoop pending;
        bbl::pal::AnimationFrameSource source;
        source.subscribe(pending.inbox());
        pending.request_animation_frame(
            [](double) { throw std::runtime_error("Shutdown repaint callback ran"); });
        const auto receipt = source.tick(timestamp);
        require(!receipt.ready(), "Pending shutdown receipt started ready");
        if (terminate)
            pending.inbox()->terminate();
        else
            pending.close();
        require(receipt.ready() && source.tick(timestamp).ready(),
                "Closed or terminated inbox stranded a queued repaint");
    }

    Batch expired;
    {
        bbl::pal::AnimationFrameSource source;
        EventLoop temporary;
        source.subscribe(temporary.inbox());
        temporary.request_animation_frame([](double) {});
        expired = source.tick(timestamp);
        require(!expired.ready(), "Temporary realm receipt started ready");
    }
    require(expired.ready(), "Destroyed inbox stranded a repaint receipt");

    // Closing an active callback must not release its receipt before microtasks.
    EventLoop closing;
    bbl::pal::AnimationFrameSource source;
    source.subscribe(closing.inbox());
    Batch active, queued;
    bool microtask_ran = false;
    closing.request_animation_frame([&](double) {
        closing.request_animation_frame(
            [](double) { throw std::runtime_error("Queued repaint survived active close"); });
        queued = source.tick(timestamp);
        closing.close();
        require(!active.ready() && !queued.ready(), "Active close released receipts before unwind");
        closing.queue_microtask([&] {
            require(!active.ready() && !queued.ready(),
                    "Active close skipped microtask completion");
            microtask_ran = true;
        });
    });
    active = source.tick(timestamp);
    closing.poll();
    require(microtask_ran && active.ready() && queued.ready(),
            "Active close did not settle cancelled and running receipts");
}

void computation_without_graphics() {
    EventLoop parent;
    const auto worker_inbox = std::make_shared<EventLoop::Inbox>();
    std::atomic<unsigned> completed{0};
    std::jthread worker([&] {
        EventLoop loop(worker_inbox);
        loop.run([&] {
            loop.on_event([&](std::unique_ptr<ExternalEvent> event) {
                const auto* number = dynamic_cast<NumberEvent*>(event.get());
                require(number != nullptr, "Wrong computation request");
                parent.inbox()->post(std::make_unique<NumberEvent>(number->value * number->value));
                completed.fetch_add(1);
                if (number->value == 63)
                    loop.close();
            });
        });
    });
    unsigned received = 0;
    parent.run([&] {
        parent.on_event([&](std::unique_ptr<ExternalEvent> event) {
            const auto* number = dynamic_cast<NumberEvent*>(event.get());
            require(number && number->value == static_cast<int>(received * received),
                    "Message order or computation failed");
            if (++received == 64)
                parent.close();
        });
        for (int n = 0; n < 64; ++n)
            worker_inbox->post(std::make_unique<NumberEvent>(n));
        // The parent does not dispatch while the worker completes its work.
        const auto deadline = EventLoop::Clock::now() + 3s;
        while (completed.load() != 64 && EventLoop::Clock::now() < deadline)
            std::this_thread::yield();
        require(completed.load() == 64 && received == 0, "Computation depended on parent dispatch");
    });
    worker.join();
}

void timers_and_errors() {
    EventLoop loop;
    int ticks = 0;
    int errors = 0;
    EventLoop::TimerId interval = 0;
    loop.run([&] {
        loop.on_error([&](std::exception_ptr error) {
            try {
                std::rethrow_exception(error);
            } catch (const std::runtime_error& problem) {
                require(std::string(problem.what()) == "source failure", "Error lost its message");
                ++errors;
            }
        });
        loop.post([] { throw std::runtime_error("source failure"); });
        interval = loop.set_timer(
            [&] {
                if (++ticks == 3) {
                    loop.clear_timer(interval);
                    loop.set_timer([&] { loop.close(); }, 5ms);
                }
            },
            1ms, true);
    });
    require(ticks == 3 && errors == 1, "Interval cancellation or error delivery failed");
}

void terminate_busy_and_release_on_owner() {
    const auto inbox = std::make_shared<EventLoop::Inbox>();
    std::promise<void> started;
    std::atomic<bool> destroyed_on_owner{false};
    std::atomic<bool> pending_ran{false};
    struct Owned {
        std::thread::id owner;
        std::atomic<bool>& result;
        ~Owned() { result.store(owner == std::this_thread::get_id()); }
    };
    std::jthread worker([&] {
        EventLoop loop(inbox);
        loop.run([&] {
            auto owned = std::make_shared<Owned>(std::this_thread::get_id(), destroyed_on_owner);
            loop.post([owned, &pending_ran] { pending_ran.store(true); });
            started.set_value();
            for (;;)
                loop.checkpoint();
        });
    });
    require(started.get_future().wait_for(3s) == std::future_status::ready,
            "Worker did not initialize");
    inbox->terminate();
    worker.join();
    require(!pending_ran.load() && destroyed_on_owner.load(),
            "Termination ran pending work or released JS storage on requester");
    require(!inbox->post(std::make_unique<NumberEvent>(1)), "Terminated realm accepted a message");
}

void terminate_idle_and_before_initialization() {
    for (bool before : {true, false}) {
        const auto inbox = std::make_shared<EventLoop::Inbox>();
        std::promise<void> initialized;
        std::atomic<bool> executed{false};
        if (before)
            inbox->terminate();
        std::jthread worker([&] {
            EventLoop loop(inbox);
            if (before)
                initialized.set_value();
            loop.run([&] {
                executed.store(true);
                initialized.set_value();
            });
        });
        require(initialized.get_future().wait_for(3s) == std::future_status::ready,
                "Idle worker did not initialize");
        inbox->terminate();
        worker.join();
        require(executed.load() != before,
                "Termination before initialization still executed source");
    }
}
void closing_before_cleanup() {
    for (const bool terminate : {false, true}) {
        EventLoop loop;
        std::vector<std::string> order;
        bool owner_alive = true;
        loop.run(
            [&] {
                loop.defer_cleanup([&] {
                    owner_alive = false;
                    order.push_back("cleanup");
                });
                loop.post([&] { order.push_back("discarded task"); });
                if (terminate) {
                    loop.queue_microtask([&] { order.push_back("discarded microtask"); });
                    loop.inbox()->terminate();
                } else
                    loop.close();
            },
            [&] {
                require(owner_alive, "Closing callback ran after native cleanup");
                loop.checkpoint();
                order.push_back("closing");
                loop.dispatch_callback(
                    [&] { loop.queue_microtask([&] { order.push_back("closing microtask"); }); });
            });
        require(order == std::vector<std::string>{"closing", "closing microtask", "cleanup"},
                "Closing event ordering");
        require(!owner_alive, "Closing callback prevented cleanup");
    }
    EventLoop loop;
    bool cleaned = false;
    try {
        loop.run(
            [&] {
                loop.defer_cleanup([&] { cleaned = true; });
                throw std::runtime_error("original failure");
            },
            [] { throw std::runtime_error("closing failure"); });
        require(false, "Initial error was lost during closing");
    } catch (const std::runtime_error& error) {
        require(std::string(error.what()) == "original failure",
                "Closing error replaced initial failure");
    }
    require(cleaned, "Closing exception skipped cleanup");
    EventLoop closing_failure;
    bool closing_cleaned = false;
    try {
        closing_failure.run(
            [&] {
                closing_failure.defer_cleanup([&] { closing_cleaned = true; });
                closing_failure.close();
            },
            [] { throw std::runtime_error("closing failure"); });
        require(false, "Closing error was lost");
    } catch (const std::runtime_error& error) {
        require(std::string(error.what()) == "closing failure", "Closing error changed");
    }
    require(closing_cleaned, "Closing-only failure skipped cleanup");
}

/** Records the thread that releases it. */
struct ReleaseProbe {
    explicit ReleaseProbe(std::thread::id& target) : released(target) {}
    ReleaseProbe(const ReleaseProbe&) = delete;
    ReleaseProbe& operator=(const ReleaseProbe&) = delete;
    ~ReleaseProbe() { released = std::this_thread::get_id(); }
    std::thread::id& released;
};

void native_jobs_settle_in_start_order() {
    using bbl::pal::run_native_job;
    const bbl::js::RealmScope realm;
    EventLoop loop;
    const auto realm_thread = std::this_thread::get_id();
    std::binary_semaphore release_slow{0};
    std::atomic<bool> fast_finished = false;
    std::thread::id probe_released;
    std::vector<std::string> order;
    EventLoop::TimerId poll = 0;
    loop.run([&] {
        run_native_job<int>(
            [&] {
                require(std::this_thread::get_id() != realm_thread,
                        "A native job ran on its realm");
                release_slow.acquire();
                return 1;
            },
            [&](int value) {
                order.push_back("slow" + std::to_string(value));
                return value;
            });
        run_native_job<int>(
            [&, probe = std::make_shared<ReleaseProbe>(probe_released)] {
                static_cast<void>(probe);
                fast_finished = true;
                return 2;
            },
            [&](int value) {
                order.push_back("fast" + std::to_string(value));
                return value;
            });
        run_native_job<int>([]() -> int { throw std::runtime_error("job failed"); },
                            [&](int) -> int {
                                order.push_back("failed job settled");
                                return 0;
                            })
            .observe([](const int&) { require(false, "A failed job fulfilled its promise"); },
                     [&](std::exception_ptr error) {
                         try {
                             std::rethrow_exception(error);
                         } catch (const std::runtime_error& failure) {
                             order.push_back(failure.what());
                         }
                         loop.close();
                     });
        // The later job finishes first; its settlement still waits for the earlier one.
        poll = loop.set_timeout(
            [&] {
                if (!fast_finished)
                    return;
                loop.clear_timer(poll);
                loop.set_timeout(
                    [&] {
                        require(order.empty(), "A later native job settled before an earlier one");
                        release_slow.release();
                    },
                    20);
            },
            1, true);
    });
    require(order == std::vector<std::string>({"slow1", "fast2", "job failed"}),
            "Native jobs did not settle in start order");
    require(probe_released == realm_thread, "A native job's captures were released off its realm");
}

void native_jobs_at_realm_close() {
    using bbl::pal::run_native_job;
    auto& workers = bbl::pal::NativeWorkers::instance();
    const auto capacity = static_cast<std::ptrdiff_t>(workers.capacity());
    // Occupy every worker, so the next job stays queued behind them.
    std::counting_semaphore<> started{0}, proceed{0};
    std::vector<bbl::pal::NativeWork<int>> blockers;
    for (std::ptrdiff_t index = 0; index < capacity; ++index)
        blockers.push_back(bbl::pal::start_native_work([&] {
            started.release();
            proceed.acquire();
            return 0;
        }));
    for (std::ptrdiff_t index = 0; index < capacity; ++index)
        started.acquire();
    std::atomic<bool> queued_ran = false;
    {
        const bbl::js::RealmScope realm;
        EventLoop loop;
        loop.run([&] {
            run_native_job<int>(
                [&] {
                    queued_ran = true;
                    return 0;
                },
                [](int value) { return value; });
            loop.close();
        });
    }
    proceed.release(capacity);
    std::set<std::thread::id> threads;
    std::mutex threads_mutex;
    for (auto& blocker : blockers)
        require(blocker.get() == 0, "A native worker lost its result");
    // Work beyond the capacity reuses the same threads.
    std::vector<bbl::pal::NativeWork<int>> round;
    for (std::ptrdiff_t index = 0; index < capacity * 4; ++index)
        round.push_back(bbl::pal::start_native_work([&] {
            const std::lock_guard lock(threads_mutex);
            threads.insert(std::this_thread::get_id());
            return 0;
        }));
    for (auto& work : round)
        require(work.get() == 0, "A native worker lost its result");
    require(threads.size() <= workers.capacity(), "Native workers exceeded their capacity");
    require(!queued_ran, "A closed realm's queued native job ran");

    // A running job holds its realm's close until it finishes.
    std::atomic<bool> running_finished = false;
    {
        const bbl::js::RealmScope realm;
        EventLoop loop;
        std::binary_semaphore job_started{0};
        loop.run([&] {
            run_native_job<int>(
                [&] {
                    job_started.release();
                    std::this_thread::sleep_for(50ms);
                    running_finished = true;
                    return 0;
                },
                [](int value) { return value; });
            job_started.acquire();
            loop.close();
        });
        require(running_finished, "A closed realm did not wait for its running native job");
    }
}

void native_work_never_waits_on_native_work() {
    // Once every worker waited on queued work, none would be left to run it.
    auto inner = bbl::pal::start_native_work([] { return 1; });
    auto outer = bbl::pal::start_native_work([&inner] { return inner.get(); });
    bool refused = false;
    try {
        static_cast<void>(outer.get());
    } catch (const std::logic_error& error) {
        refused = std::string_view(error.what()) == "Native work cannot wait on other native work.";
    }
    require(refused, "A native worker waited on other native work");
    require(inner.get() == 1, "The native work a worker refused to wait on was lost");
    // A worker idle past its exit time leaves; later work starts another.
    require(bbl::pal::start_native_work([] { return 2; }).get() == 2, "Native work failed");
    std::this_thread::sleep_for(1200ms);
    require(bbl::pal::start_native_work([] { return 3; }).get() == 3,
            "Native work failed after idle workers exited");
}

/** A worker destroying native work it would wait for ends the process. */
int owner_on_worker() {
    std::binary_semaphore started{0}, proceed{0};
    std::optional<bbl::pal::NativeWork<int>> running(bbl::pal::start_native_work([&] {
        started.release();
        proceed.acquire();
        return 0;
    }));
    started.acquire();
    auto owner = bbl::pal::start_native_work([&] {
        // This worker's handler (MSVC keeps one per thread) reports the end.
        std::set_terminate([] {
            std::fputs("native work owner refused on a worker\n", stdout);
            std::fflush(stdout);
            std::_Exit(0);
        });
        const auto moved = std::move(*running);
        return 0;
    });
    static_cast<void>(owner.get());
    return 1;
}
} // namespace

int main(int argc, char** argv) {
    if (argc > 1 && std::string_view(argv[1]) == "owner-on-worker")
        return owner_on_worker();
    try {
        ordering_and_cancellation();
        display_animation_frames();
        fixed_animation_clock();
        animation_receipt_next_batch();
        animation_receipt_cancellation();
        computation_without_graphics();
        timers_and_errors();
        terminate_busy_and_release_on_owner();
        terminate_idle_and_before_initialization();
        closing_before_cleanup();
        native_jobs_settle_in_start_order();
        native_jobs_at_realm_close();
        native_work_never_waits_on_native_work();
        std::cout << "Worker event loop: ordering, computation, timers, errors, termination and "
                     "native jobs passed.\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}

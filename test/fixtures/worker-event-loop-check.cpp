#include <bblite/pal_event_loop.hpp>
#include <bblite/pal_animation_frame.hpp>

#include <atomic>
#include <future>
#include <iostream>
#include <string>

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
} // namespace

int main() {
    try {
        ordering_and_cancellation();
        display_animation_frames();
        animation_receipt_next_batch();
        animation_receipt_cancellation();
        computation_without_graphics();
        timers_and_errors();
        terminate_busy_and_release_on_owner();
        terminate_idle_and_before_initialization();
        closing_before_cleanup();
        std::cout
            << "Worker event loop: ordering, computation, timers, errors and termination passed.\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}

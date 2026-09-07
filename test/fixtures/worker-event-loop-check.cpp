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
    if (!condition) throw std::runtime_error(message);
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
        loop.set_timer([&] {
            order.push_back("timer");
            loop.post([&] { order.push_back("discarded task"); });
            loop.queue_microtask([&] { order.push_back("closing microtask"); });
            loop.close();
            order.push_back("close returned");
        }, 0ms);
        order.push_back("initialization completed");
    });
    const std::vector<std::string> expected{
        "initialization completed", "microtask", "nested microtask",
        "message1", "message microtask", "message2", "message microtask",
        "timer", "close returned", "closing microtask",
    };
    require(order == expected, "Task/microtask/timer order changed");
    require(!loop.inbox()->post(std::make_unique<NumberEvent>(3)), "Closed realm accepted a message");
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
    EventLoop::AnimationFrameId cancelled = 0;
    main.post([&] {
        main.request_animation_frame([&](double time) {
            main_frames.push_back(time);
            main.queue_microtask([&] { main.cancel_animation_frame(cancelled); });
            main.request_animation_frame([&](double next) { main_frames.push_back(next); });
        });
        cancelled = main.request_animation_frame([](double) { throw std::runtime_error("Cancelled frame ran"); });
    });
    worker.post([&] {
        worker.request_animation_frame([&](double time) { worker_frames.push_back(time); });
    });
    main.poll(); worker.poll();
    // The main realm stays busy across many repaints. The worker dispatches
    // independently; the main receives one latest tick, never a catch-up burst.
    for (int tick = 1; tick <= 100; ++tick) {
        display.tick(origin + tick * 1ms);
        worker.poll();
    }
    require(worker_frames == std::vector<double>{1}, "Worker animation depended on main dispatch or repeated a one-shot request");
    main.poll();
    require(main_frames == std::vector<double>{100}, "Busy realm accumulated animation frames");
    require(!main.poll(), "New animation callback ran without a new repaint");
    display.tick(origin + 101ms);
    main.poll();
    require(main_frames == std::vector<double>({100, 101}), "Animation frames acquired timer nesting delays");
    main.post([&] {
        main.request_animation_frame([](double) { throw std::runtime_error("Frame survived close"); });
        main.close();
    });
    main.poll();
    display.tick(origin + 102ms);
    require(!main.poll(), "Closed realm received an animation frame");
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
                if (number->value == 63) loop.close();
            });
        });
    });
    unsigned received = 0;
    parent.run([&] {
        parent.on_event([&](std::unique_ptr<ExternalEvent> event) {
            const auto* number = dynamic_cast<NumberEvent*>(event.get());
            require(number && number->value == static_cast<int>(received * received), "Message order or computation failed");
            if (++received == 64) parent.close();
        });
        for (int n = 0; n < 64; ++n) worker_inbox->post(std::make_unique<NumberEvent>(n));
        // The parent does not dispatch while the worker completes its work.
        const auto deadline = EventLoop::Clock::now() + 3s;
        while (completed.load() != 64 && EventLoop::Clock::now() < deadline) std::this_thread::yield();
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
            try { std::rethrow_exception(error); }
            catch (const std::runtime_error& problem) {
                require(std::string(problem.what()) == "source failure", "Error lost its message");
                ++errors;
            }
        });
        loop.post([] { throw std::runtime_error("source failure"); });
        interval = loop.set_timer([&] {
            if (++ticks == 3) {
                loop.clear_timer(interval);
                loop.set_timer([&] { loop.close(); }, 5ms);
            }
        }, 1ms, true);
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
            for (;;) loop.checkpoint();
        });
    });
    require(started.get_future().wait_for(3s) == std::future_status::ready, "Worker did not initialize");
    inbox->terminate();
    worker.join();
    require(!pending_ran.load() && destroyed_on_owner.load(), "Termination ran pending work or released JS storage on requester");
    require(!inbox->post(std::make_unique<NumberEvent>(1)), "Terminated realm accepted a message");
}

void terminate_idle_and_before_initialization() {
    for (bool before : {true, false}) {
        const auto inbox = std::make_shared<EventLoop::Inbox>();
        std::promise<void> initialized;
        std::atomic<bool> executed{false};
        if (before) inbox->terminate();
        std::jthread worker([&] {
            EventLoop loop(inbox);
            if (before) initialized.set_value();
            loop.run([&] { executed.store(true); initialized.set_value(); });
        });
        require(initialized.get_future().wait_for(3s) == std::future_status::ready, "Idle worker did not initialize");
        inbox->terminate();
        worker.join();
        require(executed.load() != before, "Termination before initialization still executed source");
    }
}
} // namespace

int main() {
    try {
        ordering_and_cancellation();
        display_animation_frames();
        computation_without_graphics();
        timers_and_errors();
        terminate_busy_and_release_on_owner();
        terminate_idle_and_before_initialization();
        std::cout << "Worker event loop: ordering, computation, timers, errors and termination passed.\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}

#include "pal_window_frame_clock.hpp"

#include <array>
#include <cassert>
#include <iostream>
#include <vector>

using bbl::pal::WindowFrameClock;
using bbl::pal::detail::WindowFrameClockTicks;
using namespace std::chrono_literals;

struct HeartbeatLoop {
    struct Clock {
        using time_point = WindowFrameClock::Clock::time_point;
        static inline unsigned index = 0;
        static inline std::array delays{0ms, 3ms, 13ms};
        static time_point now() {
            // Irregular actual wake times must survive without a nominal refresh grid.
            return time_point{17s} + delays.at(index++);
        }
    };
    struct Api {
        HANDLE stop = nullptr;
        std::vector<DWORD> responses;
        std::size_t next = 0;
        WindowFrameClockTicks* consumer = nullptr;
        std::vector<Clock::time_point> delivered;
        DWORD wait(UINT count, const HANDLE* handles, DWORD timeout) {
            assert(count == 1 && handles == &stop && timeout <= 100);
            if (consumer)
                if (const auto timestamp = consumer->take_latest())
                    delivered.push_back(*timestamp);
            return responses.at(next++);
        }
        // Independent-flip frames have no composition statistics to query.
    };
    Api* api_;
    WindowFrameClockTicks ticks_;
    bool cpu_profile_ = false;
    static std::runtime_error api_error(const char* operation, unsigned long) {
        return std::runtime_error(operation);
    }
#include "clock-wait-loop.hpp"
};

int main(int argc, char** argv) {
    using Clock = WindowFrameClock::Clock;
    const Clock::time_point origin{17s};
    for (const bool consume : {false, true}) {
        HeartbeatLoop::Clock::index = 0;
        HeartbeatLoop::Api api{
            nullptr,
            {WAIT_OBJECT_0 + 1, WAIT_TIMEOUT, WAIT_OBJECT_0 + 1, WAIT_OBJECT_0 + 1, WAIT_OBJECT_0}};
        HeartbeatLoop loop{&api, {}};
        if (consume)
            api.consumer = &loop.ticks_;
        loop.run();
        assert(api.next == api.responses.size());
        if (consume) {
            assert((api.delivered == std::vector{origin, origin + 3ms, origin + 13ms}));
            assert(!loop.ticks_.take_latest());
        } else {
            assert(loop.ticks_.take_latest() == origin + 13ms);
        }
    }

    HeartbeatLoop::Api broken{nullptr, {WAIT_FAILED}};
    HeartbeatLoop failed{&broken, {}};
    failed.run();
    bool reported_wait_failure = false;
    try {
        (void)failed.ticks_.take_latest();
    } catch (const std::runtime_error& error) {
        reported_wait_failure = std::string_view(error.what()) == "wait";
    }
    assert(reported_wait_failure);

    HeartbeatLoop::Clock::index = 0;
    HeartbeatLoop::Clock::delays = {0ms, 500ms, 1000ms};
    HeartbeatLoop::Api profiled_api{
        nullptr, {WAIT_OBJECT_0 + 1, WAIT_OBJECT_0 + 1, WAIT_OBJECT_0 + 1, WAIT_OBJECT_0}};
    HeartbeatLoop profiled{&profiled_api, {}, true};
    profiled.run();
    assert(profiled.ticks_.take_latest() == origin + 1000ms);

    WindowFrameClockTicks ticks;
    assert(!ticks.wait_for(0ms));
    assert(ticks.publish(origin));
    assert(!ticks.publish(origin + 5ms));
    assert(ticks.wait_for(0ms));
    assert(ticks.take_latest() == origin + 5ms);
    assert(!ticks.take_latest());
    assert(ticks.publish(origin + 9ms));
    ticks.fail(std::make_exception_ptr(std::runtime_error("clock transport failed")));
    assert(ticks.wait_for(0ms));
    bool reported_failure = false;
    try {
        (void)ticks.take_latest();
    } catch (const std::runtime_error& error) {
        reported_failure = std::string_view(error.what()) == "clock transport failed";
    }
    assert(reported_failure);

    if (argc != 2 || std::string_view(argv[1]) != "--live")
        return 0;

    unsigned received = 0;
    std::optional<Clock::time_point> previous;
    auto stopped = Clock::now();
    {
        WindowFrameClock clock;
        if (!clock.available()) {
            assert(!clock.wait_for(0ms));
            assert(!clock.take_latest());
            std::cout << "Compositor clock unavailable; deterministic checks passed.\n";
            return 0;
        }
        while (received < 12) {
            if (!clock.wait_for(1000ms))
                throw std::runtime_error("Live compositor clock did not publish within 1 second.");
            const auto timestamp = clock.take_latest();
            assert(timestamp);
            assert(!previous || *timestamp > *previous);
            assert(*timestamp <= Clock::now());
            previous = timestamp;
            ++received;
        }
        stopped = Clock::now();
    }
    const auto stop_time = Clock::now() - stopped;
    assert(stop_time < 500ms);
    std::cout << "Live compositor clock: " << received << " increasing actual timestamps; teardown "
              << std::chrono::duration<double, std::milli>(stop_time).count() << " ms.\n";
}

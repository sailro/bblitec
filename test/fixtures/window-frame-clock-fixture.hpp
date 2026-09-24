#pragma once

#include "pal_window_frame_clock.hpp"

namespace bbl::pal {

// Include before interposing WindowFrameClock around pal_window_realm.cpp.
// No display timing or GPU is involved in the Window host fixtures.
class FixtureWindowFrameClock {
public:
    using Clock = WindowFrameClock::Clock;
    static inline bool enabled = false;

    explicit FixtureWindowFrameClock(bool = false, bool = false) {}
    bool available() const { return enabled; }
    std::optional<Clock::time_point> take_latest() {
        if (!enabled)
            return std::nullopt;
        return Clock::now();
    }
    bool wait_for(std::chrono::milliseconds timeout) {
        std::this_thread::sleep_for(timeout);
        return enabled;
    }
};

} // namespace bbl::pal

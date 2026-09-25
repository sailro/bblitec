#pragma once

#include <bit>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <exception>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <dcomp.h>
#endif

namespace bbl::pal {
namespace detail {

#ifdef _WIN32
/** ntstatus.h STATUS_GRAPHICS_PRESENT_OCCLUDED: no active display. */
inline constexpr DWORD compositor_display_occluded = 0xC01E0006UL;

/** A bounded run whose compositor clock stopped ticking: names the wait's actual last status. */
inline std::runtime_error compositor_idle_error(DWORD status, std::size_t waits, DWORD wait_ms) {
    char code[16];
    std::snprintf(code, sizeof code, "0x%08lX", static_cast<unsigned long>(status));
    const std::string cause =
        status == compositor_display_occluded
            ? std::string(code) + " STATUS_GRAPHICS_PRESENT_OCCLUDED: no active display, as while "
                                  "the console session is locked"
        : status == WAIT_TIMEOUT ? std::string("WAIT_TIMEOUT: the compositor did not tick")
                                 : std::string(code);
    return std::runtime_error("Windows compositor clock produced no heartbeat in " +
                              std::to_string(waits) + " consecutive waits (" +
                              std::to_string(waits * wait_ms) +
                              " ms) of a bounded run; last status " + cause + ".");
}
#endif

/** At most one display tick survives while the Window thread is busy. */
class WindowFrameClockTicks {
public:
    using Clock = std::chrono::steady_clock;

    bool publish(Clock::time_point timestamp) {
        bool wake;
        {
            std::lock_guard lock(mutex_);
            wake = !latest_;
            latest_ = timestamp;
        }
        changed_.notify_all();
        return wake;
    }
    void fail(std::exception_ptr error) {
        {
            std::lock_guard lock(mutex_);
            error_ = error;
        }
        changed_.notify_all();
    }
    std::optional<Clock::time_point> take_latest() {
        std::lock_guard lock(mutex_);
        if (error_)
            std::rethrow_exception(error_);
        return std::exchange(latest_, std::nullopt);
    }
    bool wait_for(std::chrono::milliseconds timeout) {
        std::unique_lock lock(mutex_);
        return changed_.wait_for(lock, timeout, [&] { return latest_ || error_; });
    }

private:
    std::mutex mutex_;
    std::condition_variable changed_;
    std::optional<Clock::time_point> latest_;
    std::exception_ptr error_;
};

} // namespace detail

/** Native Window pacing shared by both GPU backends. Missing platform APIs are
 * unavailable; failures after acquisition propagate through take_latest(). An
 * unbounded run waits out an occluded display; a bounded one (a frame budget or
 * capture) fails after `bounded_idle_waits` heartbeat waits in a row end without
 * a tick, naming the last status. */
class WindowFrameClock {
public:
    using Clock = std::chrono::steady_clock;
    /** 300 waits of 100 ms: thirty seconds without a compositor heartbeat. */
    static constexpr std::size_t bounded_idle_waits = 300;

    explicit WindowFrameClock(bool cpu_profile = false, bool bounded_run = false)
        : cpu_profile_(cpu_profile), idle_wait_limit_(bounded_run ? bounded_idle_waits : 0) {
#ifdef _WIN32
        api_ = acquire_api();
        if (api_)
            waiter_ = std::jthread([this] { run(); });
#endif
    }
    WindowFrameClock(const WindowFrameClock&) = delete;
    WindowFrameClock& operator=(const WindowFrameClock&) = delete;
    ~WindowFrameClock() {
#ifdef _WIN32
        if (api_)
            SetEvent(api_->stop);
        if (waiter_.joinable())
            waiter_.join();
#endif
    }

    bool available() const noexcept {
#ifdef _WIN32
        return api_ != nullptr;
#else
        return false;
#endif
    }
    std::optional<Clock::time_point> take_latest() { return ticks_.take_latest(); }
    bool wait_for(std::chrono::milliseconds timeout) {
        return available() && ticks_.wait_for(timeout);
    }

private:
    detail::WindowFrameClockTicks ticks_;
    bool cpu_profile_ = false;
    /** Consecutive tickless waits a bounded run tolerates; 0 waits forever. */
    std::size_t idle_wait_limit_ = 0;

#ifdef _WIN32
    struct Api {
        HMODULE module = nullptr;
        HANDLE stop = nullptr;
        decltype(&DCompositionWaitForCompositorClock) wait = nullptr;
        /** Waits on the stop event alone while the display is unavailable. */
        DWORD rest(DWORD timeout) const { return WaitForSingleObject(stop, timeout); }
        ~Api() {
            if (stop)
                CloseHandle(stop);
            if (module)
                FreeLibrary(module);
        }
    };
    std::unique_ptr<Api> api_;
    std::jthread waiter_;

    static std::runtime_error api_error(const char* operation, unsigned long code) {
        return std::runtime_error(std::string("Windows compositor ") + operation +
                                  " failed (code " + std::to_string(code) + ").");
    }
    static std::unique_ptr<Api> acquire_api() {
        auto api = std::make_unique<Api>();
        api->module = LoadLibraryExW(L"dcomp.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
        if (!api->module) {
            const auto error = GetLastError();
            if (error == ERROR_MOD_NOT_FOUND)
                return nullptr;
            throw api_error("load", error);
        }
        api->wait = std::bit_cast<decltype(api->wait)>(
            GetProcAddress(api->module, "DCompositionWaitForCompositorClock"));
        if (!api->wait)
            return nullptr;
        api->stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!api->stop)
            throw api_error("stop event", GetLastError());
        return api;
    }
    void run() noexcept {
        try {
            constexpr DWORD timeout_ms = 100;
            std::optional<Clock::time_point> profile_started;
            Clock::time_point profile_previous{};
            std::size_t profile_heartbeats = 0;
            std::size_t profile_coalesced = 0;
            double profile_max_gap_ms = 0;
            std::size_t idle_waits = 0;
            for (;;) {
                // With one supplied handle, the compositor signal is WAIT_OBJECT_0 + 1.
                // The finite timeout also covers adapter disconnects.
                const DWORD status = api_->wait(1, &api_->stop, timeout_ms);
                if (status == WAIT_OBJECT_0)
                    return;
                if (status == WAIT_TIMEOUT || status == detail::compositor_display_occluded) {
                    if (idle_wait_limit_ && ++idle_waits >= idle_wait_limit_)
                        throw detail::compositor_idle_error(status, idle_waits, timeout_ms);
                    if (status == WAIT_TIMEOUT)
                        continue;
                    // Retry availability without generating frames or busy-spinning.
                    const auto retry = api_->rest(timeout_ms);
                    if (retry == WAIT_OBJECT_0)
                        return;
                    if (retry != WAIT_TIMEOUT)
                        throw api_error("availability wait", GetLastError());
                    continue;
                }
                if (status != WAIT_OBJECT_0 + 1)
                    throw api_error("wait", status);
                idle_waits = 0;
                // Completed composition statistics omit independent-flip frames.
                // Every successful heartbeat is a repaint opportunity; like Chromium's
                // VSyncThreadWin, timestamp its actual wake, never a predicted refresh grid.
                const auto timestamp = Clock::now();
                const bool coalesced = !ticks_.publish(timestamp);
                if (cpu_profile_) {
                    if (profile_started) {
                        ++profile_heartbeats;
                        if (coalesced)
                            ++profile_coalesced;
                        const double gap_ms =
                            std::chrono::duration<double, std::milli>(timestamp - profile_previous)
                                .count();
                        if (gap_ms > profile_max_gap_ms)
                            profile_max_gap_ms = gap_ms;
                        const double elapsed_ms =
                            std::chrono::duration<double, std::milli>(timestamp - *profile_started)
                                .count();
                        if (elapsed_ms >= 1000) {
                            std::fprintf(stderr,
                                         "[window-clock] heartbeats=%zu elapsed_ms=%.3f hz=%.3f "
                                         "max_gap_ms=%.3f coalesced=%zu\n",
                                         profile_heartbeats, elapsed_ms,
                                         static_cast<double>(profile_heartbeats) * 1000 /
                                             elapsed_ms,
                                         profile_max_gap_ms, profile_coalesced);
                            profile_started = timestamp;
                            profile_heartbeats = 0;
                            profile_coalesced = 0;
                            profile_max_gap_ms = 0;
                        }
                    } else {
                        profile_started = timestamp;
                    }
                    profile_previous = timestamp;
                }
            }
        } catch (...) {
            ticks_.fail(std::current_exception());
        }
    }
#endif
};

} // namespace bbl::pal

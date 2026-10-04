#pragma once

/**
 * Per-source-function CPU attribution for BBLITE_CPU_PROFILE
 * (docs/debugging.md). A scene generated with `--source-profile <names>`
 * opens one `SourceScope` at the top of each named source function's native
 * body. A scope adds its elapsed time to its function's per-frame record,
 * and its time minus the time of named scopes nested in it to the
 * function's self time, so the named functions partition the time they
 * cover. Records are per thread: completed startup scopes are reported before
 * the first frame resets them, then each frame resets and reports its own.
 * The same build counts the executable's heap allocations
 * (`pal_source_profile.cpp`) and times cycle collection at frame boundaries.
 */

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <mutex>
#include <string>
#include <vector>

#if defined(_M_X64) || defined(__x86_64__)
#if defined(_MSC_VER)
#include <intrin.h>
#else
#include <x86intrin.h>
#endif
#endif

namespace bbl::profile {

/** The cheapest monotonic count: the time-stamp counter on x86-64, the steady clock elsewhere. */
[[nodiscard]] inline std::uint64_t ticks() noexcept {
#if defined(_M_X64) || defined(__x86_64__)
    return __rdtsc();
#else
    return static_cast<std::uint64_t>(std::chrono::steady_clock::now().time_since_epoch().count());
#endif
}

/** The first tick reading and steady-clock time, against which ticks convert to milliseconds. */
struct TickOrigin {
    std::uint64_t ticks = 0;
    std::chrono::steady_clock::time_point time;
};

[[nodiscard]] inline const TickOrigin& tick_origin() {
    static const TickOrigin origin{ticks(), std::chrono::steady_clock::now()};
    return origin;
}

/** Milliseconds per tick, measured over the run so far. */
[[nodiscard]] inline double milliseconds_per_tick() {
    const TickOrigin& origin = tick_origin();
    const std::uint64_t now_ticks = ticks();
    const double elapsed_ms =
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - origin.time)
            .count();
    return now_ticks > origin.ticks && elapsed_ms > 0.0
               ? elapsed_ms / static_cast<double>(now_ticks - origin.ticks)
               : 0.0;
}

/** One named function's time on one thread since the frame began. */
struct SourceFunctionTotals {
    std::uint64_t calls = 0;
    std::uint64_t self_ticks = 0;
    std::uint64_t total_ticks = 0;
};

/**
 * The heap allocations one thread made since the frame began, and the
 * cycle collection it ran. Trivial, so an allocation during thread teardown
 * never reaches a destroyed record.
 */
struct AllocationTotals {
    std::uint64_t allocations = 0;
    std::uint64_t bytes = 0;
    std::uint64_t frees = 0;
    std::uint64_t allocation_ticks = 0;
    std::uint64_t collection_ticks = 0;
};

inline thread_local AllocationTotals allocation_totals;

class SourceScope;

struct SourceThreadRecords {
    std::vector<SourceFunctionTotals> functions;
    SourceScope* active = nullptr;
    bool frame_started = false;
};

[[nodiscard]] inline SourceThreadRecords& source_thread_records() {
    static thread_local SourceThreadRecords records;
    return records;
}

[[nodiscard]] inline std::mutex& source_function_mutex() {
    static std::mutex mutex;
    return mutex;
}

[[nodiscard]] inline std::vector<std::string>& source_function_names() {
    static std::vector<std::string> names;
    return names;
}

/** The index of a named function; a name registered twice keeps its first index. */
[[nodiscard]] inline std::size_t register_source_function(const char* name) {
    const std::lock_guard lock(source_function_mutex());
    auto& names = source_function_names();
    for (std::size_t index = 0; index < names.size(); ++index) {
        if (names[index] == name)
            return index;
    }
    names.emplace_back(name);
    return names.size() - 1;
}

/** Times one call of a named source function. */
class SourceScope {
public:
    explicit SourceScope(std::size_t function) noexcept
        : function_(function), parent_(source_thread_records().active) {
        static_cast<void>(tick_origin());
        start_ = ticks();
        source_thread_records().active = this;
    }
    SourceScope(const SourceScope&) = delete;
    SourceScope& operator=(const SourceScope&) = delete;
    ~SourceScope() {
        const std::uint64_t elapsed = ticks() - start_;
        SourceThreadRecords& records = source_thread_records();
        if (records.functions.size() <= function_)
            records.functions.resize(function_ + 1);
        SourceFunctionTotals& totals = records.functions[function_];
        ++totals.calls;
        totals.total_ticks += elapsed;
        totals.self_ticks += elapsed - nested_ticks_;
        if (parent_)
            parent_->nested_ticks_ += elapsed;
        records.active = parent_;
    }

private:
    std::size_t function_;
    SourceScope* parent_;
    std::uint64_t start_ = 0;
    std::uint64_t nested_ticks_ = 0;
};

/**
 * Print completed scopes and allocations without counting the report itself.
 * Startup has no frame number; ordinary frame tags retain their existing form.
 */
inline void report_records(long frame, bool startup) {
    // Read before printing: the report's own work must not count toward the frame.
    const AllocationTotals allocations = allocation_totals;
    const double ms_per_tick = milliseconds_per_tick();
    const SourceThreadRecords& records = source_thread_records();
    {
        const std::lock_guard lock(source_function_mutex());
        const std::vector<std::string>& names = source_function_names();
        for (std::size_t index = 0; index < records.functions.size() && index < names.size();
             ++index) {
            const SourceFunctionTotals& totals = records.functions[index];
            if (totals.calls == 0)
                continue;
            if (startup)
                std::fputs("[cpu][source-startup]", stderr);
            else
                std::fprintf(stderr, "[cpu][source] frame=%ld", frame);
            std::fprintf(stderr, " function=%s calls=%llu self_ms=%.3f total_ms=%.3f\n",
                         names[index].c_str(), static_cast<unsigned long long>(totals.calls),
                         static_cast<double>(totals.self_ticks) * ms_per_tick,
                         static_cast<double>(totals.total_ticks) * ms_per_tick);
        }
    }
    if (startup)
        std::fputs("[cpu][alloc-startup]", stderr);
    else
        std::fprintf(stderr, "[cpu][alloc] frame=%ld", frame);
    std::fprintf(stderr,
                 " allocations=%llu bytes=%llu frees=%llu "
                 "allocation_ms=%.3f collection_ms=%.3f\n",
                 static_cast<unsigned long long>(allocations.allocations),
                 static_cast<unsigned long long>(allocations.bytes),
                 static_cast<unsigned long long>(allocations.frees),
                 static_cast<double>(allocations.allocation_ticks) * ms_per_tick,
                 static_cast<double>(allocations.collection_ticks) * ms_per_tick);
}

/** Start this thread's frame after preserving its completed pre-frame work once. */
inline void begin_frame() {
    static_cast<void>(tick_origin());
    SourceThreadRecords& records = source_thread_records();
    if (!records.frame_started) {
        report_records(0, true);
        records.frame_started = true;
    }
    for (SourceFunctionTotals& totals : records.functions)
        totals = {};
    allocation_totals = {};
}

/** Print this thread's current frame records. */
inline void report_frame(long frame) { report_records(frame, false); }

} // namespace bbl::profile

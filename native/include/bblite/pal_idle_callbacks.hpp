#pragma once

#include <bblite/js_data.hpp>
#include <bblite/pal_event_loop.hpp>

#include <cmath>
#include <cstdint>
#include <type_traits>
#include <utility>

namespace bbl::pal {

/** A JavaScript IdleDeadline: one object per callback invocation. */
using IdleDeadlineHandle = js::Ref<IdleDeadline>;

/** Web IDL `unsigned long`: truncation modulo 2^32, NaN and infinities as 0. */
[[nodiscard]] inline std::uint32_t idle_unsigned_long(double value) {
    if (!std::isfinite(value))
        return 0;
    double converted = std::fmod(std::trunc(value), 4294967296.0);
    if (converted < 0)
        converted += 4294967296.0;
    return static_cast<std::uint32_t>(converted);
}

/**
 * `requestIdleCallback(callback, { timeout })` on the realm's event loop. The callback takes
 * the IdleDeadline or, as a source callback declaring no parameter, nothing.
 */
template <typename Callback> double request_idle_callback(Callback callback, double timeout) {
    EventLoop::IdleCallback invoke;
    if constexpr (std::is_invocable_v<Callback&, IdleDeadlineHandle>)
        invoke = [callback = std::move(callback)](const IdleDeadline& deadline) mutable {
            callback(js::make_ref<IdleDeadline>(deadline));
        };
    else {
        static_assert(std::is_invocable_v<Callback&>,
                      "An idle callback takes an IdleDeadline or no argument.");
        invoke = [callback = std::move(callback)](const IdleDeadline&) mutable { callback(); };
    }
    return static_cast<double>(
        EventLoop::current().request_idle_callback(std::move(invoke), idle_unsigned_long(timeout)));
}

inline void cancel_idle_callback(double handle) {
    EventLoop::current().cancel_idle_callback(idle_unsigned_long(handle));
}

} // namespace bbl::pal

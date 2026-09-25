#pragma once

#include <exception>
#include <string>
#include <string_view>

#include <bblite/uncaught_error.hpp>

namespace bbl {

inline constexpr std::string_view native_error_prefix = "Babylon Lite native error: ";

/**
 * Ends the process over a failure met where no exception may propagate -- a
 * destructor, a noexcept release path, a coroutine's final suspend. An
 * escaping exception would terminate the same process silently; this names
 * the site and the cause on stderr first, through the reporting boundary's
 * own non-throwing write.
 */
[[noreturn]] inline void terminate_after(const char* site, const char* reason) noexcept {
    const std::string prefix = std::string(native_error_prefix) + site + ": ";
    detail::write_error_line(prefix, reason);
    std::terminate();
}

/**
 * Runs one teardown step that must not throw. A step that throws anyway is a
 * broken ownership invariant, reported by `terminate_after` with the thrown
 * value's report text (`exception_message`).
 */
template <typename Step> void run_teardown(const char* site, Step&& step) noexcept {
    try {
        static_cast<Step&&>(step)();
    } catch (...) {
        terminate_after(site, exception_message(std::current_exception()).c_str());
    }
}

} // namespace bbl

#pragma once

#include <cstdio>
#include <exception>

namespace bbl {

/**
 * Ends the process over a failure met where no exception may propagate -- a
 * destructor, a noexcept release path, a coroutine's final suspend. An
 * escaping exception would terminate the same process silently; this names
 * the site and the cause on stderr first.
 */
[[noreturn]] inline void terminate_after(const char* site, const char* reason) noexcept {
    std::fprintf(stderr, "Babylon Lite native error: %s: %s\n", site, reason);
    std::terminate();
}

/**
 * Runs one teardown step that must not throw. A step that throws anyway is a
 * broken ownership invariant, reported by `terminate_after`.
 */
template <typename Step> void run_teardown(const char* site, Step&& step) noexcept {
    try {
        static_cast<Step&&>(step)();
    } catch (const std::exception& error) {
        terminate_after(site, error.what());
    } catch (...) {
        terminate_after(site, "unknown exception");
    }
}

} // namespace bbl

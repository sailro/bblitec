#pragma once

#include <cstring>
#include <exception>
#include <iostream>
#include <string>
#include <string_view>

namespace bbl {

inline constexpr std::string_view uncaught_error_prefix = "Uncaught application error: ";
inline constexpr const char* unknown_exception_message = "Unknown native exception";

/** A native exception's report text: its `what()`, or a fixed text for any other thrown value. */
[[nodiscard]] inline std::string exception_message(const std::exception_ptr& error) {
    try {
        std::rethrow_exception(error);
    } catch (const std::exception& problem) {
        return problem.what();
    } catch (...) {
        return unknown_exception_message;
    }
}

/** The body of a source `catch` that ignores its exception, as JavaScript discards it. */
inline void discard_exception() noexcept {}

namespace detail {
/**
 * Writes one line through std::cerr's buffer, which a platform entry may
 * redirect (Android's log). The stream layer is bypassed so the write
 * cannot throw from a reporting boundary.
 */
inline void write_error_line(std::string_view prefix, const char* message) noexcept {
    auto* output = std::cerr.rdbuf();
    if (!output)
        return;
    output->sputn(prefix.data(), static_cast<std::streamsize>(prefix.size()));
    output->sputn(message, static_cast<std::streamsize>(std::strlen(message)));
    output->sputc('\n');
    output->pubsync();
}
} // namespace detail

/**
 * Reports an exception that escaped an application entry -- generated `main`,
 * the Window application, a platform entry -- with the realm reporter's
 * wording, and returns the process's failure status.
 */
[[nodiscard]] inline int report_uncaught_error(const std::exception_ptr& error) noexcept {
    try {
        std::rethrow_exception(error);
    } catch (const std::exception& problem) {
        detail::write_error_line(uncaught_error_prefix, problem.what());
    } catch (...) {
        detail::write_error_line(uncaught_error_prefix, unknown_exception_message);
    }
    return 1;
}

} // namespace bbl

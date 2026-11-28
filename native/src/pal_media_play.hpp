#pragma once

#include <bblite/js_error.hpp>
#include <bblite/js_promise.hpp>

#include <exception>
#include <string>
#include <string_view>
#include <vector>

namespace bbl::pal {

/** A DOMException a media element's play() promise rejects with, created anew for each promise. */
struct MediaPlayRejection {
    std::string_view message;
    std::string_view name;
    [[nodiscard]] std::exception_ptr error() const {
        return js::dom_exception_error(std::string(message), std::string(name));
    }
};

/** play() of an element none of whose sources is supported. */
inline constexpr MediaPlayRejection media_no_supported_sources{
    "The element has no supported sources.", "NotSupportedError"};
/** A pending play() that pause() interrupts. */
inline constexpr MediaPlayRejection media_play_paused{
    "The play() request was interrupted by a call to pause().", "AbortError"};
/** A pending play() that load() interrupts. */
inline constexpr MediaPlayRejection media_play_reloaded{
    "The play() request was interrupted by a new load request.", "AbortError"};

/** HTML's "reject pending play promises". */
inline void reject_media_plays(std::vector<js::Promise<js::PromiseVoid>> plays,
                               MediaPlayRejection rejection) {
    for (const auto& play : plays)
        play.reject(rejection.error());
}

} // namespace bbl::pal

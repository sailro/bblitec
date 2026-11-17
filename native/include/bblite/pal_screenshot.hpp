#pragma once

// `captureScreenshot` (src/engine/screenshot.ts, screenshot-readback.ts): the
// primary surface's capture queue, the frame that services it, and the
// settlement every queued request shares. The copy into the frame's command
// buffer and the map after its submit are each backend's; the stride and the
// unpack are lowered from the pin (`upstream/src/screenshot_readback.cpp`).

#include <bblite/js_data.hpp>
#include <bblite/js_promise.hpp>
#include <bblite/pal_projection.hpp>
#include <bblite/runtime.hpp>

#include <any>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <memory>
#include <optional>
#include <span>
#include <stdexcept>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

namespace bbl::upstream {
/** `alignBytesPerRow`: the 256-byte multiple a `width`-pixel copy row takes. */
std::uint32_t screenshot_bytes_per_row(double width);
/** `finish`'s unpack: tightly packed RGBA8, top row first, alpha 255. */
js::U8CArray unpack_screenshot(std::span<const std::uint8_t> src, double width, double height,
                               double bytes_per_row, bool bgra);
} // namespace bbl::upstream

namespace bbl::pal {

/** A `Screenshot` as the pin builds it, and the program's record of it once read. */
struct Screenshot {
    double width = 0;
    double height = 0;
    js::U8CArray data;
    std::any projection;
};

using ScreenshotRequest = js::Promise<std::shared_ptr<Screenshot>>;

/** `surface._captureQueue`: the requests the next serviced frame settles together. */
struct ScreenshotCaptures {
    std::vector<ScreenshotRequest> queue;
};

inline ScreenshotCaptures& screenshot_captures(Engine& engine) {
    if (!engine.screenshot_captures)
        engine.screenshot_captures = std::make_shared<ScreenshotCaptures>();
    return *engine.screenshot_captures;
}

/** `captureScreenshot(engine)`: a request the next rendered frame settles. */
inline ScreenshotRequest capture_screenshot(Engine& engine) {
    ScreenshotRequest request;
    screenshot_captures(engine).queue.push_back(request);
    return request;
}

/** `service`'s take: the requests this frame's copy settles, leaving the queue empty. */
inline std::vector<ScreenshotRequest> take_screenshot_requests(Engine& engine) {
    if (!engine.screenshot_captures)
        return {};
    return std::exchange(engine.screenshot_captures->queue, {});
}

/** `service` with no swapchain texture: every request it took rejects. */
inline void reject_screenshot_requests(const std::vector<ScreenshotRequest>& requests,
                                       std::exception_ptr error) {
    for (const ScreenshotRequest& request : requests)
        request.reject(error);
}

/** A frame's copy of its presented texture, mapped after the submit that filled it. */
struct ScreenshotReadback {
    std::span<const std::uint8_t> bytes;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint32_t bytes_per_row = 0;
    bool bgra = false;
};

/** `finish`: one unpacked image, resolving every request the frame took. */
inline void settle_screenshot_requests(const std::vector<ScreenshotRequest>& requests,
                                       const ScreenshotReadback& readback) {
    auto shot = std::make_shared<Screenshot>();
    shot->width = readback.width;
    shot->height = readback.height;
    shot->data = upstream::unpack_screenshot(readback.bytes, readback.width, readback.height,
                                             readback.bytes_per_row, readback.bgra);
    for (const ScreenshotRequest& request : requests)
        request.resolve(shot);
}

/** The program's record of a settled screenshot, the same object for every request. */
template <typename Result, typename Project>
Result project_screenshot(const std::shared_ptr<Screenshot>& shot, Project&& project) {
    if (!shot)
        throw std::logic_error("A settled screenshot is missing.");
    return project_once<Result>(shot->projection,
                                [&] { return std::forward<Project>(project)(*shot); });
}

/** The pin's rejection when the frame has no swapchain texture to copy. */
inline std::exception_ptr missing_screenshot_texture() {
    return std::make_exception_ptr(
        std::runtime_error("captureScreenshot: no swapchain texture available"));
}

/** A presented image the pin's unpack cannot read: not 8-bit RGBA or BGRA. */
inline std::exception_ptr unreadable_screenshot_format() {
    return std::make_exception_ptr(
        std::runtime_error("captureScreenshot reads an 8-bit RGBA or BGRA presented image."));
}

/**
 * Whether a presented image of WebGPU format `format` is BGRA, the pin's
 * `surface.format.startsWith("bgra")`; none for one the unpack cannot read.
 */
inline std::optional<bool> screenshot_bgra(std::string_view format) {
    const bool bgra = format.starts_with("bgra");
    if (!format.starts_with(bgra ? "bgra8unorm" : "rgba8unorm"))
        return std::nullopt;
    return bgra;
}

/** One frame's copy for the requests it settles: the backend's `Capture`, with `bytes_per_row`. */
template <typename Capture> struct ScreenshotCopy {
    std::vector<ScreenshotRequest> requests;
    std::optional<Capture> capture;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    bool bgra = false;
};

/**
 * `service`: takes the queued requests and has `record(bytes_per_row)` copy the frame's
 * presented `texture`, of the WebGPU format `format_name()` names, at the pin's row stride.
 * Without a texture, or with one the unpack cannot read, every request rejects.
 */
template <typename Texture, typename FormatName, typename Record>
auto record_screenshot(Engine& engine, Texture texture, FormatName&& format_name,
                       std::uint32_t width, std::uint32_t height, Record&& record)
    -> ScreenshotCopy<std::invoke_result_t<Record&, std::uint32_t>> {
    ScreenshotCopy<std::invoke_result_t<Record&, std::uint32_t>> copy;
    copy.requests = take_screenshot_requests(engine);
    if (copy.requests.empty())
        return copy;
    const std::optional<bool> bgra =
        texture ? screenshot_bgra(std::forward<FormatName>(format_name)()) : std::nullopt;
    if (!bgra) {
        reject_screenshot_requests(copy.requests, texture ? unreadable_screenshot_format()
                                                          : missing_screenshot_texture());
        copy.requests.clear();
        return copy;
    }
    copy.width = width;
    copy.height = height;
    copy.bgra = *bgra;
    copy.capture = record(upstream::screenshot_bytes_per_row(width));
    return copy;
}

/**
 * `finish`, after the frame's submit: `map(capture, size)` maps the copy's `size` bytes,
 * whose `bytes()` the settlement unpacks; a failure rejects every request.
 */
template <typename Capture, typename Map>
void finish_screenshot(const ScreenshotCopy<Capture>& copy, Map&& map) {
    if (!copy.capture)
        return;
    try {
        const std::uint32_t bytes_per_row = copy.capture->bytes_per_row;
        const auto mapped =
            map(*copy.capture, static_cast<std::size_t>(bytes_per_row) * copy.height);
        settle_screenshot_requests(
            copy.requests, {mapped.bytes(), copy.width, copy.height, bytes_per_row, copy.bgra});
    } catch (...) {
        reject_screenshot_requests(copy.requests, std::current_exception());
    }
}

} // namespace bbl::pal

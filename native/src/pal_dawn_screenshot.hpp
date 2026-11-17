#pragma once

// `captureScreenshot`'s readback on Dawn: `service` records the copy of the
// frame's presented texture into the frame's encoder, and `finish` maps it
// after that encoder's submit (`pal_screenshot.hpp`).

#include <bblite/pal_screenshot.hpp>
#include <bblite/runtime.hpp>

#include <cstddef>
#include <cstdint>
#include <exception>
#include <optional>
#include <vector>

#include <webgpu/webgpu.h>

#include "pal_dawn_shared.hpp"

namespace bbl::pal {

/** Whether a presented image of `format` is BGRA (`surface.format.startsWith("bgra")`); none for one not 8-bit. */
inline std::optional<bool> dawn_screenshot_bgra(WGPUTextureFormat format) {
    if (format == WGPUTextureFormat_BGRA8Unorm || format == WGPUTextureFormat_BGRA8UnormSrgb)
        return true;
    if (format == WGPUTextureFormat_RGBA8Unorm || format == WGPUTextureFormat_RGBA8UnormSrgb)
        return false;
    return std::nullopt;
}

/** One frame's copy for the requests it settles. */
struct DawnScreenshotCopy {
    std::vector<ScreenshotRequest> requests;
    std::optional<DawnSurfaceCapture> capture;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    bool bgra = false;
};

/**
 * `service`: takes the queued requests and records the copy of `texture`, the
 * frame's presented image of `format`, into `encoder`. Without one, every
 * request rejects.
 */
inline DawnScreenshotCopy record_dawn_screenshot(Engine& engine, WGPUDevice device,
                                                 WGPUCommandEncoder encoder, WGPUTexture texture,
                                                 WGPUTextureFormat format, std::uint32_t width,
                                                 std::uint32_t height) {
    DawnScreenshotCopy copy;
    copy.requests = take_screenshot_requests(engine);
    if (copy.requests.empty())
        return copy;
    const std::optional<bool> bgra = dawn_screenshot_bgra(format);
    if (!texture || !bgra) {
        reject_screenshot_requests(copy.requests, texture ? unreadable_screenshot_format()
                                                          : missing_screenshot_texture());
        copy.requests.clear();
        return copy;
    }
    copy.width = width;
    copy.height = height;
    copy.bgra = *bgra;
    copy.capture = record_dawn_texture_copy(device, encoder, texture, width, height,
                                            upstream::screenshot_bytes_per_row(width));
    return copy;
}

/** `finish`, after the frame's submit: maps the copy and settles every request. */
inline void finish_dawn_screenshot(DawnDevice& state, const DawnScreenshotCopy& copy) {
    if (!copy.capture)
        return;
    try {
        const std::uint32_t bytes_per_row = copy.capture->bytes_per_row;
        const DawnReadbackMap mapped(state, copy.capture->readback,
                                     static_cast<std::size_t>(bytes_per_row) * copy.height);
        settle_screenshot_requests(
            copy.requests, {mapped.bytes(), copy.width, copy.height, bytes_per_row, copy.bgra});
    } catch (...) {
        reject_screenshot_requests(copy.requests, std::current_exception());
    }
}

} // namespace bbl::pal

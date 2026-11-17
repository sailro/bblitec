#pragma once

// `captureScreenshot`'s readback on Dawn: `service` records the copy of the
// frame's presented texture into the frame's encoder, and `finish` maps it
// after that encoder's submit (`pal_screenshot.hpp`).

#include <bblite/pal_screenshot.hpp>
#include <bblite/runtime.hpp>

#include <cstddef>
#include <cstdint>

#include <webgpu/webgpu.h>

#include "pal_dawn_shared.hpp"

namespace bbl::pal {

/** One frame's copy for the requests it settles. */
using DawnScreenshotCopy = ScreenshotCopy<DawnSurfaceCapture>;

/** `service`: the copy of `texture`, the frame's presented image of `format`, into `encoder`. */
inline DawnScreenshotCopy record_dawn_screenshot(Engine& engine, WGPUDevice device,
                                                 WGPUCommandEncoder encoder, WGPUTexture texture,
                                                 WGPUTextureFormat format, std::uint32_t width,
                                                 std::uint32_t height) {
    return record_screenshot(
        engine, texture, [format] { return dawn_webgpu_format_name(format); }, width, height,
        [&](std::uint32_t bytes_per_row) {
            return record_dawn_texture_copy(device, encoder, texture, width, height, bytes_per_row);
        });
}

/** `finish`, after the frame's submit: maps the copy and settles every request. */
inline void finish_dawn_screenshot(DawnDevice& state, const DawnScreenshotCopy& copy) {
    finish_screenshot(copy, [&state](const DawnSurfaceCapture& capture, std::size_t size) {
        return DawnReadbackMap(state, capture.readback, size);
    });
}

} // namespace bbl::pal

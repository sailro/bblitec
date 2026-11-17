#pragma once

// `captureScreenshot`'s readback on SDL_GPU: `service` records the copy of the
// frame's presented texture into the frame's command buffer, and `finish`
// maps it once that buffer's work has completed (`pal_screenshot.hpp`).

#include <bblite/pal_screenshot.hpp>
#include <bblite/runtime.hpp>

#include <cstddef>
#include <cstdint>

#include <SDL3/SDL_gpu.h>

#include "pal_sdl_gpu_completion.hpp"
#include "pal_sdl_gpu_shared.hpp"

namespace bbl::pal {

/** One frame's copy for the requests it settles. */
using SdlScreenshotCopy = ScreenshotCopy<SdlTextureDownload>;

/** `service`: the copy of `texture`, the frame's presented image of `format`, into `command`. */
inline SdlScreenshotCopy record_sdl_screenshot(Engine& engine, SDL_GPUDevice* device,
                                               SDL_GPUCommandBuffer* command,
                                               SDL_GPUTexture* texture, SDL_GPUTextureFormat format,
                                               std::uint32_t width, std::uint32_t height) {
    return record_screenshot(
        engine, texture, [format] { return sdl_webgpu_format_name(format); }, width, height,
        [&](std::uint32_t bytes_per_row) {
            return record_sdl_texture_download(device, command, texture, width, height, 4,
                                               bytes_per_row);
        });
}

/** `finish`, after the frame's submit: maps the copy once the work submitted before it is done. */
inline void finish_sdl_screenshot(SDL_GPUDevice* device, const SdlScreenshotCopy& copy) {
    finish_screenshot(copy, [device](const SdlTextureDownload& download, std::size_t size) {
        const OwnedSdlFence submitted{submit_sdl_queue_fence(device), {device}};
        return SdlReadbackMap(device, submitted.get(), download.transfer.get(), size);
    });
}

} // namespace bbl::pal

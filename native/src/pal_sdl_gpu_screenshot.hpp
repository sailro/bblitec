#pragma once

// `captureScreenshot`'s readback on SDL_GPU: `service` records the copy of the
// frame's presented texture into the frame's command buffer, and `finish`
// maps it once that buffer's work has completed (`pal_screenshot.hpp`).

#include <bblite/pal_screenshot.hpp>
#include <bblite/runtime.hpp>

#include <cstddef>
#include <cstdint>
#include <exception>
#include <optional>
#include <span>
#include <stdexcept>
#include <vector>

#include <SDL3/SDL.h>
#include <SDL3/SDL_gpu.h>

#include "pal_sdl_gpu_shared.hpp"

namespace bbl::pal {

/** Whether a presented image of `format` is BGRA (`surface.format.startsWith("bgra")`); none for one not 8-bit. */
inline std::optional<bool> sdl_screenshot_bgra(SDL_GPUTextureFormat format) {
    if (format == SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM ||
        format == SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM_SRGB)
        return true;
    if (format == SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM ||
        format == SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM_SRGB)
        return false;
    return std::nullopt;
}

/** Once the submitted copy has completed, hands `read` its mapped rows, then unmaps them. */
template <typename Read>
void read_sdl_texture_download(SDL_GPUDevice* device, const SdlTextureDownload& download,
                               std::uint32_t height, Read&& read) {
    if (!SDL_WaitForGPUIdle(device))
        gpu_error("SDL_WaitForGPUIdle readback");
    SDL_GPUTransferBuffer* transfer = download.transfer.get();
    const auto* mapped =
        static_cast<const std::uint8_t*>(SDL_MapGPUTransferBuffer(device, transfer, false));
    if (!mapped)
        gpu_error("SDL_MapGPUTransferBuffer readback");
    const auto unmap = js::finally([&] { SDL_UnmapGPUTransferBuffer(device, transfer); });
    read(std::span(mapped, static_cast<std::size_t>(download.bytes_per_row) * height));
}

/** One frame's copy for the requests it settles. */
struct SdlScreenshotCopy {
    std::vector<ScreenshotRequest> requests;
    std::optional<SdlTextureDownload> download;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    bool bgra = false;
};

/**
 * `service`: takes the queued requests and records the copy of `texture`, the
 * frame's presented image, into `command`. Without one, every request rejects.
 */
inline SdlScreenshotCopy record_sdl_screenshot(Engine& engine, SDL_GPUDevice* device,
                                               SDL_GPUCommandBuffer* command,
                                               SDL_GPUTexture* texture, SDL_GPUTextureFormat format,
                                               std::uint32_t width, std::uint32_t height) {
    SdlScreenshotCopy copy;
    copy.requests = take_screenshot_requests(engine);
    if (copy.requests.empty())
        return copy;
    const std::optional<bool> bgra = sdl_screenshot_bgra(format);
    if (!texture || !bgra) {
        reject_screenshot_requests(copy.requests, texture ? unreadable_screenshot_format()
                                                          : missing_screenshot_texture());
        copy.requests.clear();
        return copy;
    }
    copy.width = width;
    copy.height = height;
    copy.bgra = *bgra;
    copy.download = record_sdl_texture_download(device, command, texture, width, height, 4,
                                                upstream::screenshot_bytes_per_row(width));
    return copy;
}

/** `finish`, after the frame's submit: maps the copy and settles every request. */
inline void finish_sdl_screenshot(SDL_GPUDevice* device, const SdlScreenshotCopy& copy) {
    if (!copy.download)
        return;
    try {
        read_sdl_texture_download(
            device, *copy.download, copy.height, [&](std::span<const std::uint8_t> bytes) {
                settle_screenshot_requests(
                    copy.requests,
                    {bytes, copy.width, copy.height, copy.download->bytes_per_row, copy.bgra});
            });
    } catch (...) {
        reject_screenshot_requests(copy.requests, std::current_exception());
    }
}

} // namespace bbl::pal

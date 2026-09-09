#pragma once

#include "pal_window.hpp"
#include <SDL3/SDL_gpu.h>
#include <utility>

namespace bbl::pal {

struct SdlGpuDevice {
    SdlGpuDevice() = default;
    SdlGpuDevice(const SdlGpuDevice&) = delete;
    SdlGpuDevice& operator=(const SdlGpuDevice&) = delete;
    ~SdlGpuDevice() { release(); }

    void release() noexcept {
        if (std::exchange(window_claimed, false)) SDL_ReleaseWindowFromGPUDevice(device, window);
        if (auto* value = std::exchange(device, nullptr); value && owns_device) SDL_DestroyGPUDevice(value);
        if (auto* value = std::exchange(window, nullptr)) release_run_window(value);
        if (std::exchange(sdl_initialized, false)) quit_run_sdl();
    }

    SDL_Window* window = nullptr;
    SDL_GPUDevice* device = nullptr;
    SDL_GPUTextureFormat swapchain_format = SDL_GPU_TEXTUREFORMAT_INVALID;
    bool window_claimed = false;
    bool owns_device = true;
    bool sdl_initialized = false;
};

} // namespace bbl::pal

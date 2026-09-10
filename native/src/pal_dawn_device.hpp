#pragma once

#include "pal_window.hpp"
#include <webgpu/webgpu.h>
#include <atomic>
#include <string>
#include <utility>

namespace bbl::pal {

// Callback userdata points into this object, so its address must remain stable.
struct DawnDevice {
    DawnDevice() = default;
    DawnDevice(const DawnDevice&) = delete;
    DawnDevice& operator=(const DawnDevice&) = delete;
    ~DawnDevice() { release(); }

    void release() noexcept {
        if (auto value = std::exchange(surface, nullptr)) wgpuSurfaceRelease(value);
        if (auto value = std::exchange(queue, nullptr)) wgpuQueueRelease(value);
        if (auto value = std::exchange(device, nullptr)) wgpuDeviceRelease(value);
        if (auto value = std::exchange(adapter, nullptr)) wgpuAdapterRelease(value);
        if (auto value = std::exchange(instance, nullptr)) wgpuInstanceRelease(value);
        if (auto* value = std::exchange(window, nullptr); value && owns_window) release_run_window(value);
        if (std::exchange(sdl_initialized, false)) quit_run_sdl();
    }

    SDL_Window* window = nullptr;
    WGPUInstance instance = nullptr;
    WGPUAdapter adapter = nullptr;
    WGPUDevice device = nullptr;
    WGPUQueue queue = nullptr;
    WGPUSurface surface = nullptr;
    WGPUTextureFormat surface_format = WGPUTextureFormat_BGRA8Unorm;
    WGPUPresentMode present_mode = WGPUPresentMode_Fifo;
    std::uint32_t surface_width = 0;
    std::uint32_t surface_height = 0;
    std::string uncaptured_error;
    std::atomic_bool device_lost = false;
    bool owns_window = true;
    bool sdl_initialized = false;
};

} // namespace bbl::pal

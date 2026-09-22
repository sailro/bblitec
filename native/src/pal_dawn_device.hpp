#pragma once

#include "pal_window.hpp"
#include <webgpu/webgpu.h>
#include <atomic>
#include <string>
#include <utility>
#if defined(__APPLE__)
#include <SDL3/SDL_metal.h>
#elif defined(__ANDROID__)
#include <android/native_window.h>
#endif

namespace bbl::pal {

// Callback userdata points into this object, so its address must remain stable.
struct DawnDevice {
    DawnDevice() = default;
    DawnDevice(const DawnDevice&) = delete;
    DawnDevice& operator=(const DawnDevice&) = delete;
    ~DawnDevice() { release(); }

    void release_surface() noexcept {
        if (auto value = std::exchange(surface, nullptr))
            wgpuSurfaceRelease(value);
#if defined(__ANDROID__)
        if (auto* value = std::exchange(android_window, nullptr))
            ANativeWindow_release(value);
#endif
    }

    void destroy_device() noexcept {
        // Release the surface while its device can still retire swapchains,
        // including the recycled swapchain Dawn retains after unconfigure.
        release_surface();
        if (device)
            wgpuDeviceDestroy(device);
    }

    void release() noexcept {
        release_surface();
        if (auto value = std::exchange(queue, nullptr))
            wgpuQueueRelease(value);
        if (auto value = std::exchange(device, nullptr))
            wgpuDeviceRelease(value);
        if (auto value = std::exchange(adapter, nullptr))
            wgpuAdapterRelease(value);
        if (auto value = std::exchange(instance, nullptr))
            wgpuInstanceRelease(value);
#if defined(__APPLE__)
        if (auto value = std::exchange(metal_view, nullptr))
            SDL_Metal_DestroyView(value);
#endif
        if (auto* value = std::exchange(window, nullptr); value && owns_window)
            release_run_window(value);
        if (std::exchange(sdl_initialized, false))
            quit_run_sdl();
    }

    SDL_Window* window = nullptr;
#if defined(__APPLE__)
    SDL_MetalView metal_view = nullptr;
#elif defined(__ANDROID__)
    ANativeWindow* android_window = nullptr;
    bool surface_recovery_pending = false;
#endif
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

#define SDL_DestroyGPUDevice test_DestroyGPUDevice
#define SDL_ReleaseWindowFromGPUDevice test_ReleaseWindowFromGPUDevice
#include "pal_sdl_gpu_device.hpp"
#include "pal_dawn_device.hpp"
#include <cassert>
#include <type_traits>
#include <vector>

static std::vector<int> device_release_events;
void SDL_DestroyGPUDevice(SDL_GPUDevice*) { device_release_events.push_back(1); }
void SDL_ReleaseWindowFromGPUDevice(SDL_GPUDevice*, SDL_Window*) {
    device_release_events.push_back(2);
}
void wgpuInstanceRelease(WGPUInstance) { device_release_events.push_back(3); }
void wgpuAdapterRelease(WGPUAdapter) { device_release_events.push_back(4); }
void wgpuDeviceRelease(WGPUDevice) { device_release_events.push_back(5); }
void wgpuQueueRelease(WGPUQueue) { device_release_events.push_back(6); }
void wgpuSurfaceRelease(WGPUSurface) { device_release_events.push_back(7); }
void wgpuDeviceDestroy(WGPUDevice) { device_release_events.push_back(8); }

namespace bbl::pal {
std::string environment_variable(const char*) { return {}; }
} // namespace bbl::pal

template <typename T> T fake() { return reinterpret_cast<T>(std::uintptr_t{1}); }

int main() {
    using namespace bbl::pal;
    static_assert(!std::is_copy_constructible_v<SdlGpuDevice> &&
                  !std::is_move_constructible_v<SdlGpuDevice>);
    static_assert(!std::is_copy_constructible_v<DawnDevice> &&
                  !std::is_move_constructible_v<DawnDevice>);
    for (int stage = 0; stage <= 5; ++stage) {
        device_release_events.clear();
        try {
            DawnDevice device;
            if (stage >= 1)
                device.instance = fake<WGPUInstance>();
            if (stage >= 2)
                device.adapter = fake<WGPUAdapter>();
            if (stage >= 3)
                device.device = fake<WGPUDevice>();
            if (stage >= 4)
                device.queue = fake<WGPUQueue>();
            if (stage >= 5)
                device.surface = fake<WGPUSurface>();
            if (stage % 2)
                device.release();
            throw std::runtime_error("construction interrupted");
        } catch (const std::runtime_error&) {
        }
        assert(device_release_events.size() == static_cast<std::size_t>(stage));
        for (int i = 0; i < stage; ++i)
            assert(device_release_events[i] == 2 + stage - i);
    }
    device_release_events.clear();
    {
        DawnDevice device;
        device.destroy_device();
        assert(device_release_events.empty());
        device.device = fake<WGPUDevice>();
        device.surface = fake<WGPUSurface>();
        device.destroy_device();
        assert(!device.surface);
        assert((device_release_events == std::vector<int>{7, 8}));
    }
    assert((device_release_events == std::vector<int>{7, 8, 5}));
    bbl::EngineOptions options;
    options.width = options.height = 16;
    for (bool claimed : {false, true}) {
        device_release_events.clear();
        {
            SdlGpuDevice device;
            assert(initialize_run_sdl(SDL_INIT_VIDEO));
            device.sdl_initialized = true;
            device.window = acquire_run_window(options, SDL_WINDOW_HIDDEN);
            assert(device.window);
            device.device = fake<SDL_GPUDevice*>();
            device.window_claimed = claimed;
            device.release();
        }
        assert(device_release_events == (claimed ? std::vector<int>{2, 1} : std::vector<int>{1}));
        assert(SDL_WasInit(SDL_INIT_VIDEO) == 0);
    }
    device_release_events.clear();
    {
        SdlGpuDevice borrowed;
        borrowed.device = fake<SDL_GPUDevice*>();
        borrowed.owns_device = false;
    }
    assert(device_release_events.empty());
    {
        SdlWindowRun run;
        assert(initialize_run_sdl(SDL_INIT_VIDEO));
        auto* host = acquire_run_window(options, SDL_WINDOW_HIDDEN);
        const auto id = SDL_GetWindowID(host);
        {
            DawnDevice borrowed;
            borrowed.window = host;
            borrowed.owns_window = false;
        }
        assert(SDL_GetWindowFromID(id) == host);
        {
            SdlGpuDevice renderer;
            renderer.window = host;
            renderer.sdl_initialized = true;
        }
        assert(SDL_GetWindowFromID(id) == host);
        assert(SDL_WasInit(SDL_INIT_VIDEO) != 0);
    }
    assert(SDL_WasInit(SDL_INIT_VIDEO) == 0);
    std::cout << "device-owner-check: ok\n";
}

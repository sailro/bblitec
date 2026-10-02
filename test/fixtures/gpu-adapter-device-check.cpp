#if defined(ADAPTER_SDL)
#include "pal_sdl_gpu_adapter.hpp"
#include <SDL3/SDL.h>
#else
#include "pal_dawn_adapter.hpp"
#endif

#include <cassert>
#include <memory>
#include <stdexcept>

namespace {
struct SelectedDevice {
    bbl::pal::GpuAdapterInfo info;
#if defined(ADAPTER_SDL)
    SDL_GPUDevice* device = nullptr;
    SelectedDevice() {
        assert(SDL_Init(SDL_INIT_VIDEO));
        device = SDL_CreateGPUDevice(SDL_GPU_SHADERFORMAT_DXIL, false, "direct3d12");
        if (!device)
            throw std::runtime_error(SDL_GetError());
        info = bbl::pal::sdl_gpu_adapter_info(device);
        const auto properties = SDL_GetGPUDeviceProperties(device);
        const auto vendor = SDL_GetNumberProperty(properties, "bblite.gpu.adapter.vendor_id", 0);
        assert(vendor > 0 &&
               info.vendor == bbl::pal::gpu_adapter_vendor(static_cast<std::uint32_t>(vendor)));
        assert(info.description ==
               SDL_GetStringProperty(properties, SDL_PROP_GPU_DEVICE_NAME_STRING, ""));
        assert(info.architecture.empty());
    }
    ~SelectedDevice() {
        SDL_DestroyGPUDevice(device);
        SDL_Quit();
    }
#else
    WGPUInstance instance = nullptr;
    WGPUAdapter adapter = nullptr;
    WGPUDevice device = nullptr;
    void wait(WGPUFuture future) const {
        WGPUFutureWaitInfo completion = WGPU_FUTURE_WAIT_INFO_INIT;
        completion.future = future;
        assert(wgpuInstanceWaitAny(instance, 1, &completion, 30'000'000'000) ==
               WGPUWaitStatus_Success);
        assert(completion.completed);
    }
    SelectedDevice() {
        const WGPUInstanceFeatureName feature = WGPUInstanceFeatureName_TimedWaitAny;
        WGPUInstanceDescriptor descriptor = WGPU_INSTANCE_DESCRIPTOR_INIT;
        descriptor.requiredFeatureCount = 1;
        descriptor.requiredFeatures = &feature;
        instance = wgpuCreateInstance(&descriptor);
        assert(instance);
        WGPURequestAdapterOptions options = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
        options.powerPreference = WGPUPowerPreference_HighPerformance;
        options.backendType = WGPUBackendType_D3D12;
        WGPURequestAdapterCallbackInfo callback = WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
        callback.mode = WGPUCallbackMode_WaitAnyOnly;
        callback.userdata1 = this;
        callback.callback = [](WGPURequestAdapterStatus status, WGPUAdapter adapter, WGPUStringView,
                               void* data, void*) {
            assert(status == WGPURequestAdapterStatus_Success);
            static_cast<SelectedDevice*>(data)->adapter = adapter;
        };
        wait(wgpuInstanceRequestAdapter(instance, &options, callback));
        assert(adapter);
        WGPUDeviceDescriptor device_descriptor = WGPU_DEVICE_DESCRIPTOR_INIT;
        WGPURequestDeviceCallbackInfo device_callback = WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
        device_callback.mode = WGPUCallbackMode_WaitAnyOnly;
        device_callback.userdata1 = this;
        device_callback.callback = [](WGPURequestDeviceStatus status, WGPUDevice device,
                                      WGPUStringView, void* data, void*) {
            assert(status == WGPURequestDeviceStatus_Success);
            static_cast<SelectedDevice*>(data)->device = device;
        };
        wait(wgpuAdapterRequestDevice(adapter, &device_descriptor, device_callback));
        assert(device);
        info = bbl::pal::dawn_adapter_info(adapter);
        WGPUAdapterInfo actual = WGPU_ADAPTER_INFO_INIT;
        assert(wgpuAdapterGetInfo(adapter, &actual) == WGPUStatus_Success);
        assert(actual.vendorID > 0 && !info.vendor.empty());
        assert(info.vendor == std::string(actual.vendor.data, actual.vendor.length));
        assert(info.device == std::string(actual.device.data, actual.device.length));
        assert(info.architecture ==
               std::string(actual.architecture.data, actual.architecture.length));
        assert(info.description == std::string(actual.description.data, actual.description.length));
        wgpuAdapterInfoFreeMembers(actual);
    }
    ~SelectedDevice() {
        wgpuDeviceDestroy(device);
        wgpuDeviceRelease(device);
        wgpuAdapterRelease(adapter);
        wgpuInstanceRelease(instance);
    }
#endif
};
} // namespace

#define main generated_main
#include "program.hpp"
#undef main

namespace bbl::pal {
struct DeviceServices final : HostServices {
    const SelectedDevice graphics;
    const void* graphics_identity() const override { return &graphics; }
    std::optional<GpuAdapterInfo> graphics_adapter_info() const override { return graphics.info; }
};
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop, "", std::make_shared<DeviceServices>());
    loop.run([&] { initialize(realm); });
    return 0;
}
} // namespace bbl::pal
int main() { return generated_main(); }

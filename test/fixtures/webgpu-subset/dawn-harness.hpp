#pragma once

// A headless Dawn device for the WebGPU-subset fixtures, and the realm thread
// their checks run on over a `DawnWebGpuDevice`.

#include "fixture-require.hpp"
#include "pal_dawn_webgpu.hpp"

#include <bblite/js_realm_state.hpp>

#include <cstdio>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace webgpu_fixture {

struct DawnHarness {
    WGPUInstance instance = nullptr;
    WGPUAdapter adapter = nullptr;
    WGPUDevice device = nullptr;
    WGPUQueue queue = nullptr;
    std::mutex mutex;
    std::vector<std::string> errors;

    void wait(WGPUFuture future) const {
        WGPUFutureWaitInfo completion = WGPU_FUTURE_WAIT_INFO_INIT;
        completion.future = future;
        require(wgpuInstanceWaitAny(instance, 1, &completion, 30'000'000'000) ==
                    WGPUWaitStatus_Success,
                "Dawn wait");
    }
    explicit DawnHarness(const bbl::GpuSupportedLimits& required) {
        const WGPUInstanceFeatureName feature = WGPUInstanceFeatureName_TimedWaitAny;
        WGPUInstanceDescriptor descriptor = WGPU_INSTANCE_DESCRIPTOR_INIT;
        descriptor.requiredFeatureCount = 1;
        descriptor.requiredFeatures = &feature;
        instance = wgpuCreateInstance(&descriptor);
        require(instance != nullptr, "Dawn instance");
        WGPURequestAdapterOptions options = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
        options.powerPreference = WGPUPowerPreference_HighPerformance;
        options.backendType = WGPUBackendType_D3D12;
        WGPURequestAdapterCallbackInfo callback = WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
        callback.mode = WGPUCallbackMode_WaitAnyOnly;
        callback.userdata1 = this;
        callback.callback = [](WGPURequestAdapterStatus status, WGPUAdapter value, WGPUStringView,
                               void* data, void*) {
            if (status == WGPURequestAdapterStatus_Success)
                static_cast<DawnHarness*>(data)->adapter = value;
        };
        wait(wgpuInstanceRequestAdapter(instance, &options, callback));
        require(adapter != nullptr, "Dawn adapter");
        WGPULimits limits = WGPU_LIMITS_INIT;
        WGPUDeviceDescriptor device_descriptor = WGPU_DEVICE_DESCRIPTOR_INIT;
        if (bbl::pal::request_dawn_limits(limits, required))
            device_descriptor.requiredLimits = &limits;
        device_descriptor.uncapturedErrorCallbackInfo.userdata1 = this;
        device_descriptor.uncapturedErrorCallbackInfo.callback =
            [](WGPUDevice const*, WGPUErrorType, WGPUStringView message, void* data, void*) {
                auto* self = static_cast<DawnHarness*>(data);
                const std::lock_guard lock(self->mutex);
                self->errors.push_back(bbl::pal::view_text(message));
            };
        WGPURequestDeviceCallbackInfo device_callback = WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
        device_callback.mode = WGPUCallbackMode_WaitAnyOnly;
        device_callback.userdata1 = this;
        device_callback.callback = [](WGPURequestDeviceStatus status, WGPUDevice value,
                                      WGPUStringView, void* data, void*) {
            if (status == WGPURequestDeviceStatus_Success)
                static_cast<DawnHarness*>(data)->device = value;
        };
        wait(wgpuAdapterRequestDevice(adapter, &device_descriptor, device_callback));
        require(device != nullptr, "Dawn device");
        queue = wgpuDeviceGetQueue(device);
    }
    ~DawnHarness() {
        wgpuQueueRelease(queue);
        wgpuDeviceDestroy(device);
        wgpuDeviceRelease(device);
        wgpuAdapterRelease(adapter);
        wgpuInstanceRelease(instance);
    }
    void check_errors() {
        const std::lock_guard lock(mutex);
        for (const auto& error : errors)
            std::fprintf(stderr, "Dawn error: %s\n", error.c_str());
        require(errors.empty(), "Dawn reported validation errors");
    }
};

/**
 * Runs `checks(device, harness)` on its own realm thread (the library's realm
 * state ends with that thread, before the device does), then reports Dawn's
 * validation errors; prints `<label> ok` and returns 0 when all held.
 */
template <class Checks>
int run_dawn(const bbl::GpuSupportedLimits& limits, Checks checks, const char* label) {
    try {
        DawnHarness harness(limits);
        std::exception_ptr failure;
        std::thread([&] {
            try {
                const bbl::js::RealmScope realm;
                bbl::pal::EventLoop loop;
                loop.run([&] {
                    auto device = std::make_shared<bbl::pal::DawnWebGpuDevice>(
                        harness.instance, harness.device, harness.queue);
                    checks(device, harness)
                        .then([device, &loop](const bbl::js::PromiseVoid&) { loop.close(); },
                              [device, &loop, &failure](std::exception_ptr error) {
                                  failure = error;
                                  loop.close();
                              });
                });
            } catch (...) {
                failure = std::current_exception();
            }
        }).join();
        if (failure)
            std::rethrow_exception(failure);
        harness.check_errors();
        std::printf("%s ok\n", label);
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
}

} // namespace webgpu_fixture

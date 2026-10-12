// The splat-stream GPU work on a headless Dawn device through `DawnWebGpuDevice`.

#include "pal_dawn_webgpu.hpp"
#include "stream-checks.hpp"

#include <bblite/js_realm_state.hpp>

#include <mutex>

namespace {

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
        stream_check::require(wgpuInstanceWaitAny(instance, 1, &completion, 30'000'000'000) ==
                                  WGPUWaitStatus_Success,
                              "Dawn wait");
    }
    explicit DawnHarness(const bbl::GpuSupportedLimits& required) {
        const WGPUInstanceFeatureName feature = WGPUInstanceFeatureName_TimedWaitAny;
        WGPUInstanceDescriptor descriptor = WGPU_INSTANCE_DESCRIPTOR_INIT;
        descriptor.requiredFeatureCount = 1;
        descriptor.requiredFeatures = &feature;
        instance = wgpuCreateInstance(&descriptor);
        stream_check::require(instance != nullptr, "Dawn instance");
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
        stream_check::require(adapter != nullptr, "Dawn adapter");
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
        stream_check::require(device != nullptr, "Dawn device");
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
        stream_check::require(errors.empty(), "Dawn reported validation errors");
    }
};

bbl::js::Promise<bbl::js::PromiseVoid> run(bbl::GpuDevice& device,
                                           const stream_check::Shaders& shaders,
                                           const bbl::GpuSupportedLimits& limits) {
    stream_check::check_limits(device, limits);
    co_await stream_check::check_mapping(device);
    const auto pipelines = stream_check::create_pipelines(device, shaders);
    co_await stream_check::check_sort(device, pipelines, 70000, 69123, 0x13579bdfu);
    co_await stream_check::check_projection(device, pipelines);
    co_await stream_check::check_gather(device, pipelines);
    co_return bbl::js::PromiseVoid{};
}

} // namespace

int main(int argc, char** argv) {
    try {
        stream_check::require(argc == 2, "usage: dawn-check <shader directory>");
        const auto shaders = stream_check::read_shaders(argv[1]);
        const auto limits = bbl::gpu_required_limits(
            {{"maxBufferSize", 256640000}, {"maxStorageBufferBindingSize", 256640000}});
        DawnHarness harness(limits);
        std::exception_ptr failure;
        {
            const bbl::js::RealmScope realm;
            bbl::pal::EventLoop loop;
            loop.run([&] {
                auto device = std::make_shared<bbl::pal::DawnWebGpuDevice>(
                    harness.instance, harness.device, harness.queue);
                run(*device, shaders, limits)
                    .then([device, &loop](const bbl::js::PromiseVoid&) { loop.close(); },
                          [device, &loop, &failure](std::exception_ptr error) {
                              failure = error;
                              loop.close();
                          });
            });
        }
        if (failure)
            std::rethrow_exception(failure);
        harness.check_errors();
        std::printf("dawn ok\n");
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
}

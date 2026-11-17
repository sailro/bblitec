// `captureScreenshot`'s readback on a headless Dawn Direct3D 12 device: each
// 8-bit format's texture is written with the test's texels, copied and mapped
// by the backend's own halves (lifted into `lifted.hpp`), and unpacked by the
// lowered pin.

#include "check.hpp"

#include <webgpu/webgpu.h>

#include <cstring>
#include <exception>
#include <string>
#include <vector>

#include "pal_dawn_resources.hpp"

namespace bbl::pal {
/** The backend's device record, as far as a readback map reads it. */
struct DawnDevice {
    WGPUInstance instance = nullptr;
    std::string uncaptured_error;
};
[[noreturn]] inline void dawn_error(const std::string& message) {
    throw std::runtime_error("Dawn backend: " + message);
}
} // namespace bbl::pal

#include "lifted.hpp"
#include "cases.hpp"

using screenshot_check::require;

namespace {
WGPUStringView text(const char* value) { return WGPUStringView{value, std::strlen(value)}; }

struct Dawn {
    bbl::pal::DawnDevice state;
    WGPUAdapter adapter = nullptr;
    WGPUDevice device = nullptr;
    WGPUQueue queue = nullptr;
    std::vector<std::string> errors;

    Dawn() {
        const WGPUInstanceFeatureName feature = WGPUInstanceFeatureName_TimedWaitAny;
        WGPUInstanceDescriptor descriptor = WGPU_INSTANCE_DESCRIPTOR_INIT;
        descriptor.requiredFeatureCount = 1;
        descriptor.requiredFeatures = &feature;
        state.instance = wgpuCreateInstance(&descriptor);
        require(state.instance != nullptr, "wgpuCreateInstance");
        WGPURequestAdapterOptions options = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
        options.backendType = WGPUBackendType_D3D12;
        WGPURequestAdapterCallbackInfo adapter_callback = WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
        adapter_callback.mode = WGPUCallbackMode_WaitAnyOnly;
        adapter_callback.userdata1 = this;
        adapter_callback.callback = [](WGPURequestAdapterStatus status, WGPUAdapter value,
                                       WGPUStringView, void* data, void*) {
            if (status == WGPURequestAdapterStatus_Success)
                static_cast<Dawn*>(data)->adapter = value;
        };
        bbl::pal::wait_for(state.instance,
                           wgpuInstanceRequestAdapter(state.instance, &options, adapter_callback));
        require(adapter != nullptr, "wgpuInstanceRequestAdapter");
        WGPUDeviceDescriptor device_descriptor = WGPU_DEVICE_DESCRIPTOR_INIT;
        device_descriptor.uncapturedErrorCallbackInfo.userdata1 = this;
        device_descriptor.uncapturedErrorCallbackInfo.callback =
            [](WGPUDevice const*, WGPUErrorType, WGPUStringView message, void* data, void*) {
                static_cast<Dawn*>(data)->errors.emplace_back(message.data, message.length);
            };
        WGPURequestDeviceCallbackInfo device_callback = WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
        device_callback.mode = WGPUCallbackMode_WaitAnyOnly;
        device_callback.userdata1 = this;
        device_callback.callback = [](WGPURequestDeviceStatus status, WGPUDevice value,
                                      WGPUStringView, void* data, void*) {
            if (status == WGPURequestDeviceStatus_Success)
                static_cast<Dawn*>(data)->device = value;
        };
        bbl::pal::wait_for(state.instance,
                           wgpuAdapterRequestDevice(adapter, &device_descriptor, device_callback));
        require(device != nullptr, "wgpuAdapterRequestDevice");
        queue = wgpuDeviceGetQueue(device);
    }
    Dawn(const Dawn&) = delete;
    Dawn& operator=(const Dawn&) = delete;
    ~Dawn() {
        wgpuQueueRelease(queue);
        wgpuDeviceDestroy(device);
        wgpuDeviceRelease(device);
        wgpuAdapterRelease(adapter);
        wgpuInstanceRelease(state.instance);
    }
};
} // namespace

int main() {
    try {
        Dawn dawn;
        for (const auto& [label, format] :
             {std::pair{"rgba8unorm", WGPUTextureFormat_RGBA8Unorm},
              std::pair{"bgra8unorm", WGPUTextureFormat_BGRA8Unorm}}) {
            WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
            descriptor.label = text(label);
            descriptor.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc |
                               WGPUTextureUsage_CopyDst;
            descriptor.size = WGPUExtent3D{width, height, 1};
            descriptor.format = format;
            WGPUTexture texture = wgpuDeviceCreateTexture(dawn.device, &descriptor);
            require(texture != nullptr, "wgpuDeviceCreateTexture");
            WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
            destination.texture = texture;
            WGPUTexelCopyBufferLayout layout = WGPU_TEXEL_COPY_BUFFER_LAYOUT_INIT;
            layout.bytesPerRow = width * 4;
            layout.rowsPerImage = height;
            const WGPUExtent3D extent{width, height, 1};
            wgpuQueueWriteTexture(dawn.queue, &destination, texels, sizeof(texels), &layout,
                                  &extent);
            WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(dawn.device, nullptr);
            const bbl::pal::DawnSurfaceCapture capture =
                bbl::pal::record_dawn_texture_copy(dawn.device, encoder, texture, width, height,
                                                   bbl::upstream::screenshot_bytes_per_row(width));
            WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, nullptr);
            wgpuQueueSubmit(dawn.queue, 1, &commands);
            wgpuCommandBufferRelease(commands);
            wgpuCommandEncoderRelease(encoder);
            {
                const bbl::pal::DawnReadbackMap mapped(
                    dawn.state, capture.readback,
                    static_cast<std::size_t>(capture.bytes_per_row) * height);
                screenshot_check::print_unpacked(label, mapped.bytes(), width, height,
                                                 capture.bytes_per_row,
                                                 *bbl::pal::dawn_screenshot_bgra(format));
            }
            wgpuTextureRelease(texture);
        }
        for (const std::string& error : dawn.errors)
            std::fprintf(stderr, "Dawn error: %s\n", error.c_str());
        require(dawn.errors.empty(), "Dawn reported validation errors");
        std::printf("dawn ok\n");
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
}

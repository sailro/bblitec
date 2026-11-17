// `captureScreenshot`'s readback on the WebGPU-subset fixtures' headless Dawn
// device: each 8-bit format's texture is written with the test's texels,
// copied and mapped by the backend's own halves (lifted into `lifted.hpp`),
// and unpacked by the lowered pin.

#include "check.hpp"

#include <webgpu/webgpu.h>

#include <cstring>
#include <exception>
#include <string>

#include "../webgpu-subset/dawn-harness.hpp"

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

using webgpu_fixture::require;

namespace {
WGPUStringView text(const char* value) { return WGPUStringView{value, std::strlen(value)}; }
} // namespace

int main() {
    try {
        webgpu_fixture::DawnHarness dawn(bbl::GpuSupportedLimits{});
        bbl::pal::DawnDevice state{dawn.instance, {}};
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
                    state, capture.readback,
                    static_cast<std::size_t>(capture.bytes_per_row) * height);
                screenshot_check::print_unpacked(label, mapped.bytes(), width, height,
                                                 capture.bytes_per_row,
                                                 *bbl::pal::screenshot_bgra(label));
            }
            wgpuTextureRelease(texture);
        }
        dawn.check_errors();
        std::printf("dawn ok\n");
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
}

// An effect task's pass on the WebGPU-subset fixtures' headless Dawn device,
// case by case: the target is filled stale, then the task's pass clears it
// and draws the fixture's fullscreen triangle through the backend's own
// `record_dawn_effect_task_pass` (lifted into `lifted.hpp` with what it
// calls), and the target is read back.

#include "check.hpp"

#include <webgpu/webgpu.h>

#include <cstring>
#include <exception>
#include <iterator>

#include "../webgpu-subset/dawn-harness.hpp"
#include "pal_gpu_images.hpp"

namespace bbl::pal {
/** The backend's effect pass, as far as its draw reads it. */
struct DawnEffectPass {
    WGPURenderPipeline pipeline = nullptr;
};
/** The backend's `_record` half: the fixture's fullscreen triangle. */
inline void record_dawn_effect_pass(WGPURenderPassEncoder render_pass, const DawnEffectPass& pass) {
    wgpuRenderPassEncoderSetPipeline(render_pass, pass.pipeline);
    wgpuRenderPassEncoderDraw(render_pass, 3, 1, 0, 0);
}
} // namespace bbl::pal

#include "lifted.hpp"
#include "cases.hpp"

namespace {
using webgpu_fixture::require;

constexpr char shader_source[] = R"(
@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
    let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
    return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fragment_main() -> @location(0) vec4f {
    return vec4f(1.0, 0.0, 0.0, 1.0);
}
)";

WGPUStringView text(const char* value) { return WGPUStringView{value, std::strlen(value)}; }

WGPURenderPassEncoder begin_pass(WGPUCommandEncoder encoder, WGPUTextureView view,
                                 const std::uint8_t (&colour)[4]) {
    WGPURenderPassColorAttachment attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    attachment.view = view;
    attachment.loadOp = WGPULoadOp_Clear;
    attachment.storeOp = WGPUStoreOp_Store;
    attachment.clearValue =
        WGPUColor{colour[0] / 255.0, colour[1] / 255.0, colour[2] / 255.0, colour[3] / 255.0};
    WGPURenderPassDescriptor descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    descriptor.colorAttachmentCount = 1;
    descriptor.colorAttachments = &attachment;
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &descriptor);
    require(pass != nullptr, "wgpuCommandEncoderBeginRenderPass");
    return pass;
}
} // namespace

int main() {
    try {
        webgpu_fixture::DawnHarness dawn(bbl::GpuSupportedLimits{});
        WGPUShaderSourceWGSL wgsl = WGPU_SHADER_SOURCE_WGSL_INIT;
        wgsl.code = text(shader_source);
        WGPUShaderModuleDescriptor module_descriptor = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
        module_descriptor.nextInChain = &wgsl.chain;
        WGPUShaderModule module = wgpuDeviceCreateShaderModule(dawn.device, &module_descriptor);
        require(module != nullptr, "wgpuDeviceCreateShaderModule");
        WGPUColorTargetState colour = WGPU_COLOR_TARGET_STATE_INIT;
        colour.format = WGPUTextureFormat_RGBA8Unorm;
        WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
        fragment.module = module;
        fragment.entryPoint = text("fragment_main");
        fragment.targetCount = 1;
        fragment.targets = &colour;
        WGPURenderPipelineDescriptor pipeline_descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
        pipeline_descriptor.vertex.module = module;
        pipeline_descriptor.vertex.entryPoint = text("vertex_main");
        pipeline_descriptor.fragment = &fragment;
        const bbl::pal::DawnEffectPass pass{
            wgpuDeviceCreateRenderPipeline(dawn.device, &pipeline_descriptor)};
        require(pass.pipeline != nullptr, "wgpuDeviceCreateRenderPipeline");
        WGPUTextureDescriptor texture_descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
        texture_descriptor.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
        texture_descriptor.size = WGPUExtent3D{target_width, target_height, 1};
        texture_descriptor.format = colour.format;
        WGPUTexture image = wgpuDeviceCreateTexture(dawn.device, &texture_descriptor);
        require(image != nullptr, "wgpuDeviceCreateTexture");
        WGPUTextureView view = wgpuTextureCreateView(image, nullptr);
        const std::uint32_t row_bytes = bbl::pal::readback_bytes_per_row(target_width * 4);
        WGPUBufferDescriptor buffer_descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        buffer_descriptor.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
        buffer_descriptor.size = static_cast<std::uint64_t>(row_bytes) * target_height;
        WGPUBuffer readback = wgpuDeviceCreateBuffer(dawn.device, &buffer_descriptor);
        require(readback != nullptr, "wgpuDeviceCreateBuffer");
        for (std::size_t index = 0; index < std::size(cases); ++index) {
            const bbl::FrameTaskRecord task = effect_task_scissor::task_of(cases[index]);
            WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(dawn.device, nullptr);
            WGPURenderPassEncoder fill = begin_pass(encoder, view, effect_task_scissor::stale);
            wgpuRenderPassEncoderEnd(fill);
            wgpuRenderPassEncoderRelease(fill);
            // The task's pass as the frame graph opens it, then its draw.
            WGPURenderPassEncoder render_pass =
                begin_pass(encoder, view, effect_task_scissor::cleared);
            bbl::pal::record_dawn_effect_task_pass(render_pass, pass, task, target_width,
                                                   target_height);
            wgpuRenderPassEncoderEnd(render_pass);
            wgpuRenderPassEncoderRelease(render_pass);
            WGPUTexelCopyTextureInfo source = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
            source.texture = image;
            WGPUTexelCopyBufferInfo destination = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
            destination.layout.bytesPerRow = row_bytes;
            destination.layout.rowsPerImage = target_height;
            destination.buffer = readback;
            const WGPUExtent3D extent{target_width, target_height, 1};
            wgpuCommandEncoderCopyTextureToBuffer(encoder, &source, &destination, &extent);
            WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, nullptr);
            wgpuQueueSubmit(dawn.queue, 1, &commands);
            wgpuCommandBufferRelease(commands);
            wgpuCommandEncoderRelease(encoder);
            bool mapped = false;
            WGPUBufferMapCallbackInfo callback = WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
            callback.mode = WGPUCallbackMode_WaitAnyOnly;
            callback.userdata1 = &mapped;
            callback.callback = [](WGPUMapAsyncStatus status, WGPUStringView, void* data, void*) {
                *static_cast<bool*>(data) = status == WGPUMapAsyncStatus_Success;
            };
            dawn.wait(wgpuBufferMapAsync(readback, WGPUMapMode_Read, 0, buffer_descriptor.size,
                                         callback));
            require(mapped, "wgpuBufferMapAsync");
            const auto* rgba = static_cast<const std::uint8_t*>(
                wgpuBufferGetConstMappedRange(readback, 0, buffer_descriptor.size));
            require(rgba != nullptr, "wgpuBufferGetConstMappedRange");
            effect_task_scissor::print_case(index, rgba, row_bytes, target_width, target_height);
            wgpuBufferUnmap(readback);
        }
        wgpuBufferRelease(readback);
        wgpuTextureViewRelease(view);
        wgpuTextureRelease(image);
        wgpuRenderPipelineRelease(pass.pipeline);
        wgpuShaderModuleRelease(module);
        dawn.check_errors();
        std::printf("dawn ok\n");
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
}

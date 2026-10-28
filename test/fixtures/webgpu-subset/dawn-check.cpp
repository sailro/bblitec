// The lowered splat-stream library's GPU work on a headless Dawn device through
// `DawnWebGpuDevice`.

#include "dawn-harness.hpp"
#include "stream-render.hpp"

namespace {

/** The scene pass a Dawn renderer opens: rgba8unorm colour, depth24plus-stencil8 depth. */
struct DawnTarget final : stream_check::RenderTarget {
    webgpu_fixture::DawnHarness& harness;
    bbl::pal::DawnWebGpuDevice& device;
    bbl::pal::DawnTexture color, multisampled, depth;
    bbl::pal::DawnTextureView color_view, multisampled_view, depth_view;
    bbl::pal::DawnBuffer readback;
    static constexpr std::uint32_t row_bytes = 512;
    DawnTarget(webgpu_fixture::DawnHarness& owner, bbl::pal::DawnWebGpuDevice& gpu)
        : harness(owner), device(gpu) {
        width = 96;
        height = 64;
        signature = {"rgba8unorm", std::string("depth24plus-stencil8"), {}, 1};
        WGPUBufferDescriptor info = WGPU_BUFFER_DESCRIPTOR_INIT;
        info.size = row_bytes * height;
        info.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
        readback = wgpuDeviceCreateBuffer(harness.device, &info);
    }
    void configure(std::uint32_t samples) override {
        signature.sample_count = samples;
        const auto texture = [&](WGPUTextureFormat format, WGPUTextureUsage usage,
                                 std::uint32_t count) {
            WGPUTextureDescriptor info = WGPU_TEXTURE_DESCRIPTOR_INIT;
            info.size = {width, height, 1};
            info.format = format;
            info.usage = usage;
            info.sampleCount = count;
            return wgpuDeviceCreateTexture(harness.device, &info);
        };
        color = texture(WGPUTextureFormat_RGBA8Unorm,
                        WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc, 1);
        depth = texture(WGPUTextureFormat_Depth24PlusStencil8, WGPUTextureUsage_RenderAttachment,
                        samples);
        color_view = wgpuTextureCreateView(color, nullptr);
        depth_view = wgpuTextureCreateView(depth, nullptr);
        multisampled_view.reset();
        multisampled.reset();
        if (samples > 1) {
            multisampled =
                texture(WGPUTextureFormat_RGBA8Unorm, WGPUTextureUsage_RenderAttachment, samples);
            multisampled_view = wgpuTextureCreateView(multisampled, nullptr);
        }
    }
    std::vector<std::uint8_t>
    frame(const std::function<void(const bbl::GpuCommandEncoderHandle&)>& prepare,
          const std::function<void(const bbl::GpuEncoderHandle&)>& draw) override {
        bbl::pal::DawnCommandEncoder encoder{
            wgpuDeviceCreateCommandEncoder(harness.device, nullptr)};
        prepare(device.borrow_command_encoder(encoder));
        WGPURenderPassColorAttachment attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        attachment.view = multisampled_view ? multisampled_view.get() : color_view.get();
        attachment.resolveTarget = multisampled_view ? color_view.get() : nullptr;
        attachment.loadOp = WGPULoadOp_Clear;
        attachment.storeOp = multisampled_view ? WGPUStoreOp_Discard : WGPUStoreOp_Store;
        attachment.clearValue = {0, 0, 0, 1};
        WGPURenderPassDepthStencilAttachment depth_attachment =
            WGPU_RENDER_PASS_DEPTH_STENCIL_ATTACHMENT_INIT;
        depth_attachment.view = depth_view;
        depth_attachment.depthLoadOp = WGPULoadOp_Clear;
        depth_attachment.depthStoreOp = WGPUStoreOp_Discard;
        depth_attachment.depthClearValue = 0;
        depth_attachment.stencilLoadOp = WGPULoadOp_Clear;
        depth_attachment.stencilStoreOp = WGPUStoreOp_Discard;
        WGPURenderPassDescriptor descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        descriptor.colorAttachmentCount = 1;
        descriptor.colorAttachments = &attachment;
        descriptor.depthStencilAttachment = &depth_attachment;
        bbl::pal::DawnRenderPass pass{wgpuCommandEncoderBeginRenderPass(encoder, &descriptor)};
        bbl::GpuEncoderHandle lent;
        draw(bbl::pal::DawnWebGpuDevice::lend_render_pass(lent, pass));
        wgpuRenderPassEncoderEnd(pass);
        pass.reset();
        WGPUTexelCopyTextureInfo source = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        source.texture = color;
        WGPUTexelCopyBufferInfo destination = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
        destination.buffer = readback;
        destination.layout.bytesPerRow = row_bytes;
        destination.layout.rowsPerImage = height;
        const WGPUExtent3D extent{width, height, 1};
        wgpuCommandEncoderCopyTextureToBuffer(encoder, &source, &destination, &extent);
        bbl::pal::DawnCommandBuffer commands{wgpuCommandEncoderFinish(encoder, nullptr)};
        bbl::pal::submit_dawn_command(harness.queue, commands);
        bool mapped = false;
        WGPUBufferMapCallbackInfo callback = WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
        callback.mode = WGPUCallbackMode_WaitAnyOnly;
        callback.userdata1 = &mapped;
        callback.callback = [](WGPUMapAsyncStatus status, WGPUStringView, void* data, void*) {
            *static_cast<bool*>(data) = status == WGPUMapAsyncStatus_Success;
        };
        harness.wait(
            wgpuBufferMapAsync(readback, WGPUMapMode_Read, 0, row_bytes * height, callback));
        stream_check::require(mapped, "render readback mapping");
        const auto* bytes = static_cast<const std::uint8_t*>(
            wgpuBufferGetConstMappedRange(readback, 0, row_bytes * height));
        std::vector<std::uint8_t> image(std::size_t{width} * height * 4);
        for (std::uint32_t row = 0; row < height; ++row)
            std::memcpy(image.data() + std::size_t{row} * width * 4, bytes + row * row_bytes,
                        std::size_t{width} * 4);
        wgpuBufferUnmap(readback);
        return image;
    }
};

bbl::js::Promise<bbl::js::PromiseVoid> run(std::shared_ptr<bbl::pal::DawnWebGpuDevice> device,
                                           webgpu_fixture::DawnHarness& harness,
                                           const bbl::GpuSupportedLimits& limits) {
    stream_check::Library library(device);
    stream_check::check_limits(*device, limits);
    co_await stream_check::check_mapping(*device);
    co_await stream_check::check_sort(library, 70000, 69123, 0x13579bdfu);
    co_await stream_check::check_projection(library);
    const auto sog = stream_check::sog_images();
    const auto source = stream_check::upload_source(*device, sog);
    co_await stream_check::check_gather(library, sog, source);
    DawnTarget target(harness, *device);
    co_await stream_check::check_render(library, source, target);
    co_return bbl::js::PromiseVoid{};
}

} // namespace

int main() {
    const auto limits = bbl::gpu_required_limits(
        {{"maxBufferSize", 256640000}, {"maxStorageBufferBindingSize", 256640000}});
    return webgpu_fixture::run_dawn(
        limits,
        [&](std::shared_ptr<bbl::pal::DawnWebGpuDevice> device,
            webgpu_fixture::DawnHarness& harness) { return run(device, harness, limits); },
        "dawn");
}

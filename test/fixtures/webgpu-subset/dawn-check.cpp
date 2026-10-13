// The lowered splat-stream library's GPU work on a headless Dawn device through
// `DawnWebGpuDevice`.

#include "pal_dawn_webgpu.hpp"
#include "stream-render.hpp"

#include <bblite/js_realm_state.hpp>

#include <mutex>
#include <thread>

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

/** The scene pass a Dawn renderer opens: rgba8unorm colour, depth24plus-stencil8 depth. */
struct DawnTarget final : stream_check::RenderTarget {
    DawnHarness& harness;
    bbl::pal::DawnWebGpuDevice& device;
    bbl::pal::DawnTexture color, multisampled, depth;
    bbl::pal::DawnTextureView color_view, multisampled_view, depth_view;
    bbl::pal::DawnBuffer readback;
    static constexpr std::uint32_t row_bytes = 512;
    DawnTarget(DawnHarness& owner, bbl::pal::DawnWebGpuDevice& gpu) : harness(owner), device(gpu) {
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
        draw(bbl::pal::DawnWebGpuDevice::borrow_render_pass(pass));
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
                                           DawnHarness& harness,
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
    try {
        const auto limits = bbl::gpu_required_limits(
            {{"maxBufferSize", 256640000}, {"maxStorageBufferBindingSize", 256640000}});
        DawnHarness harness(limits);
        std::exception_ptr failure;
        // The realm runs on its own thread: the library's realm state (its
        // pipeline caches) ends with that thread, before the device does.
        std::thread([&] {
            try {
                const bbl::js::RealmScope realm;
                bbl::pal::EventLoop loop;
                loop.run([&] {
                    auto device = std::make_shared<bbl::pal::DawnWebGpuDevice>(
                        harness.instance, harness.device, harness.queue);
                    run(device, harness, limits)
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
        std::printf("dawn ok\n");
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
}

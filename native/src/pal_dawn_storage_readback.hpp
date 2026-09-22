#pragma once
#include "pal_dawn_storage_buffer.hpp"
#include "pal_dawn_completion.hpp"
#include <bblite/pal_storage_readback.hpp>

namespace bbl::pal {
struct DawnStorageReadback final : StorageReadback {
    WGPUInstance instance;
    WGPUDevice device;
    WGPUQueue queue;
    DawnBuffer buffer;
    std::size_t length;
    DawnStorageReadback(WGPUInstance context, WGPUDevice owner, WGPUQueue submitted,
                        const StorageReadbackDescriptor& descriptor)
        : instance(context), device(owner), queue(submitted), length(descriptor.size) {
        if (descriptor.usage != 9)
            throw std::runtime_error("Dawn storage readback requires COPY_DST and MAP_READ.");
        WGPUBufferDescriptor info = WGPU_BUFFER_DESCRIPTOR_INIT;
        info.label = {descriptor.label.data(), descriptor.label.size()};
        info.size = length;
        info.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
        buffer = wgpuDeviceCreateBuffer(device, &info);
        if (!buffer)
            throw std::runtime_error("Dawn storage readback allocation failed.");
    }
    ~DawnStorageReadback() override { destroy(); }
    std::size_t byte_length() const override { return length; }
    void destroy() override {
        if (buffer) {
            wgpuBufferDestroy(buffer);
            buffer = {};
        }
    }
    void copy_from(const std::shared_ptr<StorageBufferAllocation>& allocation, std::size_t offset,
                   std::size_t target, std::size_t count, const std::string& label) override {
        const auto source = std::dynamic_pointer_cast<DawnStorageBuffer>(allocation);
        if (!source || !source->buffer || !buffer)
            throw std::runtime_error("Dawn storage readback requires live compatible buffers.");
        WGPUCommandEncoderDescriptor info = WGPU_COMMAND_ENCODER_DESCRIPTOR_INIT;
        info.label = {label.data(), label.size()};
        DawnCommandEncoder encoder{wgpuDeviceCreateCommandEncoder(device, &info)};
        wgpuCommandEncoderCopyBufferToBuffer(encoder, source->buffer, offset, buffer, target,
                                             count);
        DawnCommandBuffer command{wgpuCommandEncoderFinish(encoder, nullptr)};
        submit_dawn_command(queue, command);
    }
    std::unique_ptr<OffscreenCompletion>
    map_async(std::size_t offset, std::size_t count,
              std::function<void(std::exception_ptr)> complete) override {
        if (!buffer)
            throw std::runtime_error("Dawn storage readback has been destroyed.");
        auto state = std::make_shared<DawnCompletionState>(std::move(complete));
        WGPUBufferMapCallbackInfo callback = WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
        callback.mode = WGPUCallbackMode_WaitAnyOnly;
        callback.userdata1 = new std::shared_ptr<DawnCompletionState>(state);
        callback.callback = [](WGPUMapAsyncStatus status, WGPUStringView, void* data, void*) {
            const std::unique_ptr<std::shared_ptr<DawnCompletionState>> owner(
                static_cast<std::shared_ptr<DawnCompletionState>*>(data));
            (*owner)->deliver(status == WGPUMapAsyncStatus_Success
                                  ? std::exception_ptr{}
                                  : std::make_exception_ptr(std::runtime_error(
                                        "Dawn storage readback mapping failed.")));
        };
        const auto future = wgpuBufferMapAsync(buffer, WGPUMapMode_Read, offset, count, callback);
        return std::make_unique<DawnFutureCompletion>(instance, future, std::move(state));
    }
    std::span<const std::uint8_t> mapped_range(std::size_t offset, std::size_t count) override {
        if (!buffer)
            throw std::runtime_error("Dawn storage readback has been destroyed.");
        const auto* data =
            static_cast<const std::uint8_t*>(wgpuBufferGetConstMappedRange(buffer, offset, count));
        if (!data)
            throw std::runtime_error("Dawn storage readback range is not mapped.");
        return {data, count};
    }
    void unmap() override {
        if (buffer)
            wgpuBufferUnmap(buffer);
    }
};
} // namespace bbl::pal

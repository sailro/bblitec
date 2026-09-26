#pragma once

#include "pal_dawn_resources.hpp"
#include <bblite/pal_storage_buffer.hpp>
#include <cstring>
#include <stdexcept>

namespace bbl::pal {

struct DawnStorageBuffer final : StorageBufferAllocation {
    DawnBuffer buffer;
    WGPUQueue queue = nullptr;
    const void* device_identity() const override { return queue; }
    std::optional<std::size_t> buffer_capacity() const override { return gpu_size(size); }
    ~DawnStorageBuffer() override { destroy(); }
    void destroy() override {
        if (buffer) {
            wgpuBufferDestroy(buffer);
            buffer = {};
        }
    }
    void write_buffer_bytes(std::size_t offset, std::span<const std::uint8_t> bytes) override {
        write_dawn_gpu_buffer(queue, buffer, offset, bytes);
    }
};

inline std::shared_ptr<StorageBufferAllocation>
create_dawn_storage_buffer(WGPUDevice device, WGPUQueue queue,
                           const StorageBufferDescriptor& options,
                           std::optional<std::span<const std::uint8_t>> initial) {
    WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
    descriptor.label = {options.label.data(), options.label.size()};
    descriptor.size = options.byte_length;
    descriptor.usage = static_cast<WGPUBufferUsage>(options.roles) | WGPUBufferUsage_CopyDst;
    descriptor.mappedAtCreation = initial.has_value();
    auto allocation = std::make_shared<DawnStorageBuffer>();
    allocation->queue = queue;
    allocation->size = static_cast<double>(options.byte_length);
    allocation->buffer = wgpuDeviceCreateBuffer(device, &descriptor);
    if (!allocation->buffer)
        throw std::runtime_error("Dawn storage buffer creation failed.");
    if (initial) {
        auto* destination = wgpuBufferGetMappedRange(allocation->buffer, 0, options.byte_length);
        if (!destination)
            throw std::runtime_error("Dawn storage buffer mapping failed.");
        if (initial->size() > options.byte_length)
            throw std::runtime_error("Storage buffer initial bytes exceed allocation.");
        if (!initial->empty())
            std::memcpy(destination, initial->data(), initial->size());
        wgpuBufferUnmap(allocation->buffer);
    }
    return allocation;
}

} // namespace bbl::pal

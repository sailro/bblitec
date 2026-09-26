#pragma once

#include "pal_sdl_gpu_shared.hpp"
#include <bblite/pal_storage_buffer.hpp>
#include <limits>

namespace bbl::pal {

/** SDL materializes uniform bytes with PushGPUComputeUniformData at each dispatch. */
struct SdlUniformBuffer final : StorageBufferAllocation {
    SDL_GPUDevice* device = nullptr;
    const void* device_identity() const override { return device; }
    std::optional<std::size_t> buffer_capacity() const override { return bytes.size(); }
    std::vector<std::uint8_t> bytes;
    void destroy() override { bytes.clear(); }
    void write_buffer_bytes(std::size_t offset, std::span<const std::uint8_t> source) override {
        if (offset > bytes.size() || source.size() > bytes.size() - offset)
            throw std::runtime_error("Uniform buffer write exceeds allocation.");
        std::copy(source.begin(), source.end(),
                  bytes.begin() + static_cast<std::ptrdiff_t>(offset));
    }
};

struct SdlStorageBuffer final : StorageBufferAllocation {
    explicit SdlStorageBuffer(SDL_GPUDevice* owner) : device(owner) {}
    SDL_GPUDevice* device;
    SDL_GPUBuffer* buffer = nullptr;
    std::size_t byte_length = 0;
    const void* device_identity() const override { return device; }
    std::optional<std::size_t> buffer_capacity() const override { return byte_length; }
    ~SdlStorageBuffer() override { destroy(); }
    void destroy() override {
        if (buffer)
            SDL_ReleaseGPUBuffer(device, std::exchange(buffer, nullptr));
    }
    void write_buffer_bytes(std::size_t offset, std::span<const std::uint8_t> bytes) override {
        write_sdl_gpu_buffer(device, buffer, offset, bytes);
    }
};

inline std::shared_ptr<StorageBufferAllocation>
create_sdl_gpu_storage_buffer(SDL_GPUDevice* device, const StorageBufferDescriptor& options,
                              std::optional<std::span<const std::uint8_t>> initial) {
    if (options.byte_length > std::numeric_limits<Uint32>::max())
        throw std::runtime_error("Storage buffer exceeds SDL's API size range.");
    const auto role = [&](StorageBufferRole value) {
        return (options.roles & static_cast<std::uint32_t>(value)) != 0;
    };
    SDL_GPUBufferUsageFlags usage =
        SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ | SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_READ;
    if (role(StorageBufferRole::copy_src))
        usage |= SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_WRITE;
    if (role(StorageBufferRole::vertex))
        usage |= SDL_GPU_BUFFERUSAGE_VERTEX;
    if (role(StorageBufferRole::index))
        usage |= SDL_GPU_BUFFERUSAGE_INDEX;
    if (role(StorageBufferRole::indirect))
        usage |= SDL_GPU_BUFFERUSAGE_INDIRECT;
    // WebGPU clears newly allocated bytes, including padding beyond an initial view.
    std::vector<std::uint8_t> bytes(options.byte_length, 0);
    if (initial) {
        if (initial->size() > bytes.size())
            throw std::runtime_error("Storage buffer initial bytes exceed allocation.");
        std::copy(initial->begin(), initial->end(), bytes.begin());
    }
    if (role(StorageBufferRole::uniform)) {
        auto allocation = std::make_shared<SdlUniformBuffer>();
        allocation->device = device;
        allocation->bytes = std::move(bytes);
        return allocation;
    }
    auto allocation = std::make_shared<SdlStorageBuffer>(device);
    allocation->byte_length = options.byte_length;
    SDL_GPUBufferCreateInfo descriptor{};
    descriptor.usage = usage;
    descriptor.size = static_cast<Uint32>(options.byte_length);
    allocation->buffer = SDL_CreateGPUBuffer(device, &descriptor);
    if (!allocation->buffer)
        gpu_error("SDL_CreateGPUBuffer storage");
    GpuBufferUploadBatch uploads(device);
    uploads.update(allocation->buffer, 0, bytes.data(), bytes.size());
    if (!options.label.empty())
        SDL_SetGPUBufferName(device, allocation->buffer, options.label.c_str());
    uploads.submit();
    return allocation;
}

} // namespace bbl::pal

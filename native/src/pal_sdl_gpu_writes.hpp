#pragma once
#include <bblite/gpu.hpp>
#include <SDL3/SDL_gpu.h>
#include "pal_sdl_gpu_commands.hpp"
#include "pal_sdl_gpu_error.hpp"
#include "pal_sdl_gpu_resources.hpp"
#include "pal_sdl_gpu_texture_ops.hpp"
#include <cstring>
#include <limits>
#include <stdexcept>
#include <utility>

namespace bbl::pal {
struct SdlTextureTransferCache {
    SDL_GPUTransferBuffer* transfer = nullptr;
    std::uint32_t capacity = 0;
};

inline void write_sdl_gpu_buffer(SDL_GPUDevice* device, SDL_GPUBuffer* buffer, std::size_t offset,
                                 std::span<const std::uint8_t> bytes, bool cycle = false) {
    if (!device || !buffer)
        throw std::runtime_error("SDL buffer write has no resource.");
    const auto count = gpu_u32(bytes.size()), start = gpu_u32(offset);
    if (count > std::numeric_limits<Uint32>::max() - start)
        throw std::runtime_error("SDL buffer write exceeds the native API size range.");
    if (bytes.empty())
        return;
    SDL_GPUTransferBufferCreateInfo info{};
    info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    info.size = count;
    OwnedSdlTransfer transfer{SDL_CreateGPUTransferBuffer(device, &info), {device}};
    if (!transfer)
        gpu_error("SDL_CreateGPUTransferBuffer buffer write");
    void* mapped = SDL_MapGPUTransferBuffer(device, transfer.get(), false);
    if (!mapped)
        gpu_error("SDL_MapGPUTransferBuffer buffer write");
    std::memcpy(mapped, bytes.data(), bytes.size());
    SDL_UnmapGPUTransferBuffer(device, transfer.get());
    SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(device)};
    if (!command)
        gpu_error("SDL_AcquireGPUCommandBuffer buffer write");
    SdlCopyPass copy{SDL_BeginGPUCopyPass(command)};
    if (!copy)
        gpu_error("SDL_BeginGPUCopyPass buffer write");
    const SDL_GPUTransferBufferLocation source{transfer.get(), 0};
    const SDL_GPUBufferRegion destination{buffer, start, count};
    SDL_UploadToGPUBuffer(copy, &source, &destination, cycle);
    copy.end();
    if (!command.submit())
        gpu_error("SDL_SubmitGPUCommandBuffer buffer write");
}

/**
 * Copy bytes into a texture that already exists.
 *
 * The upload half of `upload_2d_texture` (pal_sdl_gpu_shared.hpp), split out because a payload
 * that changes per frame -- the clustered light field's three data textures --
 * needs the copy without a second allocation.
 */
inline void write_sdl_gpu_texture(SDL_GPUDevice* device, SDL_GPUTexture* texture,
                                  std::span<const std::uint8_t> bytes,
                                  const GpuTextureWriteLayout& layout, const GpuWriteExtent& extent,
                                  std::uint32_t mip_levels = 1,
                                  SdlTextureTransferCache* cache = nullptr) {
    if (!device || !texture)
        throw std::runtime_error("SDL texture write has no resource.");
    if (!extent.width || !extent.height || !extent.depth_or_array_layers)
        return;
    if (extent.depth_or_array_layers != 1)
        throw std::runtime_error("This SDL texture destination accepts one image per write.");
    const auto count = gpu_u32(bytes.size());
    SDL_GPUTransferBufferCreateInfo info{};
    info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    info.size = count;
    OwnedSdlTransfer temporary{nullptr, {device}};
    SDL_GPUTransferBuffer* transfer = nullptr;
    if (cache) {
        if (!cache->transfer || cache->capacity < count) {
            if (cache->transfer)
                SDL_ReleaseGPUTransferBuffer(device, std::exchange(cache->transfer, nullptr));
            cache->capacity = 0;
            cache->transfer = SDL_CreateGPUTransferBuffer(device, &info);
            if (!cache->transfer)
                gpu_error("SDL_CreateGPUTransferBuffer texture write");
            cache->capacity = count;
        }
        transfer = cache->transfer;
    } else {
        temporary.reset(SDL_CreateGPUTransferBuffer(device, &info));
        transfer = temporary.get();
        if (!transfer)
            gpu_error("SDL_CreateGPUTransferBuffer texture write");
    }
    void* mapped = SDL_MapGPUTransferBuffer(device, transfer, cache != nullptr);
    if (!mapped)
        gpu_error("SDL_MapGPUTransferBuffer texture write");
    std::memcpy(mapped, bytes.data(), bytes.size());
    SDL_UnmapGPUTransferBuffer(device, transfer);
    SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(device)};
    if (!command)
        gpu_error("SDL_AcquireGPUCommandBuffer texture write");
    SdlCopyPass copy{SDL_BeginGPUCopyPass(command)};
    if (!copy)
        gpu_error("SDL_BeginGPUCopyPass texture write");
    const SDL_GPUTextureTransferInfo source{transfer, gpu_u32(layout.offset), extent.width,
                                            layout.rows_per_image.value_or(extent.height)};
    const SDL_GPUTextureRegion destination{texture, 0, 0, 0, 0, 0, extent.width, extent.height, 1};
    SDL_UploadToGPUTexture(copy, &source, &destination, cache != nullptr);
    copy.end();
    generate_texture_mipmaps(device, command, texture, extent.width, extent.height, mip_levels);
    if (!command.submit())
        gpu_error("SDL_SubmitGPUCommandBuffer texture write");
}

struct SdlBufferDestination final : GpuObject {
    SDL_GPUDevice* device;
    SDL_GPUBuffer* buffer;
    bool cycle;
    SdlBufferDestination(SDL_GPUDevice* owner, SDL_GPUBuffer* value, bool reuse)
        : device(owner), buffer(value), cycle(reuse) {}
    const void* device_identity() const override { return device; }
    void write_buffer_bytes(std::size_t offset, std::span<const std::uint8_t> bytes) override {
        write_sdl_gpu_buffer(device, buffer, offset, bytes, cycle);
    }
};
struct SdlTextureDestination final : GpuObject {
    SDL_GPUDevice* device;
    SDL_GPUTexture* texture;
    std::uint32_t mip_levels;
    SdlTextureTransferCache* cache;
    SdlTextureDestination(SDL_GPUDevice* owner, SDL_GPUTexture* value, std::uint32_t levels = 1,
                          SdlTextureTransferCache* storage = nullptr)
        : device(owner), texture(value), mip_levels(levels), cache(storage) {}
    const void* device_identity() const override { return device; }
    void write_texture_bytes(std::span<const std::uint8_t> bytes,
                             const GpuTextureWriteLayout& layout,
                             const GpuWriteExtent& extent) override {
        write_sdl_gpu_texture(device, texture, bytes, layout, extent, mip_levels, cache);
    }
};
/** SDL binds written uniform bytes in the active command buffer. */
template <auto Push> struct SdlUniformDestination final : GpuObject {
    SDL_GPUCommandBuffer* command;
    Uint32 slot;
    SdlUniformDestination(SDL_GPUCommandBuffer* value, Uint32 index)
        : command(value), slot(index) {}
    void write_buffer_bytes(std::size_t offset, std::span<const std::uint8_t> bytes) override {
        if (!command || offset != 0)
            throw std::runtime_error("Invalid SDL stage uniform destination.");
        Push(command, slot, bytes.data(), gpu_u32(bytes.size()));
    }
};
struct SdlGpuWriteDevice : GpuDevice {
    SDL_GPUDevice* device;
    explicit SdlGpuWriteDevice(SDL_GPUDevice* value = nullptr) : device(value) {}
    const void* device_identity() const override { return device; }
    template <auto Push>
    void write_uniform(SDL_GPUCommandBuffer* command, Uint32 slot, const void* data,
                       std::size_t count) {
        if (!data && count)
            throw std::runtime_error("SDL uniform write has no source bytes.");
        SdlUniformDestination<Push> destination{command, slot};
        write_buffer(destination, 0, {static_cast<const std::uint8_t*>(data), count});
    }
    void write_vertex_uniform(SDL_GPUCommandBuffer* command, Uint32 slot, const void* data,
                              std::size_t count) {
        write_uniform<SDL_PushGPUVertexUniformData>(command, slot, data, count);
    }
    void write_fragment_uniform(SDL_GPUCommandBuffer* command, Uint32 slot, const void* data,
                                std::size_t count) {
        write_uniform<SDL_PushGPUFragmentUniformData>(command, slot, data, count);
    }
    void write_compute_uniform(SDL_GPUCommandBuffer* command, Uint32 slot, const void* data,
                               std::size_t count) {
        write_uniform<SDL_PushGPUComputeUniformData>(command, slot, data, count);
    }
};
} // namespace bbl::pal

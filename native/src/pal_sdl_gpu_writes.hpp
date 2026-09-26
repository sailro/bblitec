#pragma once
#include <bblite/gpu.hpp>
#include <SDL3/SDL_gpu.h>

namespace bbl::pal {
struct SdlTextureTransferCache {
    SDL_GPUTransferBuffer* transfer = nullptr;
    std::uint32_t capacity = 0;
};
inline void write_sdl_gpu_buffer(SDL_GPUDevice*, SDL_GPUBuffer*, std::size_t,
                                 std::span<const std::uint8_t>, bool cycle = false);
inline void write_sdl_gpu_texture(SDL_GPUDevice*, SDL_GPUTexture*, std::span<const std::uint8_t>,
                                  const GpuTextureWriteLayout&, const GpuWriteExtent&,
                                  std::uint32_t mip_levels = 1, SdlTextureTransferCache* = nullptr);
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

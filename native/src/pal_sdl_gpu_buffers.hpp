// SDL buffer allocation and upload ownership, shared by every renderer.
#pragma once

#include "pal_sdl_gpu_resources.hpp"
#include "pal_sdl_gpu_writes.hpp"
#include "pal_sdl_gpu_error.hpp"
#include <stdexcept>

namespace bbl::pal {

inline SDL_GPUBuffer* upload_buffer(SDL_GPUDevice* device, SDL_GPUBufferUsageFlags usage,
                                    const void* data, std::size_t size) {
    SDL_GPUBufferCreateInfo info{};
    info.usage = usage;
    info.size = gpu_u32(size);
    OwnedSdlBuffer buffer{SDL_CreateGPUBuffer(device, &info), {device}};
    if (!buffer)
        gpu_error("SDL_CreateGPUBuffer");
    if (!data && size)
        throw std::runtime_error("SDL buffer write has no source bytes.");
    SdlBufferDestination destination{device, buffer.get(), false};
    SdlGpuWriteDevice{device}.write_buffer(destination, 0,
                                           {static_cast<const std::uint8_t*>(data), size});
    return buffer.release();
}
inline void update_buffer(SDL_GPUDevice* device, SDL_GPUBuffer* buffer, const void* data,
                          std::size_t size) {
    if (!data && size)
        throw std::runtime_error("SDL buffer write has no source bytes.");
    SdlBufferDestination destination{device, buffer, true};
    SdlGpuWriteDevice{device}.write_buffer(destination, 0,
                                           {static_cast<const std::uint8_t*>(data), size});
}

} // namespace bbl::pal

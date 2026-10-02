#pragma once

#include <bblite/pal_gpu_adapter.hpp>
#include <SDL3/SDL_gpu.h>
#include <stdexcept>

namespace bbl::pal {

inline GpuAdapterInfo sdl_gpu_adapter_info(SDL_GPUDevice* device) {
    const auto properties = SDL_GetGPUDeviceProperties(device);
    if (!properties)
        throw std::runtime_error(SDL_GetError());
    return {gpu_adapter_vendor(static_cast<std::uint32_t>(
                SDL_GetNumberProperty(properties, "bblite.gpu.adapter.vendor_id", 0))),
            {},
            gpu_adapter_hex_id(static_cast<std::uint32_t>(
                SDL_GetNumberProperty(properties, "bblite.gpu.adapter.device_id", 0))),
            SDL_GetStringProperty(properties, SDL_PROP_GPU_DEVICE_NAME_STRING, "")};
}

} // namespace bbl::pal

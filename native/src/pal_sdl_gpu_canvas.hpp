#pragma once

#include "pal_gpu_canvas_targets.hpp"
#include "pal_sdl_gpu_error.hpp"
#include <SDL3/SDL.h>
#include <cstdint>
#include <cstring>

namespace bbl::pal {

inline bool sdl_canvas_storage_supported(SDL_GPUDevice* device,
                                         bool platform = linux_canvas_storage) {
    return platform && std::strcmp(SDL_GetGPUDeviceDriver(device), "vulkan") == 0 &&
           SDL_GetBooleanProperty(SDL_GetGPUDeviceProperties(device),
                                  "bblite.gpu.canvas_storage_allocation", false);
}

inline void configure_sdl_canvas_window(SDL_GPUDevice* device, SDL_Window* window) {
    if (sdl_canvas_storage_supported(device) &&
        !SDL_SetBooleanProperty(SDL_GetWindowProperties(window),
                                "bblite.gpu.swapchain.canvas_storage", true))
        gpu_error("SDL_SetBooleanProperty canvas window");
}

inline SDL_GPUTexture* create_frame_texture(SDL_GPUDevice* device, SDL_GPUTextureFormat format,
                                            SDL_GPUSampleCount samples, std::uint32_t width,
                                            std::uint32_t height, SDL_GPUTextureUsageFlags usage,
                                            std::uint32_t layers = 1, bool canvas = false,
                                            std::uint32_t levels = 1) {
    SDL_GPUTextureCreateInfo info{};
    // Layered attachments retain the declared array shape, including shadow maps.
    info.type = layers > 1 ? SDL_GPU_TEXTURETYPE_2D_ARRAY : SDL_GPU_TEXTURETYPE_2D;
    info.format = format;
    info.usage = usage;
    info.width = width;
    info.height = height;
    info.layer_count_or_depth = layers;
    info.num_levels = levels;
    info.sample_count = samples;
    if (canvas && layers == 1 && samples == SDL_GPU_SAMPLECOUNT_1 &&
        sdl_canvas_storage_supported(device)) {
        info.props = SDL_CreateProperties();
        if (!info.props)
            gpu_error("SDL_CreateProperties canvas texture");
        if (!SDL_SetBooleanProperty(info.props, "bblite.gpu.texture.canvas_storage", true)) {
            SDL_DestroyProperties(info.props);
            gpu_error("SDL_SetBooleanProperty canvas texture");
        }
    }
    SDL_GPUTexture* texture = SDL_CreateGPUTexture(device, &info);
    if (info.props)
        SDL_DestroyProperties(info.props);
    if (!texture)
        gpu_error("SDL_CreateGPUTexture frame graph");
    return texture;
}

} // namespace bbl::pal

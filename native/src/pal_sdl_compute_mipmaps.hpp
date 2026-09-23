#pragma once
#include "pal_sdl_compute_texture.hpp"
#include <bblite/pal_compute_mipmaps.hpp>

namespace bbl::pal {
// SDL's linear GPU blit represents the pinned fullscreen bilinear pass.
struct SdlComputeMipmapPipeline final : ComputeMipmapPipeline {};
struct SdlComputeMipmapLevel final : ComputeMipmapLevel {
    SDL_GPUDevice* device = nullptr;
    std::shared_ptr<SdlComputeTexture> texture;
    SDL_GPUBlitInfo blit{};
    void encode(SDL_GPUCommandBuffer* command, std::uint32_t vertices) const {
        if (vertices != 3)
            throw std::runtime_error("SDL mipmap blits require the pinned fullscreen triangle.");
        SDL_BlitGPUTexture(command, &blit);
    }
    void submit(std::uint32_t vertices) override {
        SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(device)};
        if (!command)
            throw std::runtime_error(SDL_GetError());
        encode(command, vertices);
        if (!command.submit())
            throw std::runtime_error(SDL_GetError());
    }
};
inline std::shared_ptr<ComputeMipmapLevel> create_sdl_compute_mipmap_level(
    SDL_GPUDevice* device, const std::shared_ptr<ComputeMipmapPipeline>& pipeline,
    const std::shared_ptr<ComputeTextureAllocation>& allocation,
    const ComputeTextureDescriptor& descriptor, std::uint32_t source_mip, std::uint32_t target_mip,
    std::uint32_t base_array_layer) {
    auto result = std::make_shared<SdlComputeMipmapLevel>();
    result->device = device;
    result->texture = std::dynamic_pointer_cast<SdlComputeTexture>(allocation);
    if (!std::dynamic_pointer_cast<SdlComputeMipmapPipeline>(pipeline) || !result->texture ||
        !result->texture->texture)
        throw std::runtime_error("Mipmap resources do not belong to SDL.");
    result->blit.source.texture = result->texture->texture;
    result->blit.source.mip_level = source_mip;
    result->blit.source.layer_or_depth_plane = base_array_layer;
    result->blit.source.w = std::max(1u, descriptor.extent[0] >> source_mip);
    result->blit.source.h = std::max(1u, descriptor.extent[1] >> source_mip);
    result->blit.destination.texture = result->texture->texture;
    result->blit.destination.mip_level = target_mip;
    result->blit.destination.layer_or_depth_plane = base_array_layer;
    result->blit.destination.w = std::max(1u, descriptor.extent[0] >> target_mip);
    result->blit.destination.h = std::max(1u, descriptor.extent[1] >> target_mip);
    result->blit.load_op = SDL_GPU_LOADOP_CLEAR;
    result->blit.filter = SDL_GPU_FILTER_LINEAR;
    return result;
}
} // namespace bbl::pal

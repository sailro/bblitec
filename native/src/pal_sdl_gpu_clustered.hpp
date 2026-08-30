#pragma once

// The clustered light field's SDL_GPU resources.
//
// The container is a generated record and its binning is generated code; what
// this file owns is the three data textures the composed fragment reads and
// the sampler SDL requires beside each. The fragment `textureLoad`s all three,
// so the sampler is never consulted -- but SDL_GPU binds textures and samplers
// as pairs, so one nearest/clamp sampler is created and shared.
//
// Every extent here comes off the container: `size_clustered_light_state` sized
// the payloads through the pin's own `textureElementCount`, and
// `upload_region` is the pin's own `writeDataTexture` rule. Neither backend
// derives one, so the two cannot disagree.

#include <bblite/pal_gpu.hpp>
#include <bblite/runtime.hpp>
#include <bblite/upstream/clustered_light.hpp>

#include <SDL3/SDL_gpu.h>

#include <array>
#include <cstdint>

#include "pal_sdl_gpu_shared.hpp"

namespace bbl::pal {

/** The three data textures, their shared sampler, and what was uploaded. */
struct ClusteredLightGpu {
    SDL_GPUTexture* lights = nullptr;
    SDL_GPUTexture* cells = nullptr;
    SDL_GPUTexture* indices = nullptr;
    SDL_GPUSampler* sampler = nullptr;
    std::uint64_t uploaded_version = 0;
    bool created = false;
};

/**
 * Create the three textures, once, at the extents the container was sized to.
 *
 * The formats are the pin's own: the light payload is four floats per texel,
 * the slice range four unsigned ints, and the tile mask one.
 */
inline void create_clustered_textures(
    SDL_GPUDevice* device,
    const ClusteredLightContainer& container,
    ClusteredLightGpu& gpu) {
    if (gpu.created) return;
    const auto make = [&](std::uint32_t rows,
                          SDL_GPUTextureFormat format,
                          const char* label) {
        SDL_GPUTextureCreateInfo info{};
        info.type = SDL_GPU_TEXTURETYPE_2D;
        info.format = format;
        info.usage = SDL_GPU_TEXTUREUSAGE_SAMPLER;
        info.width = container.data_texture_width;
        info.height = rows;
        info.layer_count_or_depth = 1;
        info.num_levels = 1;
        SDL_GPUTexture* texture = SDL_CreateGPUTexture(device, &info);
        if (!texture) gpu_error(label);
        return texture;
    };
    gpu.lights = make(
        container.light_rows,
        SDL_GPU_TEXTUREFORMAT_R32G32B32A32_FLOAT,
        "clustered light data texture");
    gpu.cells = make(
        container.slice_rows,
        SDL_GPU_TEXTUREFORMAT_R32G32B32A32_UINT,
        "clustered slice texture");
    gpu.indices = make(
        container.mask_rows,
        SDL_GPU_TEXTUREFORMAT_R32_UINT,
        "clustered tile mask texture");
    SDL_GPUSamplerCreateInfo sampler{};
    sampler.min_filter = SDL_GPU_FILTER_NEAREST;
    sampler.mag_filter = SDL_GPU_FILTER_NEAREST;
    sampler.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
    sampler.address_mode_u = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
    sampler.address_mode_v = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
    sampler.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
    gpu.sampler = SDL_CreateGPUSampler(device, &sampler);
    if (!gpu.sampler) gpu_error("clustered sampler");
    gpu.created = true;
}

/**
 * Re-bin against this frame's own two matrices and upload whatever moved.
 *
 * `refresh_clustered_lights` is the pin's per-frame pass and bumps the version
 * only when it rewrote a payload, so a still camera costs one matrix
 * comparison and no upload at all.
 */
inline void upload_clustered_lights(
    SDL_GPUDevice* device,
    ClusteredLightContainer& container,
    const std::array<float, 16>& view,
    const std::array<float, 16>& projection,
    double near_plane,
    double far_plane,
    ClusteredLightGpu& gpu) {
    create_clustered_textures(device, container, gpu);
    upstream::refresh_clustered_lights(
        container, view, projection, near_plane, far_plane);
    if (gpu.uploaded_version == container.upload_version) return;
    const auto write = [&](SDL_GPUTexture* texture,
                           const void* bytes,
                           std::size_t byte_size,
                           std::uint32_t texels,
                           std::uint32_t rows,
                           const char* label) {
        const auto region = container.upload_region(texels, rows);
        upload_2d_texture_into(
            device,
            texture,
            bytes,
            byte_size,
            region.width,
            region.height,
            label);
    };
    write(
        gpu.lights,
        container.light_data.data(),
        container.light_data.size() * sizeof(float),
        container.light_texels,
        container.light_rows,
        "clustered light data upload");
    write(
        gpu.cells,
        container.slice_data.data(),
        container.slice_data.size() * sizeof(std::uint32_t),
        container.slice_count,
        container.slice_rows,
        "clustered slice upload");
    write(
        gpu.indices,
        container.mask_data.data(),
        container.mask_data.size() * sizeof(std::uint32_t),
        container.mask_texels,
        container.mask_rows,
        "clustered tile mask upload");
    gpu.uploaded_version = container.upload_version;
}

/** Release what this state created. */
inline void release_clustered_lights(
    SDL_GPUDevice* device,
    ClusteredLightGpu& gpu) {
    if (gpu.lights) SDL_ReleaseGPUTexture(device, gpu.lights);
    if (gpu.cells) SDL_ReleaseGPUTexture(device, gpu.cells);
    if (gpu.indices) SDL_ReleaseGPUTexture(device, gpu.indices);
    if (gpu.sampler) SDL_ReleaseGPUSampler(device, gpu.sampler);
    gpu = ClusteredLightGpu{};
}

}  // namespace bbl::pal

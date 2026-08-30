#pragma once

// The clustered light field's Dawn resources.
//
// The SDL_GPU twin of this file explains the split: the container is a
// generated record and its binning is generated code, so what a backend owns
// is the three data textures the composed fragment reads and the buffer its
// params block binds. WebGPU needs no sampler beside a `textureLoad`, so
// unlike the SDL side this one creates none.
//
// Every extent comes off the container, through the same `upload_region` the
// SDL side uses -- the pin's own `writeDataTexture` rule, in one place.

#include <bblite/runtime.hpp>
#include <bblite/upstream/clustered_light.hpp>

#include <webgpu/webgpu.h>

#include <array>
#include <cstdint>

#include "pal_dawn_shared.hpp"

namespace bbl::pal {

/** The params buffer, the three data textures, and what was uploaded. */
struct DawnClusteredLights {
    WGPUBuffer params = nullptr;
    WGPUTexture lights_texture = nullptr;
    WGPUTexture cells_texture = nullptr;
    WGPUTexture indices_texture = nullptr;
    WGPUTextureView lights = nullptr;
    WGPUTextureView cells = nullptr;
    WGPUTextureView indices = nullptr;
    std::uint64_t uploaded_version = 0;
    bool created = false;
};

/**
 * Create the params buffer and the three textures, once.
 *
 * The formats are the pin's own: four floats per light texel, four unsigned
 * ints per slice, one per tile-mask word. Nothing here decides an extent --
 * `size_clustered_light_state` did, from the light count.
 */
inline void create_dawn_clustered(
    WGPUDevice device,
    const ClusteredLightContainer& container,
    DawnClusteredLights& gpu) {
    if (gpu.created) return;
    WGPUBufferDescriptor params = WGPU_BUFFER_DESCRIPTOR_INIT;
    params.size = container.params.size() * sizeof(std::uint32_t);
    params.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
    gpu.params = wgpuDeviceCreateBuffer(device, &params);
    if (!gpu.params) dawn_error("clustered light params buffer");
    const auto make = [&](std::uint32_t rows,
                          WGPUTextureFormat format,
                          const char* label,
                          WGPUTexture& texture,
                          WGPUTextureView& view) {
        WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
        descriptor.format = format;
        descriptor.usage =
            WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
        descriptor.size = {container.data_texture_width, rows, 1};
        texture = wgpuDeviceCreateTexture(device, &descriptor);
        if (!texture) dawn_error(label);
        view = wgpuTextureCreateView(texture, nullptr);
        if (!view) dawn_error(label);
    };
    make(
        container.light_rows,
        WGPUTextureFormat_RGBA32Float,
        "clustered light data texture",
        gpu.lights_texture,
        gpu.lights);
    make(
        container.slice_rows,
        WGPUTextureFormat_RGBA32Uint,
        "clustered slice texture",
        gpu.cells_texture,
        gpu.cells);
    make(
        container.mask_rows,
        WGPUTextureFormat_R32Uint,
        "clustered tile mask texture",
        gpu.indices_texture,
        gpu.indices);
    gpu.created = true;
}

/**
 * Re-bin against this frame's own two matrices and write whatever moved.
 *
 * `refresh_clustered_lights` bumps a version only when it rewrote a payload,
 * so a frame whose camera did not move costs one matrix comparison. The params
 * block is written on the same condition, because upstream writes it inside
 * the very branch that rebinned.
 */
inline void upload_dawn_clustered(
    WGPUDevice device,
    WGPUQueue queue,
    ClusteredLightContainer& container,
    const std::array<float, 16>& view,
    const std::array<float, 16>& projection,
    double near_plane,
    double far_plane,
    DawnClusteredLights& gpu) {
    create_dawn_clustered(device, container, gpu);
    upstream::refresh_clustered_lights(
        container, view, projection, near_plane, far_plane);
    if (gpu.uploaded_version == container.upload_version) return;
    wgpuQueueWriteBuffer(
        queue,
        gpu.params,
        0,
        container.params.data(),
        container.params.size() * sizeof(std::uint32_t));
    const auto write = [&](WGPUTexture texture,
                           const void* bytes,
                           std::size_t byte_size,
                           std::uint32_t texel_bytes,
                           std::uint32_t texels,
                           std::uint32_t rows) {
        const auto region = container.upload_region(texels, rows);
        WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        destination.texture = texture;
        WGPUTexelCopyBufferLayout layout{};
        layout.bytesPerRow = region.width * texel_bytes;
        layout.rowsPerImage = region.height;
        const WGPUExtent3D extent{region.width, region.height, 1};
        wgpuQueueWriteTexture(
            queue, &destination, bytes, byte_size, &layout, &extent);
    };
    write(
        gpu.lights_texture,
        container.light_data.data(),
        container.light_data.size() * sizeof(float),
        16u,
        container.light_texels,
        container.light_rows);
    write(
        gpu.cells_texture,
        container.slice_data.data(),
        container.slice_data.size() * sizeof(std::uint32_t),
        16u,
        container.slice_count,
        container.slice_rows);
    write(
        gpu.indices_texture,
        container.mask_data.data(),
        container.mask_data.size() * sizeof(std::uint32_t),
        4u,
        container.mask_texels,
        container.mask_rows);
    gpu.uploaded_version = container.upload_version;
}

}  // namespace bbl::pal

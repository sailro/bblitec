#pragma once
#include "pal_clustered_shared.hpp"

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
    DawnBuffer params;
    DawnTexture lights_texture;
    DawnTexture cells_texture;
    DawnTexture indices_texture;
    DawnTextureView lights;
    DawnTextureView cells;
    DawnTextureView indices;
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
    gpu = {};
    WGPUBufferDescriptor params = WGPU_BUFFER_DESCRIPTOR_INIT;
    params.size = container.params.size() * sizeof(std::uint32_t);
    params.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
    gpu.params = wgpuDeviceCreateBuffer(device, &params);
    if (!gpu.params) dawn_error("clustered light params buffer");
    const auto make = [&](std::uint32_t rows,
                          WGPUTextureFormat format,
                          const char* label,
                          DawnTexture& texture,
                          DawnTextureView& view) {
        WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
        descriptor.format = format;
        descriptor.usage =
            WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
        descriptor.size = {container.data_texture_width, rows, 1};
        texture = wgpuDeviceCreateTexture(device, &descriptor);
        if (!texture) dawn_error(label);
        view = create_dawn_texture_view(texture, nullptr);
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
    WGPUDevice device, WGPUQueue queue, ClusteredLightContainer& container,
    const std::array<float, 16>& view, const std::array<float, 16>& projection,
    double near_plane, double far_plane, DawnClusteredLights& gpu) {
    create_dawn_clustered(device, container, gpu);
    sync_clustered_payloads(container, gpu.uploaded_version, view, projection, near_plane, far_plane,
        [&](const void* bytes, std::size_t size) { wgpuQueueWriteBuffer(queue, gpu.params, 0, bytes, size); },
        [&](ClusteredTexture slot, const void* bytes, std::size_t size, std::uint32_t texel_bytes,
            std::uint32_t width, std::uint32_t height) {
            WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
            destination.texture = slot == ClusteredTexture::lights ? gpu.lights_texture
                : slot == ClusteredTexture::cells ? gpu.cells_texture : gpu.indices_texture;
            WGPUTexelCopyBufferLayout layout{};
            layout.bytesPerRow = width * texel_bytes;
            layout.rowsPerImage = height;
            const WGPUExtent3D extent{width, height, 1};
            wgpuQueueWriteTexture(queue, &destination, bytes, size, &layout, &extent);
        });
}

}  // namespace bbl::pal

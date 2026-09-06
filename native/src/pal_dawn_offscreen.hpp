#pragma once

#include "pal_dawn_shared.hpp"
#include "pal_offscreen_gpu.hpp"

namespace bbl::pal {

struct DawnOffscreenImage final : OffscreenImage {
    DawnOffscreenImage(WGPUDevice device, std::uint32_t width, std::uint32_t height) {
        WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
        descriptor.dimension = WGPUTextureDimension_2D;
        descriptor.format = WGPUTextureFormat_BGRA8Unorm;
        descriptor.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopySrc;
        descriptor.size = WGPUExtent3D{width, height, 1};
        texture = wgpuDeviceCreateTexture(device, &descriptor);
        if (!texture) dawn_error("offscreen texture creation failed.");
    }
    ~DawnOffscreenImage() override { wgpuTextureRelease(texture); }
    WGPUTexture texture = nullptr;
};

} // namespace bbl::pal

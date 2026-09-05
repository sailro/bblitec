#pragma once

#include <bblite/pal_ui.hpp>
#include <array>
#include <vector>

namespace bbl::pal {

struct UiDawnTexture {
    WGPUTexture texture = nullptr;
    WGPUTextureView view = nullptr;
    WGPUBindGroup group = nullptr;
    WGPUBindGroup nearest_group = nullptr;
    void release() {
        if (nearest_group) wgpuBindGroupRelease(nearest_group);
        if (group) wgpuBindGroupRelease(group);
        if (view) wgpuTextureViewRelease(view);
        if (texture) wgpuTextureRelease(texture);
        *this = {};
    }
};

struct UiBackdropDawnResources {
    struct Pair {
        UiDawnTexture snapshot, first, second;
        std::uint32_t source_width = 0, source_height = 0;
        std::uint32_t blur_width = 0, blur_height = 0;
    };
    WGPURenderPipeline pipeline = nullptr;
    std::vector<Pair> pairs;
    void release() {
        for (auto& pair : pairs) {
            pair.snapshot.release();
            pair.first.release();
            pair.second.release();
        }
        if (pipeline) wgpuRenderPipelineRelease(pipeline);
        *this = {};
    }
};

inline UiDawnTexture create_ui_backdrop_dawn_texture(
    WGPUDevice device, WGPUBindGroupLayout layout, WGPUSampler sampler,
    std::uint32_t width, std::uint32_t height, WGPUTextureFormat format) {
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.dimension = WGPUTextureDimension_2D;
    descriptor.size = {width, height, 1};
    descriptor.format = format;
    descriptor.mipLevelCount = 1;
    descriptor.sampleCount = 1;
    descriptor.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopyDst;
    UiDawnTexture result;
    result.texture = wgpuDeviceCreateTexture(device, &descriptor);
    result.view = wgpuTextureCreateView(result.texture, nullptr);
    std::array<WGPUBindGroupEntry, 2> entries{};
    entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
    entries[0].binding = 0;
    entries[0].textureView = result.view;
    entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
    entries[1].binding = 1;
    entries[1].sampler = sampler;
    WGPUBindGroupDescriptor group = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    group.layout = layout;
    group.entryCount = entries.size();
    group.entries = entries.data();
    result.group = wgpuDeviceCreateBindGroup(device, &group);
    return result;
}

inline void render_ui_backdrop_dawn(
    WGPUDevice device, WGPUCommandEncoder encoder, WGPUTexture target,
    WGPUTextureView target_view, WGPUTextureFormat target_format,
    WGPUBuffer vertices, WGPUBuffer indices, WGPUSampler sampler,
    WGPUBindGroup screen_group, WGPUBindGroupLayout texture_layout,
    WGPURenderPipeline composite_pipeline, UiBackdropDawnResources& resources,
    const UiRenderFrame& frame, std::size_t backdrop_index) {
    const auto& backdrop = frame.backdrops[backdrop_index];
    const auto create = [&](std::uint32_t width, std::uint32_t height, WGPUTextureFormat format) {
        return create_ui_backdrop_dawn_texture(device, texture_layout, sampler, width, height, format);
    };
    if (resources.pairs.size() <= backdrop_index) resources.pairs.resize(backdrop_index + 1);
    auto& pair = resources.pairs[backdrop_index];
    if (!pair.snapshot.texture || pair.source_width != backdrop.width ||
        pair.source_height != backdrop.height) {
        pair.snapshot.release();
        pair.source_width = backdrop.width;
        pair.source_height = backdrop.height;
        pair.snapshot = create(pair.source_width, pair.source_height, target_format);
    }
    if (!pair.first.texture || pair.blur_width != backdrop.blur_width ||
        pair.blur_height != backdrop.blur_height) {
        pair.first.release();
        pair.second.release();
        pair.blur_width = backdrop.blur_width;
        pair.blur_height = backdrop.blur_height;
        pair.first = create(pair.blur_width, pair.blur_height, WGPUTextureFormat_RGBA16Float);
        pair.second = create(pair.blur_width, pair.blur_height, WGPUTextureFormat_RGBA16Float);
    }
    WGPUTexelCopyTextureInfo source = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    source.texture = target;
    source.origin = {
        static_cast<std::uint32_t>(backdrop.left),
        static_cast<std::uint32_t>(backdrop.top),
        0};
    WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    destination.texture = pair.snapshot.texture;
    const WGPUExtent3D extent{backdrop.width, backdrop.height, 1};
    wgpuCommandEncoderCopyTextureToTexture(encoder, &source, &destination, &extent);
    const auto draw = [&](WGPUTextureView output, WGPUBindGroup input,
                          std::uint32_t first, std::uint32_t count, bool composite) {
        WGPURenderPassColorAttachment attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        attachment.view = output;
        attachment.loadOp = composite ? WGPULoadOp_Load : WGPULoadOp_Clear;
        attachment.storeOp = WGPUStoreOp_Store;
        attachment.clearValue = {0, 0, 0, 0};
        WGPURenderPassDescriptor descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        descriptor.colorAttachmentCount = 1;
        descriptor.colorAttachments = &attachment;
        auto pass = wgpuCommandEncoderBeginRenderPass(encoder, &descriptor);
        wgpuRenderPassEncoderSetPipeline(pass, composite ? composite_pipeline : resources.pipeline);
        wgpuRenderPassEncoderSetBindGroup(pass, 0, screen_group, 0, nullptr);
        wgpuRenderPassEncoderSetBindGroup(pass, 1, input, 0, nullptr);
        wgpuRenderPassEncoderSetVertexBuffer(pass, 0, vertices, 0, WGPU_WHOLE_SIZE);
        wgpuRenderPassEncoderSetIndexBuffer(pass, indices, WGPUIndexFormat_Uint32, 0, WGPU_WHOLE_SIZE);
        wgpuRenderPassEncoderDrawIndexed(pass, count, 1, first, 0, 0);
        wgpuRenderPassEncoderEnd(pass);
        wgpuRenderPassEncoderRelease(pass);
    };
    draw(
        pair.first.view,
        pair.snapshot.group,
        backdrop.sample_index,
        UiBackdrop::sample_index_count,
        false);
    draw(pair.second.view, pair.first.group, backdrop.horizontal_index(), backdrop.kernel_index_count, false);
    draw(pair.first.view, pair.second.group, backdrop.vertical_index(), backdrop.kernel_index_count, false);
    draw(target_view, pair.first.group, backdrop.composite_index(), backdrop.composite_index_count, true);
}

} // namespace bbl::pal

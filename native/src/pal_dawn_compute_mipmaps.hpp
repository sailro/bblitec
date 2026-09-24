#pragma once
#include "pal_dawn_compute_texture.hpp"
#include <bblite/pal_compute_mipmaps.hpp>

namespace bbl::pal {
struct DawnComputeMipmapPipeline final : ComputeMipmapPipeline {
    DawnShaderModule shader;
    DawnSampler sampler;
    DawnRenderPipeline pipeline;
    DawnBindGroupLayout bindings;
};

inline std::shared_ptr<ComputeMipmapPipeline>
create_dawn_compute_mipmap_pipeline(WGPUDevice device, const std::string& format,
                                    const std::string& code) {
    auto result = std::make_shared<DawnComputeMipmapPipeline>();
    WGPUShaderSourceWGSL source = WGPU_SHADER_SOURCE_WGSL_INIT;
    source.code = {code.data(), code.size()};
    WGPUShaderModuleDescriptor module = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
    module.nextInChain = &source.chain;
    result->shader =
        require_dawn_resource(wgpuDeviceCreateShaderModule(device, &module), "mipmap shader");
    WGPUSamplerDescriptor sampler = WGPU_SAMPLER_DESCRIPTOR_INIT;
    sampler.minFilter = WGPUFilterMode_Linear;
    sampler.magFilter = WGPUFilterMode_Linear;
    result->sampler =
        require_dawn_resource(wgpuDeviceCreateSampler(device, &sampler), "mipmap sampler");
    WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
    target.format = dawn_compute_texture_format(format);
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = result->shader;
    fragment.entryPoint = {"fs", 2};
    fragment.targetCount = 1;
    fragment.targets = &target;
    // Laid out by the module itself, as the device-level mip generator's
    // blit is: the one pipeline per format is the only one its levels'
    // groups are bound to, so the group layout is the one Dawn reflects
    // off the pin's texture-and-sampler pair.
    WGPURenderPipelineDescriptor pipeline = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    pipeline.vertex.module = result->shader;
    pipeline.vertex.entryPoint = {"vs", 2};
    pipeline.fragment = &fragment;
    pipeline.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    result->pipeline =
        require_dawn_resource(wgpuDeviceCreateRenderPipeline(device, &pipeline), "mipmap pipeline");
    result->bindings = require_dawn_resource(
        wgpuRenderPipelineGetBindGroupLayout(result->pipeline, 0), "mipmap bindings");
    return result;
}

struct DawnComputeMipmapLevel final : ComputeMipmapLevel {
    WGPUDevice device = nullptr;
    WGPUQueue queue = nullptr;
    std::shared_ptr<DawnComputeMipmapPipeline> pipeline;
    std::shared_ptr<DawnComputeTexture> texture;
    DawnTextureView source, target;
    DawnBindGroup bindings;
    void encode(WGPUCommandEncoder encoder, std::uint32_t vertices) const {
        WGPURenderPassColorAttachment color = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        color.view = target;
        color.loadOp = WGPULoadOp_Clear;
        color.storeOp = WGPUStoreOp_Store;
        color.clearValue = {0, 0, 0, 0};
        WGPURenderPassDescriptor render = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        render.colorAttachmentCount = 1;
        render.colorAttachments = &color;
        DawnRenderPass pass{require_dawn_resource(
            wgpuCommandEncoderBeginRenderPass(encoder, &render), "mipmap pass")};
        wgpuRenderPassEncoderSetPipeline(pass, pipeline->pipeline);
        wgpuRenderPassEncoderSetBindGroup(pass, 0, bindings, 0, nullptr);
        wgpuRenderPassEncoderDraw(pass, vertices, 1, 0, 0);
        wgpuRenderPassEncoderEnd(pass);
    }
    void submit(std::uint32_t vertices) override {
        WGPUCommandEncoderDescriptor descriptor = WGPU_COMMAND_ENCODER_DESCRIPTOR_INIT;
        DawnCommandEncoder encoder{require_dawn_resource(
            wgpuDeviceCreateCommandEncoder(device, &descriptor), "mipmap encoder")};
        encode(encoder, vertices);
        WGPUCommandBufferDescriptor finish = WGPU_COMMAND_BUFFER_DESCRIPTOR_INIT;
        DawnCommandBuffer command{
            require_dawn_resource(wgpuCommandEncoderFinish(encoder, &finish), "mipmap command")};
        submit_dawn_command(queue, command);
    }
};
inline std::shared_ptr<ComputeMipmapLevel> create_dawn_compute_mipmap_level(
    WGPUDevice device, WGPUQueue queue, const std::shared_ptr<ComputeMipmapPipeline>& pipeline,
    const std::shared_ptr<ComputeTextureAllocation>& allocation, std::uint32_t source_mip,
    std::uint32_t target_mip, std::uint32_t base_array_layer) {
    auto result = std::make_shared<DawnComputeMipmapLevel>();
    result->device = device;
    result->queue = queue;
    result->pipeline = std::dynamic_pointer_cast<DawnComputeMipmapPipeline>(pipeline);
    result->texture = std::dynamic_pointer_cast<DawnComputeTexture>(allocation);
    if (!result->pipeline || !result->texture || !result->texture->texture)
        throw std::runtime_error("Mipmap resources do not belong to Dawn.");
    WGPUTextureViewDescriptor view = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
    view.dimension = WGPUTextureViewDimension_2D;
    view.baseArrayLayer = base_array_layer;
    view.arrayLayerCount = 1;
    view.mipLevelCount = 1;
    view.baseMipLevel = source_mip;
    result->source = create_dawn_texture_view(result->texture->texture, &view);
    view.baseMipLevel = target_mip;
    result->target = create_dawn_texture_view(result->texture->texture, &view);
    WGPUBindGroupEntry entries[2] = {WGPU_BIND_GROUP_ENTRY_INIT, WGPU_BIND_GROUP_ENTRY_INIT};
    entries[0].binding = 0;
    entries[0].textureView = result->source;
    entries[1].binding = 1;
    entries[1].sampler = result->pipeline->sampler;
    WGPUBindGroupDescriptor bindings = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    bindings.layout = result->pipeline->bindings;
    bindings.entryCount = 2;
    bindings.entries = entries;
    result->bindings =
        require_dawn_resource(wgpuDeviceCreateBindGroup(device, &bindings), "mipmap sampled level");
    return result;
}
} // namespace bbl::pal

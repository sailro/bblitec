#pragma once
#include "pal_ui_filter.hpp"
#include "pal_ui_backdrop_dawn.hpp"
#include "pal_dawn_shared.hpp"

namespace bbl::pal {

struct UiFilterDawnResources {
    struct Texture {
        UiDawnTexture value;
        std::uint32_t width = 0, height = 0;
        WGPUTextureFormat format = WGPUTextureFormat_Undefined;
        void release() { value.release(); width = height = 0; format = WGPUTextureFormat_Undefined; }
        void ensure(WGPUDevice device, WGPUBindGroupLayout layout, WGPUSampler sampler,
                    std::uint32_t w, std::uint32_t h, WGPUTextureFormat f) {
            if (!value.texture || width != w || height != h || format != f) {
                release(); value = create_ui_backdrop_dawn_texture(device, layout, sampler, w, h, f);
                width = w; height = h; format = f;
            }
        }
    };
    struct Layer { Texture texture; bool used = false; };
    struct Pass {
        WGPUBuffer buffer = nullptr;
        WGPUBindGroup uniform_group = nullptr, texture_group = nullptr;
        WGPUTextureView source = nullptr, shadow = nullptr;
        WGPUSampler sampler = nullptr;
        void release() {
            if (uniform_group) wgpuBindGroupRelease(uniform_group);
            if (texture_group) wgpuBindGroupRelease(texture_group);
            if (buffer) wgpuBufferRelease(buffer);
            *this = {};
        }
    };
    struct Workspace {
        UiFilterTargets<Texture> textures;
        std::vector<Pass> passes;
        void release() {
            for (auto& pass : passes) pass.release();
            passes.clear();
            textures.release([](Texture& texture) { texture.release(); });
        }
    };
    WGPURenderPipeline pipeline = nullptr;
    WGPUBindGroupLayout texture_layout = nullptr, uniform_layout = nullptr;
    std::vector<Layer> layers;
    std::vector<Workspace> workspaces;
    void begin_frame() { for (auto& layer : layers) layer.used = false; }
    void reset_layer(std::uint32_t id) { if (id > 0 && id <= layers.size()) layers[id - 1].used = false; }
    void finish_frame(std::size_t count) {
        for (auto& layer : layers) if (!layer.used) layer.texture.release();
        for (std::size_t i = count; i < workspaces.size(); ++i) workspaces[i].release();
        if (workspaces.size() > count) workspaces.resize(count);
    }
    void release() {
        for (auto& layer : layers) layer.texture.release();
        for (auto& workspace : workspaces) workspace.release();
        if (pipeline) wgpuRenderPipelineRelease(pipeline);
        if (texture_layout) wgpuBindGroupLayoutRelease(texture_layout);
        if (uniform_layout) wgpuBindGroupLayoutRelease(uniform_layout);
        *this = {};
    }
    void ensure_pipeline(WGPUDevice device) {
        if (pipeline) return;
        DawnShaderModule vertex{load_wgsl_module(device, "ui-filter.vert")};
        DawnShaderModule fragment{load_wgsl_module(device, "ui-filter.frag")};
        WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
        descriptor.vertex.module = vertex; descriptor.vertex.entryPoint = string_view("mainVertex");
        descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
        WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
        target.format = WGPUTextureFormat_RGBA16Float;
        WGPUFragmentState stage = WGPU_FRAGMENT_STATE_INIT;
        stage.module = fragment; stage.entryPoint = string_view("mainFragment");
        stage.targetCount = 1; stage.targets = &target; descriptor.fragment = &stage;
        pipeline = require_dawn_resource(wgpuDeviceCreateRenderPipeline(device, &descriptor), "UI filter pipeline");
        texture_layout = wgpuRenderPipelineGetBindGroupLayout(pipeline, 2);
        uniform_layout = wgpuRenderPipelineGetBindGroupLayout(pipeline, 3);
    }
    UiDawnTexture target(WGPUDevice device, WGPUCommandEncoder encoder, UiDawnTexture root,
        WGPUTextureFormat format, WGPUBindGroupLayout layout, WGPUSampler sampler, const UiRenderFrame& frame, std::uint32_t id) {
        if (id == 0) return root;
        if (id > frame.layer_count) throw std::runtime_error("Invalid retained UI layer.");
        if (layers.size() < id) layers.resize(id);
        auto& layer = layers[id - 1];
        layer.texture.ensure(device, layout, sampler, frame.width, frame.height, format);
        if (!layer.used) {
            WGPURenderPassColorAttachment attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
            attachment.view = layer.texture.value.view; attachment.loadOp = WGPULoadOp_Clear; attachment.storeOp = WGPUStoreOp_Store;
            WGPURenderPassDescriptor descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
            descriptor.colorAttachmentCount = 1; descriptor.colorAttachments = &attachment;
            DawnRenderPass pass{wgpuCommandEncoderBeginRenderPass(encoder, &descriptor)};
            wgpuRenderPassEncoderEnd(pass); pass.reset(); layer.used = true;
        }
        return layer.texture.value;
    }
};

inline void render_ui_composite_dawn(WGPUDevice device, WGPUQueue queue, WGPUCommandEncoder encoder,
    UiDawnTexture root, WGPUTextureFormat format, WGPUBuffer vertices, WGPUBuffer indices,
    WGPUSampler sampler, WGPUBindGroup screen_group, WGPUBindGroupLayout ui_texture_layout,
    WGPURenderPipeline composite_pipeline, UiFilterDawnResources& resources, const UiRenderFrame& frame, std::size_t index) {
    const auto& composite = frame.composites[index];
    if (!composite.index_count) return;
    const auto source = resources.target(device, encoder, root, format, ui_texture_layout, sampler, frame, composite.source);
    const auto destination = resources.target(device, encoder, root, format, ui_texture_layout, sampler, frame, composite.destination);
    if (resources.workspaces.size() <= index) resources.workspaces.resize(index + 1);
    auto& workspace = resources.workspaces[index];
    auto& textures = workspace.textures;
    textures.begin();
    textures.get(UiFilterSurface::Snapshot).ensure(device, ui_texture_layout, sampler, composite.width, composite.height, format);
    WGPUTexelCopyTextureInfo from{};
    from.texture = source.texture; from.aspect = WGPUTextureAspect_All;
    from.origin = {static_cast<std::uint32_t>(composite.left), static_cast<std::uint32_t>(composite.top), 0};
    WGPUTexelCopyTextureInfo to{};
    to.texture = textures.get(UiFilterSurface::Snapshot).value.texture; to.aspect = WGPUTextureAspect_All;
    const WGPUExtent3D extent{composite.width, composite.height, 1};
    wgpuCommandEncoderCopyTextureToTexture(encoder, &from, &to, &extent);
    const auto plan = ui_filter_plan(composite);
    if (!plan.draws.empty()) resources.ensure_pipeline(device);
    for (std::size_t i = plan.draws.size(); i < workspace.passes.size(); ++i) workspace.passes[i].release();
    workspace.passes.resize(plan.draws.size());
    for (std::size_t i = 0; i < plan.draws.size(); ++i) {
        const auto& draw = plan.draws[i];
        auto& output = textures.output(draw);
        output.ensure(device, ui_texture_layout, sampler, draw.width, draw.height, WGPUTextureFormat_RGBA16Float);
        auto& resources_pass = workspace.passes[i];
        if (!resources_pass.buffer) {
            WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
            descriptor.size = sizeof(draw.uniforms); descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
            resources_pass.buffer = require_dawn_resource(wgpuDeviceCreateBuffer(device, &descriptor), "UI filter uniforms");
            WGPUBindGroupEntry uniform_entry = WGPU_BIND_GROUP_ENTRY_INIT;
            uniform_entry.binding = 0; uniform_entry.buffer = resources_pass.buffer; uniform_entry.size = sizeof(draw.uniforms);
            WGPUBindGroupDescriptor group = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
            group.layout = resources.uniform_layout; group.entryCount = 1; group.entries = &uniform_entry;
            resources_pass.uniform_group = require_dawn_resource(wgpuDeviceCreateBindGroup(device, &group), "UI filter uniform group");
        }
        wgpuQueueWriteBuffer(queue, resources_pass.buffer, 0, &draw.uniforms, sizeof(draw.uniforms));
        const auto source_view = textures.get(draw.input).value.view;
        const auto shadow_view = textures.get(draw.secondary).value.view;
        if (!resources_pass.texture_group || resources_pass.source != source_view || resources_pass.shadow != shadow_view || resources_pass.sampler != sampler) {
            if (resources_pass.texture_group) wgpuBindGroupRelease(resources_pass.texture_group);
            std::array<WGPUBindGroupEntry, 4> entries{};
            for (std::uint32_t binding = 0; binding < entries.size(); ++binding) {
                entries[binding] = WGPU_BIND_GROUP_ENTRY_INIT; entries[binding].binding = binding;
        }
        entries[0].textureView = source_view; entries[1].sampler = sampler;
        entries[2].textureView = shadow_view; entries[3].sampler = sampler;
        WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        descriptor.layout = resources.texture_layout; descriptor.entryCount = entries.size(); descriptor.entries = entries.data();
        resources_pass.texture_group = require_dawn_resource(wgpuDeviceCreateBindGroup(device, &descriptor), "UI filter texture group");
        resources_pass.source = source_view; resources_pass.shadow = shadow_view; resources_pass.sampler = sampler;
        }
        WGPURenderPassColorAttachment attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        attachment.view = output.value.view; attachment.loadOp = WGPULoadOp_Clear; attachment.storeOp = WGPUStoreOp_Store;
        WGPURenderPassDescriptor pass_descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        pass_descriptor.colorAttachmentCount = 1; pass_descriptor.colorAttachments = &attachment;
        DawnRenderPass pass{wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor)};
        wgpuRenderPassEncoderSetPipeline(pass, resources.pipeline);
        wgpuRenderPassEncoderSetBindGroup(pass, 2, resources_pass.texture_group, 0, nullptr);
        wgpuRenderPassEncoderSetBindGroup(pass, 3, resources_pass.uniform_group, 0, nullptr);
        wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
        wgpuRenderPassEncoderEnd(pass); pass.reset();
    }
    WGPURenderPassColorAttachment attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    attachment.view = destination.view; attachment.loadOp = WGPULoadOp_Load; attachment.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    descriptor.colorAttachmentCount = 1; descriptor.colorAttachments = &attachment;
    DawnRenderPass pass{wgpuCommandEncoderBeginRenderPass(encoder, &descriptor)};
    wgpuRenderPassEncoderSetPipeline(pass, composite_pipeline);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, screen_group, 0, nullptr);
    wgpuRenderPassEncoderSetBindGroup(pass, 1, textures.get(plan.result).value.group, 0, nullptr);
    wgpuRenderPassEncoderSetVertexBuffer(pass, 0, vertices, 0, WGPU_WHOLE_SIZE);
    wgpuRenderPassEncoderSetIndexBuffer(pass, indices, WGPUIndexFormat_Uint32, 0, WGPU_WHOLE_SIZE);
    wgpuRenderPassEncoderDrawIndexed(pass, composite.index_count, 1, composite.first_index, 0, 0);
    wgpuRenderPassEncoderEnd(pass); pass.reset();
    textures.finish([](auto& target) { target.release(); });
}

} // namespace bbl::pal

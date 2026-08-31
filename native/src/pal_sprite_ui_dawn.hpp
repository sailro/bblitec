#pragma once

// Direct Dawn realization of the backend-neutral RmlUi recorder for the
// standalone SpriteRenderer frame driver. Sprite-only scenes render to a
// single-sample surface, so the recorder's premultiplied geometry can be
// blended into that surface after the sprite passes.

#include <bblite/pal_ui.hpp>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <unordered_map>

#include "pal_dawn_shared.hpp"

namespace bbl::pal {

struct SpriteUiDawnTexture {
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

struct SpriteUiDawnResources {
    WGPUBindGroupLayout screen_layout = nullptr;
    WGPUBindGroupLayout texture_layout = nullptr;
    WGPUPipelineLayout texture_pipeline_layout = nullptr;
    WGPURenderPipeline color_pipeline = nullptr;
    WGPURenderPipeline texture_pipeline = nullptr;
    WGPUSampler sampler = nullptr;
    WGPUSampler nearest_sampler = nullptr;
    WGPUBuffer screen = nullptr;
    WGPUBindGroup screen_group = nullptr;
    WGPUBuffer vertices = nullptr;
    WGPUBuffer indices = nullptr;
    std::unordered_map<std::uint64_t, SpriteUiDawnTexture> textures;
    std::uint64_t vertex_capacity = 0;
    std::uint64_t index_capacity = 0;
};

inline WGPUShaderModule create_sprite_ui_dawn_module(WGPUDevice device) {
    static constexpr char source[] = R"wgsl(
struct Screen {
    size: vec2<f32>,
    padding: vec2<f32>,
};

@group(0) @binding(0) var<uniform> screen: Screen;
@group(1) @binding(0) var ui_texture: texture_2d<f32>;
@group(1) @binding(1) var ui_sampler: sampler;

struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) uv: vec2<f32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) uv: vec2<f32>,
};

@vertex
fn vs(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4<f32>(
        input.position.x * 2.0 / screen.size.x - 1.0,
        1.0 - input.position.y * 2.0 / screen.size.y,
        0.0,
        1.0);
    output.color = input.color;
    output.uv = input.uv;
    return output;
}

@fragment
fn fs_color(input: VertexOutput) -> @location(0) vec4<f32> {
    return input.color;
}

@fragment
fn fs_texture(input: VertexOutput) -> @location(0) vec4<f32> {
    return input.color * textureSample(ui_texture, ui_sampler, input.uv);
}
)wgsl";
    WGPUShaderSourceWGSL wgsl = WGPU_SHADER_SOURCE_WGSL_INIT;
    wgsl.code = WGPUStringView{source, sizeof(source) - 1};
    WGPUShaderModuleDescriptor descriptor{};
    descriptor.nextInChain = &wgsl.chain;
    descriptor.label = string_view("bblite-sprite-ui");
    WGPUShaderModule module =
        wgpuDeviceCreateShaderModule(device, &descriptor);
    if (!module) dawn_error("wgpuDeviceCreateShaderModule sprite UI");
    return module;
}

inline WGPURenderPipeline create_sprite_ui_dawn_pipeline(
    WGPUDevice device,
    WGPUShaderModule module,
    const char* fragment_entry,
    WGPUTextureFormat format,
    WGPUPipelineLayout layout) {
    std::array<WGPUVertexAttribute, 3> attributes{};
    attributes[0] = WGPU_VERTEX_ATTRIBUTE_INIT;
    attributes[0].format = WGPUVertexFormat_Float32x2;
    attributes[0].offset = offsetof(UiRenderVertex, x);
    attributes[0].shaderLocation = 0;
    attributes[1] = WGPU_VERTEX_ATTRIBUTE_INIT;
    attributes[1].format = WGPUVertexFormat_Unorm8x4;
    attributes[1].offset = offsetof(UiRenderVertex, red);
    attributes[1].shaderLocation = 1;
    attributes[2] = WGPU_VERTEX_ATTRIBUTE_INIT;
    attributes[2].format = WGPUVertexFormat_Float32x2;
    attributes[2].offset = offsetof(UiRenderVertex, u);
    attributes[2].shaderLocation = 2;
    WGPUVertexBufferLayout vertex_layout{};
    vertex_layout.arrayStride = sizeof(UiRenderVertex);
    vertex_layout.stepMode = WGPUVertexStepMode_Vertex;
    vertex_layout.attributeCount = attributes.size();
    vertex_layout.attributes = attributes.data();

    WGPUBlendState blend{};
    blend.color.operation = WGPUBlendOperation_Add;
    blend.color.srcFactor = WGPUBlendFactor_One;
    blend.color.dstFactor = WGPUBlendFactor_OneMinusSrcAlpha;
    blend.alpha.operation = WGPUBlendOperation_Add;
    blend.alpha.srcFactor = WGPUBlendFactor_One;
    blend.alpha.dstFactor = WGPUBlendFactor_OneMinusSrcAlpha;
    WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
    target.format = format;
    target.blend = &blend;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = module;
    fragment.entryPoint = string_view(fragment_entry);
    fragment.targetCount = 1;
    fragment.targets = &target;
    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = layout;
    descriptor.vertex.module = module;
    descriptor.vertex.entryPoint = string_view("vs");
    descriptor.vertex.bufferCount = 1;
    descriptor.vertex.buffers = &vertex_layout;
    descriptor.fragment = &fragment;
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.cullMode = WGPUCullMode_None;
    descriptor.multisample.count = 1;
    descriptor.multisample.mask = ~0u;
    WGPURenderPipeline pipeline =
        wgpuDeviceCreateRenderPipeline(device, &descriptor);
    if (!pipeline) dawn_error("wgpuDeviceCreateRenderPipeline sprite UI");
    return pipeline;
}

inline WGPUBuffer create_sprite_ui_dawn_buffer(
    WGPUDevice device,
    WGPUBufferUsage usage,
    std::uint64_t size) {
    WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
    descriptor.usage = usage | WGPUBufferUsage_CopyDst;
    descriptor.size = (size + 3) & ~3ull;
    WGPUBuffer buffer = wgpuDeviceCreateBuffer(device, &descriptor);
    if (!buffer) dawn_error("wgpuDeviceCreateBuffer sprite UI");
    return buffer;
}

inline WGPUBindGroup create_sprite_ui_dawn_texture_group(
    DawnDevice& state,
    SpriteUiDawnResources& ui,
    WGPUTextureView view,
    WGPUSampler sampler) {
    std::array<WGPUBindGroupEntry, 2> entries{};
    entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
    entries[0].binding = 0;
    entries[0].textureView = view;
    entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
    entries[1].binding = 1;
    entries[1].sampler = sampler;
    WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    descriptor.layout = ui.texture_layout;
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    WGPUBindGroup group =
        wgpuDeviceCreateBindGroup(state.device, &descriptor);
    if (!group) dawn_error("wgpuDeviceCreateBindGroup sprite UI texture");
    return group;
}

inline void create_sprite_ui_dawn_resources(
    DawnDevice& state,
    SpriteUiDawnResources& ui) {
    if (ui.color_pipeline) return;
    WGPUBindGroupLayoutEntry screen_entry =
        WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    screen_entry.binding = 0;
    screen_entry.visibility = WGPUShaderStage_Vertex;
    screen_entry.buffer.type = WGPUBufferBindingType_Uniform;
    screen_entry.buffer.minBindingSize = 16;
    WGPUBindGroupLayoutDescriptor screen_descriptor =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    screen_descriptor.entryCount = 1;
    screen_descriptor.entries = &screen_entry;
    ui.screen_layout =
        wgpuDeviceCreateBindGroupLayout(state.device, &screen_descriptor);
    if (!ui.screen_layout) dawn_error("sprite UI screen layout");

    std::array<WGPUBindGroupLayoutEntry, 2> texture_entries{};
    texture_entries[0] = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    texture_entries[0].binding = 0;
    texture_entries[0].visibility = WGPUShaderStage_Fragment;
    texture_entries[0].texture.sampleType = WGPUTextureSampleType_Float;
    texture_entries[0].texture.viewDimension = WGPUTextureViewDimension_2D;
    texture_entries[1] = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    texture_entries[1].binding = 1;
    texture_entries[1].visibility = WGPUShaderStage_Fragment;
    texture_entries[1].sampler.type = WGPUSamplerBindingType_Filtering;
    WGPUBindGroupLayoutDescriptor texture_descriptor =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    texture_descriptor.entryCount = texture_entries.size();
    texture_descriptor.entries = texture_entries.data();
    ui.texture_layout =
        wgpuDeviceCreateBindGroupLayout(state.device, &texture_descriptor);
    if (!ui.texture_layout) dawn_error("sprite UI texture layout");

    const std::array<WGPUBindGroupLayout, 2> texture_layouts{
        ui.screen_layout,
        ui.texture_layout};
    WGPUPipelineLayoutDescriptor texture_pipeline_descriptor =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    texture_pipeline_descriptor.bindGroupLayoutCount = texture_layouts.size();
    texture_pipeline_descriptor.bindGroupLayouts = texture_layouts.data();
    ui.texture_pipeline_layout = wgpuDeviceCreatePipelineLayout(
        state.device, &texture_pipeline_descriptor);
    if (!ui.texture_pipeline_layout) {
        dawn_error("sprite UI texture pipeline layout");
    }

    WGPUShaderModule module = create_sprite_ui_dawn_module(state.device);
    WGPUPipelineLayoutDescriptor color_layout_descriptor =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    color_layout_descriptor.bindGroupLayoutCount = 1;
    color_layout_descriptor.bindGroupLayouts = &ui.screen_layout;
    WGPUPipelineLayout color_layout = wgpuDeviceCreatePipelineLayout(
        state.device, &color_layout_descriptor);
    if (!color_layout) dawn_error("sprite UI color pipeline layout");
    ui.color_pipeline = create_sprite_ui_dawn_pipeline(
        state.device,
        module,
        "fs_color",
        state.surface_format,
        color_layout);
    ui.texture_pipeline = create_sprite_ui_dawn_pipeline(
        state.device,
        module,
        "fs_texture",
        state.surface_format,
        ui.texture_pipeline_layout);
    wgpuPipelineLayoutRelease(color_layout);
    wgpuShaderModuleRelease(module);

    WGPUSamplerDescriptor sampler = WGPU_SAMPLER_DESCRIPTOR_INIT;
    sampler.minFilter = WGPUFilterMode_Linear;
    sampler.magFilter = WGPUFilterMode_Linear;
    sampler.mipmapFilter = WGPUMipmapFilterMode_Nearest;
    sampler.addressModeU = WGPUAddressMode_ClampToEdge;
    sampler.addressModeV = WGPUAddressMode_ClampToEdge;
    sampler.addressModeW = WGPUAddressMode_ClampToEdge;
    ui.sampler = wgpuDeviceCreateSampler(state.device, &sampler);
    if (!ui.sampler) dawn_error("wgpuDeviceCreateSampler sprite UI");
    sampler.minFilter = WGPUFilterMode_Nearest;
    sampler.magFilter = WGPUFilterMode_Nearest;
    ui.nearest_sampler = wgpuDeviceCreateSampler(state.device, &sampler);
    if (!ui.nearest_sampler) {
        dawn_error("wgpuDeviceCreateSampler sprite UI nearest");
    }

    ui.screen = create_sprite_ui_dawn_buffer(
        state.device, WGPUBufferUsage_Uniform, 16);
    WGPUBindGroupEntry screen_binding = WGPU_BIND_GROUP_ENTRY_INIT;
    screen_binding.binding = 0;
    screen_binding.buffer = ui.screen;
    screen_binding.size = 16;
    WGPUBindGroupDescriptor screen_group = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    screen_group.layout = ui.screen_layout;
    screen_group.entryCount = 1;
    screen_group.entries = &screen_binding;
    ui.screen_group =
        wgpuDeviceCreateBindGroup(state.device, &screen_group);
    if (!ui.screen_group) dawn_error("wgpuDeviceCreateBindGroup sprite UI");
}

inline void ensure_sprite_ui_dawn_buffer(
    WGPUDevice device,
    WGPUBuffer& buffer,
    std::uint64_t& capacity,
    std::uint64_t required,
    WGPUBufferUsage usage) {
    if (buffer && capacity >= required) return;
    if (buffer) wgpuBufferRelease(buffer);
    capacity = std::max<std::uint64_t>(4096, capacity);
    while (capacity < required) capacity *= 2;
    buffer = create_sprite_ui_dawn_buffer(device, usage, capacity);
}

inline void render_sprite_ui_dawn_frame(
    DawnDevice& state,
    WGPUCommandEncoder encoder,
    WGPUTextureView target,
    SpriteUiDawnResources& ui,
    const UiRenderFrame& frame) {
    if (frame.draws.empty() || frame.width == 0 || frame.height == 0) return;
    create_sprite_ui_dawn_resources(state, ui);
    const std::uint64_t vertex_bytes =
        frame.vertices.size() * sizeof(UiRenderVertex);
    const std::uint64_t index_bytes =
        frame.indices.size() * sizeof(std::uint32_t);
    ensure_sprite_ui_dawn_buffer(
        state.device,
        ui.vertices,
        ui.vertex_capacity,
        vertex_bytes,
        WGPUBufferUsage_Vertex);
    ensure_sprite_ui_dawn_buffer(
        state.device,
        ui.indices,
        ui.index_capacity,
        index_bytes,
        WGPUBufferUsage_Index);
    wgpuQueueWriteBuffer(
        state.queue,
        ui.vertices,
        0,
        frame.vertices.data(),
        vertex_bytes);
    wgpuQueueWriteBuffer(
        state.queue,
        ui.indices,
        0,
        frame.indices.data(),
        index_bytes);
    const std::array<float, 4> screen{
        static_cast<float>(frame.width),
        static_cast<float>(frame.height),
        0,
        0};
    wgpuQueueWriteBuffer(
        state.queue, ui.screen, 0, screen.data(), sizeof(screen));

    for (auto texture = ui.textures.begin(); texture != ui.textures.end();) {
        if (ui_frame_uses_texture(frame, texture->first)) {
            ++texture;
            continue;
        }
        texture->second.release();
        texture = ui.textures.erase(texture);
    }
    for (const UiRenderTexture& source : frame.textures) {
        if (ui.textures.contains(source.id) || !source.rgba) continue;
        SpriteUiDawnTexture texture;
        texture.texture = upload_dawn_rgba_texture(
            state.device,
            state.queue,
            source.rgba->data(),
            source.rgba->size(),
            source.width,
            source.height);
        texture.view = wgpuTextureCreateView(texture.texture, nullptr);
        if (!texture.view) dawn_error("wgpuTextureCreateView sprite UI");
        texture.group = create_sprite_ui_dawn_texture_group(
            state, ui, texture.view, ui.sampler);
        texture.nearest_group = create_sprite_ui_dawn_texture_group(
            state, ui, texture.view, ui.nearest_sampler);
        ui.textures.emplace(source.id, texture);
    }

    WGPURenderPassColorAttachment attachment =
        WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    attachment.view = target;
    attachment.loadOp = WGPULoadOp_Load;
    attachment.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor descriptor =
        WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    descriptor.colorAttachmentCount = 1;
    descriptor.colorAttachments = &attachment;
    WGPURenderPassEncoder pass =
        wgpuCommandEncoderBeginRenderPass(encoder, &descriptor);
    wgpuRenderPassEncoderSetBindGroup(
        pass, 0, ui.screen_group, 0, nullptr);
    wgpuRenderPassEncoderSetVertexBuffer(
        pass, 0, ui.vertices, 0, WGPU_WHOLE_SIZE);
    wgpuRenderPassEncoderSetIndexBuffer(
        pass,
        ui.indices,
        WGPUIndexFormat_Uint32,
        0,
        WGPU_WHOLE_SIZE);
    for (const UiRenderDraw& draw : frame.draws) {
        const int left = std::clamp(
            draw.scissor_x, 0, static_cast<int>(frame.width));
        const int top = std::clamp(
            draw.scissor_y, 0, static_cast<int>(frame.height));
        const int right = std::clamp(
            draw.scissor_x + static_cast<int>(draw.scissor_width),
            0,
            static_cast<int>(frame.width));
        const int bottom = std::clamp(
            draw.scissor_y + static_cast<int>(draw.scissor_height),
            0,
            static_cast<int>(frame.height));
        if (right <= left || bottom <= top || draw.index_count == 0) continue;
        wgpuRenderPassEncoderSetScissorRect(
            pass,
            static_cast<std::uint32_t>(left),
            static_cast<std::uint32_t>(top),
            static_cast<std::uint32_t>(right - left),
            static_cast<std::uint32_t>(bottom - top));
        if (draw.texture_id) {
            const auto texture = ui.textures.find(draw.texture_id);
            if (texture == ui.textures.end()) continue;
            wgpuRenderPassEncoderSetPipeline(pass, ui.texture_pipeline);
            wgpuRenderPassEncoderSetBindGroup(
                pass,
                1,
                draw.nearest_sampling
                    ? texture->second.nearest_group
                    : texture->second.group,
                0,
                nullptr);
        } else {
            wgpuRenderPassEncoderSetPipeline(pass, ui.color_pipeline);
        }
        wgpuRenderPassEncoderDrawIndexed(
            pass, draw.index_count, 1, draw.first_index, 0, 0);
    }
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);
}

inline void release_sprite_ui_dawn_resources(
    SpriteUiDawnResources& ui) {
    for (auto& [id, source] : ui.textures) {
        static_cast<void>(id);
        source.release();
    }
    if (ui.indices) wgpuBufferRelease(ui.indices);
    if (ui.vertices) wgpuBufferRelease(ui.vertices);
    if (ui.screen_group) wgpuBindGroupRelease(ui.screen_group);
    if (ui.screen) wgpuBufferRelease(ui.screen);
    if (ui.sampler) wgpuSamplerRelease(ui.sampler);
    if (ui.nearest_sampler) wgpuSamplerRelease(ui.nearest_sampler);
    if (ui.texture_pipeline) wgpuRenderPipelineRelease(ui.texture_pipeline);
    if (ui.color_pipeline) wgpuRenderPipelineRelease(ui.color_pipeline);
    if (ui.texture_pipeline_layout) {
        wgpuPipelineLayoutRelease(ui.texture_pipeline_layout);
    }
    if (ui.texture_layout) wgpuBindGroupLayoutRelease(ui.texture_layout);
    if (ui.screen_layout) wgpuBindGroupLayoutRelease(ui.screen_layout);
    ui = {};
}

} // namespace bbl::pal

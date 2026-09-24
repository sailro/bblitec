#pragma once

// The Dawn realization of the backend-neutral RmlUi recorder, shared by every
// consumer: the scene renderer, the standalone SpriteRenderer frame driver and
// the Window presenter. The recorder's geometry is premultiplied. A
// single-sample consumer blends each draw directly into its target; the scene
// renderer names a layer sample count, and each segment then renders into a
// transparent RGBA8 layer at that count, resolves, and composites once over
// the target.

#include <bblite/pal_ui.hpp>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <type_traits>
#include <unordered_map>

// The backend-neutral scissor clamp all RmlUi consumers share.
#include "pal_gpu_shared.hpp"
#include "pal_dawn_shared.hpp"
#include "pal_ui_backdrop_dawn.hpp"
#include "pal_ui_filter_dawn.hpp"
#include "pal_ui_texture_cache.hpp"

namespace bbl::pal {

using SpriteUiDawnTexture = UiDawnTexture;

/** A layered consumer's transparent layer, recreated when the frame resizes. */
struct SpriteUiDawnLayer {
    WGPUTexture texture = nullptr;
    WGPUTextureView view = nullptr;
    WGPUTexture multisample = nullptr;
    WGPUTextureView multisample_view = nullptr;
    WGPUBindGroup group = nullptr;
    std::uint32_t width = 0;
    std::uint32_t height = 0;

    void release() noexcept {
        if (group)
            wgpuBindGroupRelease(group);
        if (multisample_view)
            wgpuTextureViewRelease(multisample_view);
        if (multisample)
            wgpuTextureRelease(multisample);
        if (view)
            wgpuTextureViewRelease(view);
        if (texture)
            wgpuTextureRelease(texture);
        *this = {};
    }
};

struct SpriteUiDawnResources {
    UiBackdropDawnResources backdrop;
    UiFilterDawnResources filters;
    WGPUBindGroupLayout screen_layout = nullptr;
    WGPUBindGroupLayout texture_layout = nullptr;
    WGPUPipelineLayout texture_pipeline_layout = nullptr;
    // The draws' pipelines, in the target's format or the layer's.
    WGPURenderPipeline color_pipeline = nullptr;
    WGPURenderPipeline texture_pipeline = nullptr;
    // A layered consumer's single-sample texture pipeline in the target's
    // format; a direct consumer's `texture_pipeline` already is that one.
    WGPURenderPipeline composite_pipeline = nullptr;
    WGPUSampler sampler = nullptr;
    WGPUSampler nearest_sampler = nullptr;
    WGPUBuffer screen = nullptr;
    WGPUBindGroup screen_group = nullptr;
    WGPUBuffer vertices = nullptr;
    WGPUBuffer indices = nullptr;
    SpriteUiDawnLayer layer;
    std::unordered_map<std::uint64_t, UiCachedTexture<SpriteUiDawnTexture>> textures;
    std::uint64_t vertex_capacity = 0;
    std::uint64_t index_capacity = 0;
};

/** The single-sample texture pipeline in the target's format. */
inline WGPURenderPipeline sprite_ui_dawn_target_pipeline(const SpriteUiDawnResources& ui) {
    return ui.composite_pipeline ? ui.composite_pipeline : ui.texture_pipeline;
}

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
    descriptor.label = string_view("bblite-ui");
    DawnShaderModule module{wgpuDeviceCreateShaderModule(device, &descriptor)};
    if (!module)
        dawn_error("wgpuDeviceCreateShaderModule UI");
    return module.release();
}

inline WGPURenderPipeline create_sprite_ui_dawn_pipeline(WGPUDevice device, WGPUShaderModule module,
                                                         const char* fragment_entry,
                                                         WGPUTextureFormat format,
                                                         std::uint32_t samples,
                                                         WGPUPipelineLayout layout,
                                                         bool additive = false) {
    auto attributes = vertex_attribute_array<3>();
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
    blend.color.dstFactor = additive ? WGPUBlendFactor_One : WGPUBlendFactor_OneMinusSrcAlpha;
    blend.alpha.operation = WGPUBlendOperation_Add;
    blend.alpha.srcFactor = WGPUBlendFactor_One;
    blend.alpha.dstFactor = additive ? WGPUBlendFactor_One : WGPUBlendFactor_OneMinusSrcAlpha;
    WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
    target.format = format;
    target.blend = &blend;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = module;
    fragment.entryPoint = string_view(fragment_entry);
    fragment.targetCount = 1;
    fragment.targets = &target;
    WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = layout;
    descriptor.vertex.module = module;
    descriptor.vertex.entryPoint = string_view("vs");
    descriptor.vertex.bufferCount = 1;
    descriptor.vertex.buffers = &vertex_layout;
    descriptor.fragment = &fragment;
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.cullMode = WGPUCullMode_None;
    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    DawnRenderPipeline pipeline{wgpuDeviceCreateRenderPipeline(device, &descriptor)};
    if (!pipeline)
        dawn_error("wgpuDeviceCreateRenderPipeline UI");
    return pipeline.release();
}

inline WGPUBuffer create_sprite_ui_dawn_buffer(WGPUDevice device, WGPUBufferUsage usage,
                                               std::uint64_t size) {
    WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
    descriptor.usage = usage | WGPUBufferUsage_CopyDst;
    descriptor.size = (size + 3) & ~3ull;
    DawnBuffer buffer{wgpuDeviceCreateBuffer(device, &descriptor)};
    if (!buffer)
        dawn_error("wgpuDeviceCreateBuffer UI");
    return buffer.release();
}

inline WGPUBindGroup create_sprite_ui_dawn_texture_group(DawnDevice& state,
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
    DawnBindGroup group{wgpuDeviceCreateBindGroup(state.device, &descriptor)};
    if (!group)
        dawn_error("wgpuDeviceCreateBindGroup UI texture");
    return group.release();
}

inline void create_sprite_ui_dawn_resources(DawnDevice& state, SpriteUiDawnResources& ui,
                                            std::optional<std::uint32_t> layer_samples) {
    if (ui.color_pipeline)
        return;
    WGPUBindGroupLayoutEntry screen_entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    screen_entry.binding = 0;
    screen_entry.visibility = WGPUShaderStage_Vertex;
    screen_entry.buffer.type = WGPUBufferBindingType_Uniform;
    screen_entry.buffer.minBindingSize = 16;
    WGPUBindGroupLayoutDescriptor screen_descriptor = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    screen_descriptor.entryCount = 1;
    screen_descriptor.entries = &screen_entry;
    ui.screen_layout = wgpuDeviceCreateBindGroupLayout(state.device, &screen_descriptor);
    if (!ui.screen_layout)
        dawn_error("UI screen bind group layout");

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
    WGPUBindGroupLayoutDescriptor texture_descriptor = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    texture_descriptor.entryCount = texture_entries.size();
    texture_descriptor.entries = texture_entries.data();
    ui.texture_layout = wgpuDeviceCreateBindGroupLayout(state.device, &texture_descriptor);
    if (!ui.texture_layout)
        dawn_error("UI texture bind group layout");

    const std::array<WGPUBindGroupLayout, 2> texture_layouts{ui.screen_layout, ui.texture_layout};
    WGPUPipelineLayoutDescriptor texture_pipeline_descriptor = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    texture_pipeline_descriptor.bindGroupLayoutCount = texture_layouts.size();
    texture_pipeline_descriptor.bindGroupLayouts = texture_layouts.data();
    ui.texture_pipeline_layout =
        wgpuDeviceCreatePipelineLayout(state.device, &texture_pipeline_descriptor);
    if (!ui.texture_pipeline_layout)
        dawn_error("UI texture pipeline layout");

    WGPUShaderModule module = create_sprite_ui_dawn_module(state.device);
    WGPUPipelineLayoutDescriptor color_layout_descriptor = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    color_layout_descriptor.bindGroupLayoutCount = 1;
    color_layout_descriptor.bindGroupLayouts = &ui.screen_layout;
    DawnPipelineLayout color_layout{
        wgpuDeviceCreatePipelineLayout(state.device, &color_layout_descriptor)};
    if (!color_layout)
        dawn_error("UI color pipeline layout");
    const WGPUTextureFormat draw_format =
        layer_samples ? WGPUTextureFormat_RGBA8Unorm : state.surface_format;
    const std::uint32_t draw_samples = layer_samples.value_or(1u);
    ui.color_pipeline = create_sprite_ui_dawn_pipeline(state.device, module, "fs_color",
                                                       draw_format, draw_samples, color_layout);
    ui.texture_pipeline = create_sprite_ui_dawn_pipeline(
        state.device, module, "fs_texture", draw_format, draw_samples, ui.texture_pipeline_layout);
    if (layer_samples) {
        ui.composite_pipeline =
            create_sprite_ui_dawn_pipeline(state.device, module, "fs_texture", state.surface_format,
                                           1, ui.texture_pipeline_layout);
    }
    color_layout.reset();
    wgpuShaderModuleRelease(module);

    WGPUSamplerDescriptor sampler = WGPU_SAMPLER_DESCRIPTOR_INIT;
    sampler.minFilter = WGPUFilterMode_Linear;
    sampler.magFilter = WGPUFilterMode_Linear;
    sampler.mipmapFilter = WGPUMipmapFilterMode_Nearest;
    sampler.addressModeU = WGPUAddressMode_ClampToEdge;
    sampler.addressModeV = WGPUAddressMode_ClampToEdge;
    sampler.addressModeW = WGPUAddressMode_ClampToEdge;
    ui.sampler = wgpuDeviceCreateSampler(state.device, &sampler);
    if (!ui.sampler)
        dawn_error("wgpuDeviceCreateSampler UI");
    sampler.minFilter = WGPUFilterMode_Nearest;
    sampler.magFilter = WGPUFilterMode_Nearest;
    ui.nearest_sampler = wgpuDeviceCreateSampler(state.device, &sampler);
    if (!ui.nearest_sampler)
        dawn_error("wgpuDeviceCreateSampler UI nearest");

    ui.screen = create_sprite_ui_dawn_buffer(state.device, WGPUBufferUsage_Uniform, 16);
    WGPUBindGroupEntry screen_binding = WGPU_BIND_GROUP_ENTRY_INIT;
    screen_binding.binding = 0;
    screen_binding.buffer = ui.screen;
    screen_binding.size = 16;
    WGPUBindGroupDescriptor screen_group = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    screen_group.layout = ui.screen_layout;
    screen_group.entryCount = 1;
    screen_group.entries = &screen_binding;
    ui.screen_group = wgpuDeviceCreateBindGroup(state.device, &screen_group);
    if (!ui.screen_group)
        dawn_error("wgpuDeviceCreateBindGroup UI screen");
}

inline void ensure_sprite_ui_dawn_backdrop_pipeline(DawnDevice& state, SpriteUiDawnResources& ui) {
    if (ui.backdrop.pipeline)
        return;
    WGPUShaderModule module = create_sprite_ui_dawn_module(state.device);
    ui.backdrop.pipeline = create_sprite_ui_dawn_pipeline(state.device, module, "fs_texture",
                                                          WGPUTextureFormat_RGBA16Float, 1,
                                                          ui.texture_pipeline_layout, true);
    wgpuShaderModuleRelease(module);
}

inline void ensure_sprite_ui_dawn_layer(DawnDevice& state, SpriteUiDawnResources& ui,
                                        std::uint32_t samples, std::uint32_t width,
                                        std::uint32_t height) {
    SpriteUiDawnLayer& layer = ui.layer;
    if (layer.texture && layer.width == width && layer.height == height)
        return;
    layer.release();
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.dimension = WGPUTextureDimension_2D;
    descriptor.format = WGPUTextureFormat_RGBA8Unorm;
    descriptor.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding;
    descriptor.size = WGPUExtent3D{width, height, 1};
    descriptor.sampleCount = 1;
    layer.texture = wgpuDeviceCreateTexture(state.device, &descriptor);
    if (!layer.texture)
        dawn_error("wgpuDeviceCreateTexture UI layer");
    layer.view = create_dawn_texture_view(layer.texture, nullptr);
    if (samples > 1) {
        descriptor.usage = WGPUTextureUsage_RenderAttachment;
        descriptor.sampleCount = samples;
        layer.multisample = wgpuDeviceCreateTexture(state.device, &descriptor);
        if (!layer.multisample)
            dawn_error("wgpuDeviceCreateTexture UI multisample layer");
        layer.multisample_view = create_dawn_texture_view(layer.multisample, nullptr);
    }
    layer.group = create_sprite_ui_dawn_texture_group(state, ui, layer.view, ui.sampler);
    layer.width = width;
    layer.height = height;
}

inline void ensure_sprite_ui_dawn_buffer(WGPUDevice device, WGPUBuffer& buffer,
                                         std::uint64_t& capacity, std::uint64_t required,
                                         WGPUBufferUsage usage) {
    if (buffer && capacity >= required)
        return;
    if (buffer)
        wgpuBufferRelease(buffer);
    capacity = std::max<std::uint64_t>(4096, capacity);
    while (capacity < required)
        capacity *= 2;
    buffer = create_sprite_ui_dawn_buffer(device, usage, capacity);
}

/**
 * Records one UI frame over `target`.
 *
 * `layer_samples` selects the composition: absent, each draw blends directly
 * into the target; present, each segment renders into the transparent layer
 * at that sample count and the resolved layer composites over the target. An
 * owner passes the same value every frame, because the pipelines keep it.
 */
template <typename ExternalTexture = std::nullptr_t>
inline void render_sprite_ui_dawn_frame(DawnDevice& state, WGPUCommandEncoder encoder,
                                        WGPUTexture target_texture, WGPUTextureView target,
                                        SpriteUiDawnResources& ui, const UiRenderFrame& frame,
                                        ExternalTexture external_texture = nullptr,
                                        std::optional<std::uint32_t> layer_samples = std::nullopt) {
    prune_ui_texture_cache(ui.textures, [](SpriteUiDawnTexture& texture) { texture.release(); });
    if ((frame.draws.empty() && frame.operations.empty()) || frame.width == 0 || frame.height == 0)
        return;
    create_sprite_ui_dawn_resources(state, ui, layer_samples);
    if (!frame.backdrops.empty())
        ensure_sprite_ui_dawn_backdrop_pipeline(state, ui);
    if (layer_samples)
        ensure_sprite_ui_dawn_layer(state, ui, *layer_samples, frame.width, frame.height);

    // The recorder appended the full-frame composite quad after the RmlUi
    // draws (`frame.composite_first_index` names it), so the aggregate
    // geometry uploads verbatim -- no per-frame copy on this side.
    const std::uint64_t vertex_bytes = frame.vertices.size() * sizeof(UiRenderVertex);
    const std::uint64_t index_bytes = frame.indices.size() * sizeof(std::uint32_t);
    ensure_sprite_ui_dawn_buffer(state.device, ui.vertices, ui.vertex_capacity, vertex_bytes,
                                 WGPUBufferUsage_Vertex);
    ensure_sprite_ui_dawn_buffer(state.device, ui.indices, ui.index_capacity, index_bytes,
                                 WGPUBufferUsage_Index);
    wgpuQueueWriteBuffer(state.queue, ui.vertices, 0, frame.vertices.data(), vertex_bytes);
    wgpuQueueWriteBuffer(state.queue, ui.indices, 0, frame.indices.data(), index_bytes);
    const std::array<float, 4> screen{static_cast<float>(frame.width),
                                      static_cast<float>(frame.height), 0, 0};
    wgpuQueueWriteBuffer(state.queue, ui.screen, 0, screen.data(), sizeof(screen));

    for (const UiRenderTexture& source : frame.textures) {
        if (ui.textures.contains(source.id) || !source.rgba)
            continue;
        SpriteUiDawnTexture texture;
        texture.texture =
            upload_dawn_rgba_texture(state.device, state.queue, source.rgba->data(),
                                     source.rgba->size(), source.width, source.height);
        texture.view = create_dawn_texture_view(texture.texture, nullptr);
        texture.group = create_sprite_ui_dawn_texture_group(state, ui, texture.view, ui.sampler);
        texture.nearest_group =
            create_sprite_ui_dawn_texture_group(state, ui, texture.view, ui.nearest_sampler);
        ui.textures.emplace(source.id, UiCachedTexture<SpriteUiDawnTexture>{texture, source.rgba});
    }

    const WGPURenderPipeline target_pipeline = sprite_ui_dawn_target_pipeline(ui);
    const UiDawnTexture root_target{target_texture, target, nullptr, nullptr};
    ui.filters.begin_frame();
    for_each_ui_segment(
        frame,
        [&](std::size_t draw_begin, std::size_t draw_end, std::uint32_t layer) {
            const auto draw_target =
                ui.filters.target(state.device, encoder, root_target, state.surface_format,
                                  ui.texture_layout, ui.sampler, frame, layer);
            WGPURenderPassColorAttachment attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
            if (layer_samples) {
                // The layer starts transparent for every segment; a
                // multisampled layer resolves into the sampled one.
                const SpriteUiDawnLayer& ui_layer = ui.layer;
                attachment.view =
                    ui_layer.multisample_view ? ui_layer.multisample_view : ui_layer.view;
                attachment.resolveTarget = ui_layer.multisample_view ? ui_layer.view : nullptr;
                attachment.loadOp = WGPULoadOp_Clear;
                attachment.storeOp =
                    ui_layer.multisample_view ? WGPUStoreOp_Discard : WGPUStoreOp_Store;
                attachment.clearValue = WGPUColor{0, 0, 0, 0};
            } else {
                attachment.view = draw_target.view;
                attachment.loadOp = WGPULoadOp_Load;
                attachment.storeOp = WGPUStoreOp_Store;
            }
            WGPURenderPassDescriptor descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
            descriptor.colorAttachmentCount = 1;
            descriptor.colorAttachments = &attachment;
            DawnRenderPass pass{wgpuCommandEncoderBeginRenderPass(encoder, &descriptor)};
            wgpuRenderPassEncoderSetBindGroup(pass, 0, ui.screen_group, 0, nullptr);
            wgpuRenderPassEncoderSetVertexBuffer(pass, 0, ui.vertices, 0, WGPU_WHOLE_SIZE);
            wgpuRenderPassEncoderSetIndexBuffer(pass, ui.indices, WGPUIndexFormat_Uint32, 0,
                                                WGPU_WHOLE_SIZE);
            for (std::size_t draw_index = draw_begin; draw_index < draw_end; ++draw_index) {
                const UiRenderDraw& draw = frame.draws[draw_index];
                const std::optional<UiScissorRect> scissor =
                    clamped_ui_scissor(draw, frame.width, frame.height);
                if (!scissor)
                    continue;
                wgpuRenderPassEncoderSetScissorRect(pass, static_cast<std::uint32_t>(scissor->left),
                                                    static_cast<std::uint32_t>(scissor->top),
                                                    static_cast<std::uint32_t>(scissor->width),
                                                    static_cast<std::uint32_t>(scissor->height));
                if (draw.texture_id) {
                    const auto owned = ui.textures.find(draw.texture_id);
                    const SpriteUiDawnTexture* texture =
                        owned == ui.textures.end() ? nullptr : &owned->second.resource;
                    if constexpr (!std::is_same_v<ExternalTexture, std::nullptr_t>) {
                        if (!texture)
                            texture = external_texture(draw.texture_id);
                    }
                    if (!texture)
                        continue;
                    wgpuRenderPassEncoderSetPipeline(pass, ui.texture_pipeline);
                    wgpuRenderPassEncoderSetBindGroup(
                        pass, 1, draw.nearest_sampling ? texture->nearest_group : texture->group, 0,
                        nullptr);
                } else {
                    wgpuRenderPassEncoderSetPipeline(pass, ui.color_pipeline);
                }
                count_gpu_draw(wgpuRenderPassEncoderDrawIndexed, pass, draw.index_count, 1,
                               draw.first_index, 0, 0);
            }
            wgpuRenderPassEncoderEnd(pass);
            pass.reset();
            if (!layer_samples)
                return;

            WGPURenderPassColorAttachment composite_attachment =
                WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
            composite_attachment.view = draw_target.view;
            composite_attachment.loadOp = WGPULoadOp_Load;
            composite_attachment.storeOp = WGPUStoreOp_Store;
            WGPURenderPassDescriptor composite_descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
            composite_descriptor.colorAttachmentCount = 1;
            composite_descriptor.colorAttachments = &composite_attachment;
            DawnRenderPass composite_pass{
                wgpuCommandEncoderBeginRenderPass(encoder, &composite_descriptor)};
            wgpuRenderPassEncoderSetPipeline(composite_pass, target_pipeline);
            wgpuRenderPassEncoderSetBindGroup(composite_pass, 0, ui.screen_group, 0, nullptr);
            wgpuRenderPassEncoderSetBindGroup(composite_pass, 1, ui.layer.group, 0, nullptr);
            wgpuRenderPassEncoderSetVertexBuffer(composite_pass, 0, ui.vertices, 0,
                                                 WGPU_WHOLE_SIZE);
            wgpuRenderPassEncoderSetIndexBuffer(composite_pass, ui.indices, WGPUIndexFormat_Uint32,
                                                0, WGPU_WHOLE_SIZE);
            wgpuRenderPassEncoderSetScissorRect(composite_pass, 0, 0, frame.width, frame.height);
            count_gpu_draw(wgpuRenderPassEncoderDrawIndexed, composite_pass, 6, 1,
                           frame.composite_first_index, 0, 0);
            wgpuRenderPassEncoderEnd(composite_pass);
            composite_pass.reset();
        },
        [&](const UiRenderOperation& operation) {
            if (operation.kind == UiRenderOperation::Kind::ResetLayer) {
                ui.filters.reset_layer(operation.index);
            } else if (operation.kind == UiRenderOperation::Kind::Backdrop) {
                render_ui_backdrop_dawn(state.device, encoder, target_texture, target,
                                        state.surface_format, ui.vertices, ui.indices, ui.sampler,
                                        ui.screen_group, ui.texture_layout, target_pipeline,
                                        ui.backdrop, frame, operation.index);
            } else {
                render_ui_composite_dawn(state.device, state.queue, encoder, root_target,
                                         state.surface_format, ui.vertices, ui.indices, ui.sampler,
                                         ui.screen_group, ui.texture_layout, target_pipeline,
                                         ui.filters, frame, operation.index);
            }
        });
    ui.filters.finish_frame(frame.composites.size());
}

inline void release_sprite_ui_dawn_resources(SpriteUiDawnResources& ui) {
    ui.backdrop.release();
    ui.filters.release();
    for (auto& [id, source] : ui.textures) {
        static_cast<void>(id);
        source.resource.release();
    }
    ui.layer.release();
    if (ui.indices)
        wgpuBufferRelease(ui.indices);
    if (ui.vertices)
        wgpuBufferRelease(ui.vertices);
    if (ui.screen_group)
        wgpuBindGroupRelease(ui.screen_group);
    if (ui.screen)
        wgpuBufferRelease(ui.screen);
    if (ui.sampler)
        wgpuSamplerRelease(ui.sampler);
    if (ui.nearest_sampler)
        wgpuSamplerRelease(ui.nearest_sampler);
    if (ui.composite_pipeline)
        wgpuRenderPipelineRelease(ui.composite_pipeline);
    if (ui.texture_pipeline)
        wgpuRenderPipelineRelease(ui.texture_pipeline);
    if (ui.color_pipeline)
        wgpuRenderPipelineRelease(ui.color_pipeline);
    if (ui.texture_pipeline_layout)
        wgpuPipelineLayoutRelease(ui.texture_pipeline_layout);
    if (ui.texture_layout)
        wgpuBindGroupLayoutRelease(ui.texture_layout);
    if (ui.screen_layout)
        wgpuBindGroupLayoutRelease(ui.screen_layout);
    ui = {};
}

} // namespace bbl::pal

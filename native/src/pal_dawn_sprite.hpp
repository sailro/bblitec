#pragma once

// The pure-2D sprite pass on Dawn (WebGPU).
//
// The mirror of `pal_sdl_gpu_sprite.hpp` for this backend, and separate from
// it for the same reason the two renderers are separate: a `SpriteRenderer`
// is a rendering CONTEXT on the engine, so the drawing has to be recordable
// into a frame somebody else owns. Upstream's loop walks
// `engine._renderingContexts` calling `_update` then `_record`, which is how
// a `SceneContext` and a `SpriteRenderer` share one frame (scene 52).
//
//   `upload_dawn_sprite_pass`  — `_update`: dirty instance data and the
//                                per-layer UBO, which the pinned
//                                `uploadLayer` also builds here because it
//                                depends on the render-target size.
//   `record_dawn_sprite_pass`  — `_record`: bind and draw into a render pass
//                                the caller opened.
//
// Dawn only. Nothing here is shared with SDL_GPU.
//
// The generated WGSL is SDL_GPU-specialized — the layer UBO is declared once
// per stage at `@group(1)` and `@group(3)`, and the atlas pair at
// `@group(2)` — so the bind groups follow that grouping and the same 64
// bytes reach both uniform buffers.

#include <bblite/runtime.hpp>
#include <bblite/upstream/sprite_layer.hpp>

#include <algorithm>
#include <array>
#include <cstdint>
#include <stdexcept>
#include <vector>

#include "pal_dawn_shared.hpp"
#include "pal_gpu_shared.hpp"

namespace bbl::pal {
/** Per-layer GPU state, matching the pinned `LayerGpu`. */
struct DawnSpriteLayer {
    // One pipeline per layer: the uvScroll opt-in widens a layer's stride
    // and adds an attribute, so the layout a pipeline describes is the
    // layer's, not the renderer's.
    WGPURenderPipeline pipeline = nullptr;
    WGPUBuffer instances = nullptr;
    WGPUBuffer vertex_uniforms = nullptr;
    WGPUBuffer fragment_uniforms = nullptr;
    WGPUTexture atlas = nullptr;
    WGPUTextureView atlas_view = nullptr;
    WGPUSampler sampler = nullptr;
    WGPUBindGroup vertex_group = nullptr;
    WGPUBindGroup texture_group = nullptr;
    WGPUBindGroup fragment_group = nullptr;
    std::uint64_t uploaded_version = 0;
    bool uploaded = false;
};

/** One registered `SpriteRenderer`, as GPU resources. */
struct DawnSpritePass {
    WGPUBuffer index_buffer = nullptr;
    std::array<WGPUBindGroupLayout, 4> group_layouts{};
    std::vector<DawnSpriteLayer> layers;
    SpriteRendererHandle renderer{};
};

inline WGPUBlendFactor dawn_sprite_blend_factor(SpriteBlendFactor factor) {
    switch (factor) {
        case SpriteBlendFactor::zero:
            return WGPUBlendFactor_Zero;
        case SpriteBlendFactor::one:
            return WGPUBlendFactor_One;
        case SpriteBlendFactor::src_alpha:
            return WGPUBlendFactor_SrcAlpha;
        case SpriteBlendFactor::one_minus_src_alpha:
            return WGPUBlendFactor_OneMinusSrcAlpha;
        case SpriteBlendFactor::dst:
            return WGPUBlendFactor_Dst;
        case SpriteBlendFactor::dst_alpha:
            return WGPUBlendFactor_DstAlpha;
    }
    return WGPUBlendFactor_One;
}

inline WGPUBuffer dawn_sprite_uniform_buffer(WGPUDevice device) {
    WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
    descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
    descriptor.size = 64;
    WGPUBuffer buffer = wgpuDeviceCreateBuffer(device, &descriptor);
    if (!buffer) dawn_error("wgpuDeviceCreateBuffer sprite uniforms");
    return buffer;
}

/**
 * One layer's pipeline and the shader modules it names.
 *
 * The uvScroll opt-in widens a layer's instance stride and adds an
 * attribute, so the layout a pipeline describes belongs to the layer
 * rather than to the renderer it draws in. The pin keys a shared cache on
 * that layout instead; one pipeline per layer is the same picture while a
 * renderer holds one layer of each layout, which is every reached scene.
 */
inline WGPURenderPipeline create_dawn_sprite_layer_pipeline(
    WGPUDevice device,
    const std::array<WGPUBindGroupLayout, 4>& group_layouts,
    const SpriteBlendDescriptor& blend,
    bool scroll,
    WGPUTextureFormat target_format) {
    WGPUShaderModule vertex_module = load_wgsl_module(
        device,
        scroll ? "sprite_uvscroll.vert" : "sprite.vert");
    WGPUShaderModule fragment_module = load_wgsl_module(
        device, "sprite.frag");

    // The generated instance layout (sprite_layer.hpp, from
    // sprite-pipeline.ts): the pure-2D attributes at their pinned byte
    // offsets, stepped per instance. Only the float count is translated
    // to this API's vertex formats.
    std::array<
        WGPUVertexAttribute,
        upstream::sprite_instance_attributes.size() + 1u>
        attributes{};
    const std::size_t attribute_count =
        upstream::sprite_instance_attributes.size() + (scroll ? 1u : 0u);
    for (std::size_t index = 0; index < attribute_count; ++index) {
        const upstream::SpriteInstanceAttribute& row =
            index < upstream::sprite_instance_attributes.size()
                ? upstream::sprite_instance_attributes[index]
                : upstream::sprite_uvscroll_attribute;
        WGPUVertexFormat format = WGPUVertexFormat_Float32;
        switch (row.float_count) {
            case 1u:
                format = WGPUVertexFormat_Float32;
                break;
            case 2u:
                format = WGPUVertexFormat_Float32x2;
                break;
            case 3u:
                format = WGPUVertexFormat_Float32x3;
                break;
            case 4u:
                format = WGPUVertexFormat_Float32x4;
                break;
            default:
                throw std::runtime_error(
                    "Sprite instance attribute has an unsupported float "
                    "count.");
        }
        attributes[index] = WGPUVertexAttribute{
            nullptr,
            format,
            row.byte_offset,
            row.shader_location};
    }
    WGPUVertexBufferLayout instance_layout = WGPU_VERTEX_BUFFER_LAYOUT_INIT;
    instance_layout.stepMode = WGPUVertexStepMode_Instance;
    instance_layout.arrayStride = scroll
        ? upstream::sprite_uvscroll_stride_bytes
        : upstream::sprite_instance_stride_bytes;
    instance_layout.attributeCount =
        static_cast<std::uint32_t>(attribute_count);
    instance_layout.attributes = attributes.data();

    WGPUBlendState blend_state{};
    blend_state.color.operation = WGPUBlendOperation_Add;
    blend_state.color.srcFactor = dawn_sprite_blend_factor(blend.color.src);
    blend_state.color.dstFactor = dawn_sprite_blend_factor(blend.color.dst);
    blend_state.alpha.operation = WGPUBlendOperation_Add;
    blend_state.alpha.srcFactor = dawn_sprite_blend_factor(blend.alpha.src);
    blend_state.alpha.dstFactor = dawn_sprite_blend_factor(blend.alpha.dst);
    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = target_format;
    color_target.writeMask = WGPUColorWriteMask_All;
    if (blend.enabled) {
        color_target.blend = &blend_state;
    }
    WGPUFragmentState fragment_state = WGPU_FRAGMENT_STATE_INIT;
    fragment_state.module = fragment_module;
    fragment_state.entryPoint = string_view("mainFragment");
    fragment_state.targetCount = 1;
    fragment_state.targets = &color_target;

    WGPUPipelineLayoutDescriptor layout_descriptor =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    layout_descriptor.bindGroupLayoutCount =
        static_cast<std::uint32_t>(group_layouts.size());
    layout_descriptor.bindGroupLayouts = group_layouts.data();
    WGPUPipelineLayout pipeline_layout =
        wgpuDeviceCreatePipelineLayout(device, &layout_descriptor);

    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = pipeline_layout;
    descriptor.vertex.module = vertex_module;
    descriptor.vertex.entryPoint = string_view("mainVertex");
    descriptor.vertex.bufferCount = 1;
    descriptor.vertex.buffers = &instance_layout;
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.cullMode = WGPUCullMode_None;
    descriptor.multisample.count = 1;
    descriptor.multisample.mask = 0xFFFFFFFFu;
    descriptor.fragment = &fragment_state;
    WGPURenderPipeline pipeline =
        wgpuDeviceCreateRenderPipeline(device, &descriptor);
    wgpuPipelineLayoutRelease(pipeline_layout);
    // The modules live only until the pipeline names them.
    wgpuShaderModuleRelease(vertex_module);
    wgpuShaderModuleRelease(fragment_module);
    if (!pipeline) {
        dawn_error("wgpuDeviceCreateRenderPipeline sprite");
    }
    return pipeline;
}
inline DawnSpritePass create_dawn_sprite_pass(
    WGPUDevice device,
    WGPUQueue queue,
    Engine& engine,
    SpriteRendererHandle renderer_handle,
    WGPUTextureFormat target_format) {
    const SpriteRendererRecord& renderer =
        engine.sprite_renderers[renderer_handle.value];
    if (renderer.layers.empty()) {
        throw std::runtime_error("SpriteRenderer has no layers.");
    }
    DawnSpritePass pass;
    pass.renderer = renderer_handle;

    // The shared two-triangle quad every sprite instance draws.
    const std::array<std::uint16_t, 6> quad_indices{
        0u, 1u, 2u, 0u, 2u, 3u};
    {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.usage = WGPUBufferUsage_Index | WGPUBufferUsage_CopyDst;
        descriptor.size = sizeof(quad_indices);
        pass.index_buffer = wgpuDeviceCreateBuffer(device, &descriptor);
        if (!pass.index_buffer) {
            dawn_error("wgpuDeviceCreateBuffer sprite indices");
        }
        wgpuQueueWriteBuffer(
            queue,
            pass.index_buffer,
            0,
            quad_indices.data(),
            sizeof(quad_indices));
    }

    {
        // Group 0 is unused by the specialized WGSL and is declared empty
        // so the pipeline layout's group indexes line up with it.
        WGPUBindGroupLayoutDescriptor empty =
            WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
        pass.group_layouts[0] =
            wgpuDeviceCreateBindGroupLayout(device, &empty);

        WGPUBindGroupLayoutEntry vertex_entry =
            WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        vertex_entry.binding = 0;
        vertex_entry.visibility = WGPUShaderStage_Vertex;
        vertex_entry.buffer.type = WGPUBufferBindingType_Uniform;
        vertex_entry.buffer.minBindingSize = 64;
        WGPUBindGroupLayoutDescriptor vertex_layout =
            WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
        vertex_layout.entryCount = 1;
        vertex_layout.entries = &vertex_entry;
        pass.group_layouts[1] =
            wgpuDeviceCreateBindGroupLayout(device, &vertex_layout);

        std::array<WGPUBindGroupLayoutEntry, 2> texture_entries{};
        texture_entries[0] = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        texture_entries[1] = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        texture_entries[0].binding = 0;
        texture_entries[0].visibility = WGPUShaderStage_Fragment;
        texture_entries[0].texture.sampleType = WGPUTextureSampleType_Float;
        texture_entries[0].texture.viewDimension =
            WGPUTextureViewDimension_2D;
        texture_entries[1].binding = 1;
        texture_entries[1].visibility = WGPUShaderStage_Fragment;
        texture_entries[1].sampler.type = WGPUSamplerBindingType_Filtering;
        WGPUBindGroupLayoutDescriptor texture_layout =
            WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
        texture_layout.entryCount =
            static_cast<std::uint32_t>(texture_entries.size());
        texture_layout.entries = texture_entries.data();
        pass.group_layouts[2] =
            wgpuDeviceCreateBindGroupLayout(device, &texture_layout);

        WGPUBindGroupLayoutEntry fragment_entry =
            WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        fragment_entry.binding = 0;
        fragment_entry.visibility = WGPUShaderStage_Fragment;
        fragment_entry.buffer.type = WGPUBufferBindingType_Uniform;
        fragment_entry.buffer.minBindingSize = 64;
        WGPUBindGroupLayoutDescriptor fragment_layout =
            WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
        fragment_layout.entryCount = 1;
        fragment_layout.entries = &fragment_entry;
        pass.group_layouts[3] =
            wgpuDeviceCreateBindGroupLayout(device, &fragment_layout);
    }

    pass.layers.resize(renderer.layers.size());
    for (std::size_t index = 0; index < renderer.layers.size(); ++index) {
        const Sprite2DLayerRecord& layer =
            engine.sprite_layers[renderer.layers[index].value];
        const SpriteAtlasRecord& atlas =
            engine.sprite_atlases[layer.atlas.value];
        DawnSpriteLayer& gpu = pass.layers[index];
        gpu.pipeline = create_dawn_sprite_layer_pipeline(
            device,
            pass.group_layouts,
            layer.blend,
            layer.uv_scroll,
            target_format);

        WGPUBufferDescriptor instance_descriptor =
            WGPU_BUFFER_DESCRIPTOR_INIT;
        instance_descriptor.usage =
            WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst;
        instance_descriptor.size =
            static_cast<std::uint64_t>(layer.instance_data.size()) *
            sizeof(float);
        gpu.instances =
            wgpuDeviceCreateBuffer(device, &instance_descriptor);
        if (!gpu.instances) {
            dawn_error("wgpuDeviceCreateBuffer sprite instances");
        }
        gpu.vertex_uniforms = dawn_sprite_uniform_buffer(device);
        gpu.fragment_uniforms = dawn_sprite_uniform_buffer(device);

        // rgba8unorm: `loadTexture2D` leaves srgb off, so the atlas texels
        // reach the blend stage as the bytes on disk.
        WGPUTextureDescriptor texture_descriptor =
            WGPU_TEXTURE_DESCRIPTOR_INIT;
        texture_descriptor.dimension = WGPUTextureDimension_2D;
        texture_descriptor.format = WGPUTextureFormat_RGBA8Unorm;
        texture_descriptor.usage =
            WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
        texture_descriptor.size =
            WGPUExtent3D{atlas.width, atlas.height, 1};
        gpu.atlas = wgpuDeviceCreateTexture(device, &texture_descriptor);
        if (!gpu.atlas) dawn_error("wgpuDeviceCreateTexture sprite atlas");
        WGPUTexelCopyTextureInfo upload_destination =
            WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        upload_destination.texture = gpu.atlas;
        WGPUTexelCopyBufferLayout upload_layout{};
        upload_layout.bytesPerRow = atlas.width * 4;
        upload_layout.rowsPerImage = atlas.height;
        const WGPUExtent3D upload_size{atlas.width, atlas.height, 1};
        wgpuQueueWriteTexture(
            queue,
            &upload_destination,
            atlas.rgba.data(),
            atlas.rgba.size(),
            &upload_layout,
            &upload_size);
        gpu.atlas_view = wgpuTextureCreateView(gpu.atlas, nullptr);

        // The pinned sampler, derived from the record like the SDL_GPU
        // pass: the atlas loader stamps clamp both axes, no mip chain,
        // and the filter `sampling` chose.
        gpu.sampler = create_texture_sampler(device, atlas.sampler);

        WGPUBindGroupEntry vertex_binding = WGPU_BIND_GROUP_ENTRY_INIT;
        vertex_binding.binding = 0;
        vertex_binding.buffer = gpu.vertex_uniforms;
        vertex_binding.size = 64;
        WGPUBindGroupDescriptor vertex_group =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        vertex_group.layout = pass.group_layouts[1];
        vertex_group.entryCount = 1;
        vertex_group.entries = &vertex_binding;
        gpu.vertex_group =
            wgpuDeviceCreateBindGroup(device, &vertex_group);

        std::array<WGPUBindGroupEntry, 2> texture_bindings{};
        texture_bindings[0] = WGPU_BIND_GROUP_ENTRY_INIT;
        texture_bindings[1] = WGPU_BIND_GROUP_ENTRY_INIT;
        texture_bindings[0].binding = 0;
        texture_bindings[0].textureView = gpu.atlas_view;
        texture_bindings[1].binding = 1;
        texture_bindings[1].sampler = gpu.sampler;
        WGPUBindGroupDescriptor texture_group =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        texture_group.layout = pass.group_layouts[2];
        texture_group.entryCount =
            static_cast<std::uint32_t>(texture_bindings.size());
        texture_group.entries = texture_bindings.data();
        gpu.texture_group =
            wgpuDeviceCreateBindGroup(device, &texture_group);

        WGPUBindGroupEntry fragment_binding = WGPU_BIND_GROUP_ENTRY_INIT;
        fragment_binding.binding = 0;
        fragment_binding.buffer = gpu.fragment_uniforms;
        fragment_binding.size = 64;
        WGPUBindGroupDescriptor fragment_group =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        fragment_group.layout = pass.group_layouts[3];
        fragment_group.entryCount = 1;
        fragment_group.entries = &fragment_binding;
        gpu.fragment_group =
            wgpuDeviceCreateBindGroup(device, &fragment_group);
    }
    return pass;
}

/**
 * `_update`: dirty instance data plus the per-layer UBO, which the pinned
 * `uploadLayer` also builds here because it depends on the target size.
 */
inline void upload_dawn_sprite_pass(
    WGPUQueue queue,
    Engine& engine,
    DawnSpritePass& pass,
    std::uint32_t width,
    std::uint32_t height) {
    const SpriteRendererRecord& renderer =
        engine.sprite_renderers[pass.renderer.value];
    for (std::size_t index = 0; index < renderer.layers.size(); ++index) {
        Sprite2DLayerRecord& layer =
            engine.sprite_layers[renderer.layers[index].value];
        DawnSpriteLayer& gpu = pass.layers[index];
        if (!gpu.uploaded || gpu.uploaded_version != layer.version) {
            if (layer.count > 0) {
                wgpuQueueWriteBuffer(
                    queue,
                    gpu.instances,
                    0,
                    layer.instance_data.data(),
                    static_cast<std::size_t>(layer.count) *
                        layer.instance_floats_per_sprite * sizeof(float));
            }
            gpu.uploaded = true;
            gpu.uploaded_version = layer.version;
        }
        std::array<float, 16> ubo{};
        upstream::build_sprite_layer_ubo(
            layer,
            static_cast<float>(width),
            static_cast<float>(height),
            ubo);
        wgpuQueueWriteBuffer(
            queue, gpu.vertex_uniforms, 0, ubo.data(), sizeof(ubo));
        wgpuQueueWriteBuffer(
            queue, gpu.fragment_uniforms, 0, ubo.data(), sizeof(ubo));
    }
}

/** `_record`: encode the draws into a render pass the caller opened. */
inline void record_dawn_sprite_pass(
    WGPURenderPassEncoder encoder,
    Engine& engine,
    const DawnSpritePass& pass) {
    const SpriteRendererRecord& renderer =
        engine.sprite_renderers[pass.renderer.value];

    wgpuRenderPassEncoderSetIndexBuffer(
        encoder, pass.index_buffer, WGPUIndexFormat_Uint16, 0, 12);

    // The per-frame layer order (pal_gpu_shared.hpp): the pinned
    // by-`order` stable sort both backends draw with.
    const std::vector<std::size_t> draw_order =
        sprite_layer_draw_order(engine, renderer);
    for (const std::size_t index : draw_order) {
        const Sprite2DLayerRecord& layer =
            engine.sprite_layers[renderer.layers[index].value];
        if (!layer.visible || layer.count == 0) {
            continue;
        }
        const DawnSpriteLayer& gpu = pass.layers[index];
        wgpuRenderPassEncoderSetPipeline(encoder, gpu.pipeline);
        wgpuRenderPassEncoderSetBindGroup(
            encoder, 1, gpu.vertex_group, 0, nullptr);
        wgpuRenderPassEncoderSetBindGroup(
            encoder, 2, gpu.texture_group, 0, nullptr);
        wgpuRenderPassEncoderSetBindGroup(
            encoder, 3, gpu.fragment_group, 0, nullptr);
        wgpuRenderPassEncoderSetVertexBuffer(
            encoder,
            0,
            gpu.instances,
            0,
            static_cast<std::uint64_t>(layer.count) *
                layer.instance_floats_per_sprite * sizeof(float));
        wgpuRenderPassEncoderDrawIndexed(encoder, 6, layer.count, 0, 0, 0);
    }
}

inline void release_dawn_sprite_pass(DawnSpritePass& pass) {
    for (DawnSpriteLayer& layer : pass.layers) {
        if (layer.vertex_group) wgpuBindGroupRelease(layer.vertex_group);
        if (layer.texture_group) wgpuBindGroupRelease(layer.texture_group);
        if (layer.fragment_group) {
            wgpuBindGroupRelease(layer.fragment_group);
        }
        if (layer.sampler) wgpuSamplerRelease(layer.sampler);
        if (layer.atlas_view) wgpuTextureViewRelease(layer.atlas_view);
        if (layer.atlas) wgpuTextureRelease(layer.atlas);
        if (layer.pipeline) wgpuRenderPipelineRelease(layer.pipeline);
        if (layer.instances) wgpuBufferRelease(layer.instances);
        if (layer.vertex_uniforms) {
            wgpuBufferRelease(layer.vertex_uniforms);
        }
        if (layer.fragment_uniforms) {
            wgpuBufferRelease(layer.fragment_uniforms);
        }
    }
    pass.layers.clear();
    for (WGPUBindGroupLayout layout : pass.group_layouts) {
        if (layout) wgpuBindGroupLayoutRelease(layout);
    }
    pass.group_layouts = {};
    if (pass.index_buffer) {
        wgpuBufferRelease(pass.index_buffer);
        pass.index_buffer = nullptr;
    }
}

} // namespace bbl::pal

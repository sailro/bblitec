#pragma once

// World-space billboards, as a Dawn pass that composes into the scene's own
// render pass.
//
// The SDL_GPU twin (`pal_sdl_gpu_billboard.hpp`) carries the reasoning; this
// is the same pass in the other API. It records into an encoder the scene
// renderer already opened, so a billboard blends over the stages above it and
// tests against the depth they wrote.
//
// The layout, quad, UBO and sort all come from `billboard_system.hpp`, which
// the billboard lowerer generates from the pinned pipeline module.

#include <bblite/runtime.hpp>
#include <bblite/upstream/billboard_system.hpp>

#include <algorithm>
#include <array>
#include <cstdint>
#include <numeric>
#include <stdexcept>
#include <vector>

#include "pal_dawn_shared.hpp"
// dawn_sprite_blend_factor: one translation of the pinned blend enum,
// shared with the 2D layer's pass.
#include "pal_dawn_sprite.hpp"

namespace bbl::pal {

/** One billboard system, as Dawn resources. */
struct DawnBillboardPass {
    WGPURenderPipeline pipeline = nullptr;
    WGPUShaderModule vertex_module = nullptr;
    WGPUShaderModule fragment_module = nullptr;
    std::array<WGPUBindGroupLayout, 4> group_layouts{};
    WGPUBuffer index_buffer = nullptr;
    WGPUBuffer instances = nullptr;
    WGPUBuffer vertex_uniforms = nullptr;
    WGPUBuffer fragment_uniforms = nullptr;
    WGPUTexture atlas = nullptr;
    WGPUTextureView atlas_view = nullptr;
    WGPUSampler sampler = nullptr;
    WGPUBindGroup vertex_group = nullptr;
    WGPUBindGroup texture_group = nullptr;
    WGPUBindGroup fragment_group = nullptr;
    BillboardSystemHandle system{};
    // The reordered upload, kept across frames.
    std::vector<float> sorted;
};

/** The vertex block the reconstructed billboard stage declares. */
struct DawnBillboardSceneUniforms {
    std::array<float, 16> view_projection{};
    std::array<float, 16> view{};
};

inline WGPUVertexFormat dawn_billboard_format(
    std::uint32_t float_count) {
    switch (float_count) {
        case 1u:
            return WGPUVertexFormat_Float32;
        case 2u:
            return WGPUVertexFormat_Float32x2;
        case 3u:
            return WGPUVertexFormat_Float32x3;
        case 4u:
            return WGPUVertexFormat_Float32x4;
        default:
            throw std::runtime_error(
                "Billboard instance attribute has an unsupported float "
                "count.");
    }
}

inline DawnBillboardPass create_dawn_billboard_pass(
    WGPUDevice device,
    WGPUQueue queue,
    Engine& engine,
    BillboardSystemHandle system_handle,
    WGPUTextureFormat target_format,
    WGPUTextureFormat depth_format,
    std::uint32_t sample_count) {
    const BillboardSystemRecord& system =
        engine.billboard_systems[system_handle.value];
    const SpriteAtlasRecord& atlas =
        engine.sprite_atlases[system.atlas.value];
    DawnBillboardPass pass;
    pass.system = system_handle;

    {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.usage =
            WGPUBufferUsage_Index | WGPUBufferUsage_CopyDst;
        descriptor.size =
            sizeof(std::uint16_t) *
            upstream::billboard_index_data.size();
        pass.index_buffer = wgpuDeviceCreateBuffer(device, &descriptor);
        if (!pass.index_buffer) {
            dawn_error("wgpuDeviceCreateBuffer billboard indices");
        }
        wgpuQueueWriteBuffer(
            queue,
            pass.index_buffer,
            0,
            upstream::billboard_index_data.data(),
            static_cast<std::size_t>(descriptor.size));
    }

    const bool axis_locked =
        system.orientation == BillboardOrientation::axis_locked;
    pass.vertex_module = load_wgsl_module(
        device,
        axis_locked ? "billboard_axis_locked.vert" : "billboard.vert");
    pass.fragment_module = load_wgsl_module(device, "billboard.frag");

    // Group 0 is unused by the specialized WGSL (the scene block is
    // re-homed into the vertex group) and is declared empty so the layout's
    // group indexes line up.
    {
        WGPUBindGroupLayoutDescriptor empty =
            WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
        pass.group_layouts[0] =
            wgpuDeviceCreateBindGroupLayout(device, &empty);

        WGPUBindGroupLayoutEntry vertex_entry =
            WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        vertex_entry.binding = 0;
        vertex_entry.visibility = WGPUShaderStage_Vertex;
        vertex_entry.buffer.type = WGPUBufferBindingType_Uniform;
        vertex_entry.buffer.minBindingSize =
            sizeof(DawnBillboardSceneUniforms);
        WGPUBindGroupLayoutEntry vertex_system_entry =
            WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        vertex_system_entry.binding = 1;
        vertex_system_entry.visibility = WGPUShaderStage_Vertex;
        vertex_system_entry.buffer.type = WGPUBufferBindingType_Uniform;
        vertex_system_entry.buffer.minBindingSize =
            upstream::billboard_system_ubo_bytes;
        const std::array<WGPUBindGroupLayoutEntry, 2> vertex_entries{
            vertex_entry, vertex_system_entry};
        WGPUBindGroupLayoutDescriptor vertex_layout =
            WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
        // The axis-locked basis reads the system block for its lock axis.
        vertex_layout.entryCount = axis_locked ? 2u : 1u;
        vertex_layout.entries = vertex_entries.data();
        pass.group_layouts[1] =
            wgpuDeviceCreateBindGroupLayout(device, &vertex_layout);

        std::array<WGPUBindGroupLayoutEntry, 2> texture_entries{};
        texture_entries[0] = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        texture_entries[1] = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        texture_entries[0].binding = 0;
        texture_entries[0].visibility = WGPUShaderStage_Fragment;
        texture_entries[0].texture.sampleType =
            WGPUTextureSampleType_Float;
        texture_entries[0].texture.viewDimension =
            WGPUTextureViewDimension_2D;
        texture_entries[1].binding = 1;
        texture_entries[1].visibility = WGPUShaderStage_Fragment;
        texture_entries[1].sampler.type =
            WGPUSamplerBindingType_Filtering;
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
        fragment_entry.buffer.minBindingSize =
            upstream::billboard_system_ubo_bytes;
        WGPUBindGroupLayoutDescriptor fragment_layout =
            WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
        fragment_layout.entryCount = 1;
        fragment_layout.entries = &fragment_entry;
        pass.group_layouts[3] =
            wgpuDeviceCreateBindGroupLayout(device, &fragment_layout);
    }

    std::array<
        WGPUVertexAttribute,
        upstream::billboard_instance_attributes.size()>
        attributes{};
    for (std::size_t index = 0;
         index < upstream::billboard_instance_attributes.size();
         ++index) {
        const upstream::BillboardInstanceAttribute& row =
            upstream::billboard_instance_attributes[index];
        attributes[index] = WGPUVertexAttribute{
            nullptr,
            dawn_billboard_format(row.float_count),
            row.byte_offset,
            row.shader_location};
    }
    WGPUVertexBufferLayout instance_layout =
        WGPU_VERTEX_BUFFER_LAYOUT_INIT;
    instance_layout.stepMode = WGPUVertexStepMode_Instance;
    instance_layout.arrayStride =
        upstream::billboard_instance_stride_bytes;
    instance_layout.attributeCount =
        static_cast<std::uint32_t>(attributes.size());
    instance_layout.attributes = attributes.data();

    // The descriptor the system was created with: the pinned
    // billboardBlend* the scene named, lowered as data.
    const SpriteBlendDescriptor& blend = system.blend;
    WGPUBlendState blend_state{};
    blend_state.color.operation = WGPUBlendOperation_Add;
    blend_state.color.srcFactor =
        dawn_sprite_blend_factor(blend.color.src);
    blend_state.color.dstFactor =
        dawn_sprite_blend_factor(blend.color.dst);
    blend_state.alpha.operation = WGPUBlendOperation_Add;
    blend_state.alpha.srcFactor =
        dawn_sprite_blend_factor(blend.alpha.src);
    blend_state.alpha.dstFactor =
        dawn_sprite_blend_factor(blend.alpha.dst);
    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = target_format;
    color_target.writeMask = WGPUColorWriteMask_All;
    if (blend.enabled) {
        color_target.blend = &blend_state;
    }
    WGPUFragmentState fragment_state = WGPU_FRAGMENT_STATE_INIT;
    fragment_state.module = pass.fragment_module;
    fragment_state.entryPoint = string_view("mainFragment");
    fragment_state.targetCount = 1;
    fragment_state.targets = &color_target;

    // The pinned depth table's `transparent` arm: test on, write off, which
    // is what makes the sorted draw order the composite. This renderer's
    // scene pass is forward-Z, so the pin's reverse-Z "greater-equal" is
    // LessEqual here -- the arm every transparent scene draw already takes.
    WGPUDepthStencilState depth_state = WGPU_DEPTH_STENCIL_STATE_INIT;
    depth_state.format = depth_format;
    depth_state.depthCompare = WGPUCompareFunction_LessEqual;
    depth_state.depthWriteEnabled = WGPUOptionalBool_False;

    WGPUPipelineLayoutDescriptor layout_descriptor =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    layout_descriptor.bindGroupLayoutCount =
        static_cast<std::uint32_t>(pass.group_layouts.size());
    layout_descriptor.bindGroupLayouts = pass.group_layouts.data();
    WGPUPipelineLayout pipeline_layout =
        wgpuDeviceCreatePipelineLayout(device, &layout_descriptor);

    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = pipeline_layout;
    descriptor.vertex.module = pass.vertex_module;
    descriptor.vertex.entryPoint = string_view("mainVertex");
    descriptor.vertex.bufferCount = 1;
    descriptor.vertex.buffers = &instance_layout;
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    // The quad is expanded around a camera basis, so a billboard has no
    // consistent winding to cull against.
    descriptor.primitive.cullMode = WGPUCullMode_None;
    descriptor.depthStencil = &depth_state;
    descriptor.multisample.count = sample_count;
    descriptor.multisample.mask = 0xFFFFFFFFu;
    descriptor.fragment = &fragment_state;
    pass.pipeline = wgpuDeviceCreateRenderPipeline(device, &descriptor);
    wgpuPipelineLayoutRelease(pipeline_layout);
    if (!pass.pipeline) {
        dawn_error("wgpuDeviceCreateRenderPipeline billboard");
    }

    {
        WGPUBufferDescriptor instance_descriptor =
            WGPU_BUFFER_DESCRIPTOR_INIT;
        instance_descriptor.usage =
            WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst;
        instance_descriptor.size =
            static_cast<std::uint64_t>(system.capacity) *
            upstream::billboard_instance_stride_bytes;
        pass.instances =
            wgpuDeviceCreateBuffer(device, &instance_descriptor);
        if (!pass.instances) {
            dawn_error("wgpuDeviceCreateBuffer billboard instances");
        }

        WGPUBufferDescriptor uniform_descriptor =
            WGPU_BUFFER_DESCRIPTOR_INIT;
        uniform_descriptor.usage =
            WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        uniform_descriptor.size = sizeof(DawnBillboardSceneUniforms);
        pass.vertex_uniforms =
            wgpuDeviceCreateBuffer(device, &uniform_descriptor);
        uniform_descriptor.size =
            upstream::billboard_system_ubo_bytes;
        pass.fragment_uniforms =
            wgpuDeviceCreateBuffer(device, &uniform_descriptor);
        if (!pass.vertex_uniforms || !pass.fragment_uniforms) {
            dawn_error("wgpuDeviceCreateBuffer billboard uniforms");
        }
    }

    // rgba8unorm: `loadTexture2D` leaves srgb off, so the atlas texels reach
    // the blend stage as the bytes on disk.
    WGPUTextureDescriptor texture_descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    texture_descriptor.dimension = WGPUTextureDimension_2D;
    texture_descriptor.format = WGPUTextureFormat_RGBA8Unorm;
    texture_descriptor.usage =
        WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    texture_descriptor.size =
        WGPUExtent3D{atlas.width, atlas.height, 1};
    pass.atlas = wgpuDeviceCreateTexture(device, &texture_descriptor);
    if (!pass.atlas) dawn_error("wgpuDeviceCreateTexture billboard atlas");
    WGPUTexelCopyTextureInfo upload_destination =
        WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    upload_destination.texture = pass.atlas;
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
    pass.atlas_view = wgpuTextureCreateView(pass.atlas, nullptr);
    pass.sampler = create_texture_sampler(device, atlas.sampler);

    std::array<WGPUBindGroupEntry, 2> vertex_bindings{};
    vertex_bindings[0] = WGPU_BIND_GROUP_ENTRY_INIT;
    vertex_bindings[0].binding = 0;
    vertex_bindings[0].buffer = pass.vertex_uniforms;
    vertex_bindings[0].size = sizeof(DawnBillboardSceneUniforms);
    vertex_bindings[1] = WGPU_BIND_GROUP_ENTRY_INIT;
    vertex_bindings[1].binding = 1;
    vertex_bindings[1].buffer = pass.fragment_uniforms;
    vertex_bindings[1].size = upstream::billboard_system_ubo_bytes;
    WGPUBindGroupDescriptor vertex_group = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    vertex_group.layout = pass.group_layouts[1];
    vertex_group.entryCount = axis_locked ? 2u : 1u;
    vertex_group.entries = vertex_bindings.data();
    pass.vertex_group = wgpuDeviceCreateBindGroup(device, &vertex_group);

    std::array<WGPUBindGroupEntry, 2> texture_bindings{};
    texture_bindings[0] = WGPU_BIND_GROUP_ENTRY_INIT;
    texture_bindings[1] = WGPU_BIND_GROUP_ENTRY_INIT;
    texture_bindings[0].binding = 0;
    texture_bindings[0].textureView = pass.atlas_view;
    texture_bindings[1].binding = 1;
    texture_bindings[1].sampler = pass.sampler;
    WGPUBindGroupDescriptor texture_group = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    texture_group.layout = pass.group_layouts[2];
    texture_group.entryCount =
        static_cast<std::uint32_t>(texture_bindings.size());
    texture_group.entries = texture_bindings.data();
    pass.texture_group =
        wgpuDeviceCreateBindGroup(device, &texture_group);

    WGPUBindGroupEntry fragment_binding = WGPU_BIND_GROUP_ENTRY_INIT;
    fragment_binding.binding = 0;
    fragment_binding.buffer = pass.fragment_uniforms;
    fragment_binding.size = upstream::billboard_system_ubo_bytes;
    WGPUBindGroupDescriptor fragment_group =
        WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    fragment_group.layout = pass.group_layouts[3];
    fragment_group.entryCount = 1;
    fragment_group.entries = &fragment_binding;
    pass.fragment_group =
        wgpuDeviceCreateBindGroup(device, &fragment_group);
    return pass;
}

/**
 * Sorts the instances back to front in view space and uploads them, with the
 * uniforms the frame's camera settles.
 *
 * With depth writes off the draw ORDER is the composite, so this runs every
 * frame rather than only when the system changes.
 */
inline void upload_dawn_billboard_pass(
    WGPUQueue queue,
    Engine& engine,
    DawnBillboardPass& pass,
    const std::array<float, 16>& view_projection,
    const std::array<float, 16>& view) {
    const BillboardSystemRecord& system =
        engine.billboard_systems[pass.system.value];

    DawnBillboardSceneUniforms scene_uniforms{};
    scene_uniforms.view_projection = view_projection;
    scene_uniforms.view = view;
    wgpuQueueWriteBuffer(
        queue,
        pass.vertex_uniforms,
        0,
        &scene_uniforms,
        sizeof(scene_uniforms));

    std::array<float, upstream::billboard_system_ubo_bytes / 4> system_ubo{};
    upstream::build_billboard_system_ubo(system, system_ubo);
    wgpuQueueWriteBuffer(
        queue,
        pass.fragment_uniforms,
        0,
        system_ubo.data(),
        system_ubo.size() * sizeof(float));

    if (system.count == 0) {
        return;
    }
    upstream::billboard_sorted_instances(system, view, pass.sorted);
    wgpuQueueWriteBuffer(
        queue,
        pass.instances,
        0,
        pass.sorted.data(),
        pass.sorted.size() * sizeof(float));
}

/** Records the draw into an encoder the scene renderer already opened. */
inline void record_dawn_billboard_pass(
    WGPURenderPassEncoder encoder,
    Engine& engine,
    const DawnBillboardPass& pass) {
    const BillboardSystemRecord& system =
        engine.billboard_systems[pass.system.value];
    if (!system.visible || system.count == 0) {
        return;
    }
    wgpuRenderPassEncoderSetPipeline(encoder, pass.pipeline);
    wgpuRenderPassEncoderSetIndexBuffer(
        encoder,
        pass.index_buffer,
        WGPUIndexFormat_Uint16,
        0,
        sizeof(std::uint16_t) *
            upstream::billboard_index_data.size());
    wgpuRenderPassEncoderSetBindGroup(
        encoder, 1, pass.vertex_group, 0, nullptr);
    wgpuRenderPassEncoderSetBindGroup(
        encoder, 2, pass.texture_group, 0, nullptr);
    wgpuRenderPassEncoderSetBindGroup(
        encoder, 3, pass.fragment_group, 0, nullptr);
    wgpuRenderPassEncoderSetVertexBuffer(
        encoder,
        0,
        pass.instances,
        0,
        static_cast<std::uint64_t>(system.count) *
            upstream::billboard_instance_stride_bytes);
    wgpuRenderPassEncoderDrawIndexed(
        encoder,
        static_cast<std::uint32_t>(
            upstream::billboard_index_data.size()),
        system.count,
        0,
        0,
        0);
}

inline void release_dawn_billboard_pass(DawnBillboardPass& pass) {
    if (pass.vertex_group) wgpuBindGroupRelease(pass.vertex_group);
    if (pass.texture_group) wgpuBindGroupRelease(pass.texture_group);
    if (pass.fragment_group) wgpuBindGroupRelease(pass.fragment_group);
    if (pass.sampler) wgpuSamplerRelease(pass.sampler);
    if (pass.atlas_view) wgpuTextureViewRelease(pass.atlas_view);
    if (pass.atlas) wgpuTextureRelease(pass.atlas);
    if (pass.vertex_uniforms) wgpuBufferRelease(pass.vertex_uniforms);
    if (pass.fragment_uniforms) wgpuBufferRelease(pass.fragment_uniforms);
    if (pass.instances) wgpuBufferRelease(pass.instances);
    if (pass.index_buffer) wgpuBufferRelease(pass.index_buffer);
    for (WGPUBindGroupLayout layout : pass.group_layouts) {
        if (layout) wgpuBindGroupLayoutRelease(layout);
    }
    if (pass.vertex_module) wgpuShaderModuleRelease(pass.vertex_module);
    if (pass.fragment_module) {
        wgpuShaderModuleRelease(pass.fragment_module);
    }
    if (pass.pipeline) wgpuRenderPipelineRelease(pass.pipeline);
    pass = DawnBillboardPass{};
}

}  // namespace bbl::pal

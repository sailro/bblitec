#pragma once

// The Sprite2D passes on Dawn (WebGPU): standalone SpriteRenderer contexts
// and the depth-hosted layer lane recorded inside a scene pass.
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
// `@group(2)` — so the bind groups follow that grouping. Both stage bindings
// name the same 64-byte buffer because the payload is identical.

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
/** One atlas upload/sampler owned once by a sprite pass. */
struct DawnSpriteAtlasBinding {
    SpriteAtlasHandle handle{};
    WGPUTexture texture = nullptr;
    WGPUTextureView view = nullptr;
    WGPUSampler sampler = nullptr;
    // Render-texture atlases borrow their texture and view from the frame.
    bool owns_texture = true;
};

/** Per-layer GPU state, matching the pinned `LayerGpu`. */
struct DawnSpriteLayer {
    // One pipeline per layer: the uvScroll opt-in widens a layer's stride
    // and adds an attribute, so the layout a pipeline describes is the
    // layer's, not the renderer's.
    WGPURenderPipeline pipeline = nullptr;
    WGPUBuffer instances = nullptr;
    std::uint64_t instance_buffer_bytes = 0;
    bool owns_pipeline = true;
    bool owns_group_layouts = true;
    WGPUBuffer layer_uniforms = nullptr;
    std::array<float, 16> uploaded_layer_ubo{};
    bool layer_ubo_uploaded = false;
    // Bound beside the fragment uniforms for a custom-shader layer, and
    // null for a plain one, which is the pin's own nullable fx attachment.
    WGPUBuffer fx_uniforms = nullptr;
    WGPUTexture atlas = nullptr;
    WGPUTextureView atlas_view = nullptr;
    WGPUSampler sampler = nullptr;
    // The custom shader's extra textures, in the order they bind after
    // the atlas.
    std::vector<DawnSampledTexture> extras;
    WGPUBindGroup vertex_group = nullptr;
    WGPUBindGroup texture_group = nullptr;
    WGPUBindGroup fragment_group = nullptr;
    // The groups this layer's pipeline is laid out with. They belong to the
    // layer for the same reason the pipeline does: a custom shader adds the
    // fx block to the fragment group, so the interface is the layer's.
    std::array<WGPUBindGroupLayout, 4> group_layouts{};
    // Which layer this belongs to; the SDL_GPU sibling carries the same key
    // and for the same reason -- the pin keys `sr._layerGpu` by the layer.
    Sprite2DLayerHandle layer{};
    std::uint64_t uploaded_version = 0;
    // The record's own pipeline clock, bumped by the generated writers that
    // change fixed-function/layout state; the SDL_GPU sibling keys rebuilds
    // off the same field so a new pipeline-affecting record field has one
    // detector to extend, not two.
    std::uint64_t pipeline_version = 0;
    bool uploaded = false;
    // The custom shader's own clock: seconds since this layer's first
    // frame, which the pin accumulates inside the layer's fx attachment.
    // JavaScript `number` accumulation stays double precision; only the
    // final SpriteFx UBO write narrows to f32.
    double elapsed_ms = 0.0;
};

/** One registered `SpriteRenderer`, as GPU resources. */
struct DawnSpritePass {
    WGPUBuffer index_buffer = nullptr;
    std::vector<DawnSpriteLayer> layers;
    std::vector<DawnSpriteAtlasBinding> atlases;
    SpriteRendererHandle renderer{};
    // The renderer's layer list this pass was synchronized against; a bump
    // is what makes `sync_dawn_sprite_pass_layers` walk it again.
    std::uint64_t layers_version = 0;
    // The colour attachment's format, so a layer added later builds its
    // pipeline against the same target without the caller threading it back
    // through every frame.
    WGPUTextureFormat target_format = WGPUTextureFormat_Undefined;
};

/** Sprite layers attached to the scene's depth-hosted renderable lane. */
struct DawnSceneSpritePass {
    WGPUBuffer index_buffer = nullptr;
    std::vector<DawnSpriteLayer> layers;
    std::vector<DawnSpriteAtlasBinding> atlases;
    std::vector<Sprite2DLayerHandle> handles;
    WGPUTextureFormat target_format = WGPUTextureFormat_Undefined;
    WGPUTextureFormat depth_format = WGPUTextureFormat_Undefined;
    std::uint32_t sample_count = 1u;
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

inline WGPUBuffer dawn_sprite_uniform_buffer(
    WGPUDevice device,
    std::uint64_t size = 64) {
    WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
    descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
    descriptor.size = size;
    WGPUBuffer buffer = wgpuDeviceCreateBuffer(device, &descriptor);
    if (!buffer) dawn_error("wgpuDeviceCreateBuffer sprite uniforms");
    return buffer;
}

inline DawnSpriteAtlasBinding create_dawn_sprite_atlas_binding(
    WGPUDevice device,
    WGPUQueue queue,
    const Engine& engine,
    SpriteAtlasHandle handle,
    const std::vector<WGPUTexture>& render_textures,
    const std::vector<WGPUTextureView>& render_texture_views) {
    const SpriteAtlasRecord& atlas = engine.sprite_atlases[handle.value];
    DawnSpriteAtlasBinding binding;
    binding.handle = handle;
    if (atlas.has_render_texture) {
        binding.texture = render_textures[atlas.render_texture.value];
        binding.view = render_texture_views[atlas.render_texture.value];
        binding.owns_texture = false;
    } else {
        binding.texture = upload_dawn_rgba_texture(
            device,
            queue,
            atlas.rgba.data(),
            atlas.rgba.size(),
            atlas.width,
            atlas.height);
        binding.view = wgpuTextureCreateView(binding.texture, nullptr);
    }
    binding.sampler = create_texture_sampler(device, atlas.sampler);
    return binding;
}

inline void release_dawn_sprite_atlas_binding(
    DawnSpriteAtlasBinding& binding) {
    if (binding.sampler) wgpuSamplerRelease(binding.sampler);
    if (binding.owns_texture && binding.view) {
        wgpuTextureViewRelease(binding.view);
    }
    if (binding.owns_texture && binding.texture) {
        wgpuTextureRelease(binding.texture);
    }
    binding = DawnSpriteAtlasBinding{};
}

inline DawnSpriteAtlasBinding& ensure_dawn_sprite_atlas_binding(
    WGPUDevice device,
    WGPUQueue queue,
    const Engine& engine,
    SpriteAtlasHandle handle,
    const std::vector<WGPUTexture>& render_textures,
    const std::vector<WGPUTextureView>& render_texture_views,
    std::vector<DawnSpriteAtlasBinding>& bindings) {
    const auto found = std::find_if(
        bindings.begin(),
        bindings.end(),
        [&](const DawnSpriteAtlasBinding& candidate) {
            return candidate.handle.value == handle.value;
        });
    if (found != bindings.end()) return *found;
    bindings.push_back(create_dawn_sprite_atlas_binding(
        device,
        queue,
        engine,
        handle,
        render_textures,
        render_texture_views));
    return bindings.back();
}

inline const DawnSpriteAtlasBinding& find_dawn_sprite_atlas_binding(
    const std::vector<DawnSpriteAtlasBinding>& bindings,
    SpriteAtlasHandle handle) {
    const auto found = std::find_if(
        bindings.begin(),
        bindings.end(),
        [&](const DawnSpriteAtlasBinding& candidate) {
            return candidate.handle.value == handle.value;
        });
    if (found == bindings.end()) {
        throw std::runtime_error("Sprite atlas binding is missing.");
    }
    return *found;
}

inline void release_dawn_sprite_atlas_bindings(
    std::vector<DawnSpriteAtlasBinding>& bindings) {
    for (DawnSpriteAtlasBinding& binding : bindings) {
        release_dawn_sprite_atlas_binding(binding);
    }
    bindings.clear();
}

/**
 * The four bind-group layouts one layer's pipeline is laid out with.
 *
 * Group 0 is unused by the specialized WGSL and is declared empty so the
 * pipeline layout's group indexes line up with it; the rest follow the
 * SDL_GPU grouping the generated WGSL is written in -- vertex uniforms at
 * 1, the atlas pair at 2, fragment uniforms at 3. A custom-shader layer
 * adds the fx block beside its layer block in group 3, which is why these
 * belong to the layer rather than to the pass.
 */
inline std::array<WGPUBindGroupLayout, 4>
create_dawn_sprite_layer_layouts(
    WGPUDevice device,
    std::uint32_t custom_shader,
    std::size_t extra_textures) {
    std::array<WGPUBindGroupLayout, 4> layouts{};

    WGPUBindGroupLayoutDescriptor empty =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    layouts[0] = wgpuDeviceCreateBindGroupLayout(device, &empty);

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
    layouts[1] = wgpuDeviceCreateBindGroupLayout(device, &vertex_layout);

    // The atlas pair, then one pair per extra texture a custom shader
    // named -- the order the composed program declares them in.
    const std::vector<WGPUBindGroupLayoutEntry> texture_entries =
        dawn_texture_pair_layout_entries(1u + extra_textures);
    WGPUBindGroupLayoutDescriptor texture_layout =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    texture_layout.entryCount =
        static_cast<std::uint32_t>(texture_entries.size());
    texture_layout.entries = texture_entries.data();
    layouts[2] = wgpuDeviceCreateBindGroupLayout(device, &texture_layout);

    // A custom-shader layer declares the fx block beside the layer block,
    // whether or not its body reads either. WebGPU takes a group entry the
    // shader ignores, so unlike SDL_GPU this side needs no dense slots.
    std::array<WGPUBindGroupLayoutEntry, 2> fragment_entries{};
    fragment_entries[0] = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    fragment_entries[1] = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    fragment_entries[0].binding = 0;
    fragment_entries[0].visibility = WGPUShaderStage_Fragment;
    fragment_entries[0].buffer.type = WGPUBufferBindingType_Uniform;
    fragment_entries[0].buffer.minBindingSize = 64;
    fragment_entries[1].binding = 1;
    fragment_entries[1].visibility = WGPUShaderStage_Fragment;
    fragment_entries[1].buffer.type = WGPUBufferBindingType_Uniform;
    fragment_entries[1].buffer.minBindingSize =
        upstream::sprite_fx_ubo_bytes;
    WGPUBindGroupLayoutDescriptor fragment_layout =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    fragment_layout.entryCount = custom_shader ? 2u : 1u;
    fragment_layout.entries = fragment_entries.data();
    layouts[3] = wgpuDeviceCreateBindGroupLayout(device, &fragment_layout);

    return layouts;
}

/**
 * One layer's pipeline and the shader modules it names.
 *
 * The uvScroll opt-in widens a layer's instance stride and adds an
 * attribute, so the layout participates in pipeline identity. Standalone
 * renderer passes retain their per-layer pipeline records; a scene pass
 * reuses the first compatible depth/blend/program/layout pipeline and bind
 * layouts, with ownership held by that first layer.
 */
inline WGPURenderPipeline create_dawn_sprite_layer_pipeline(
    WGPUDevice device,
    const std::array<WGPUBindGroupLayout, 4>& group_layouts,
    const SpriteBlendDescriptor& blend,
    const SpriteLayerPipelinePlan& plan,
    std::uint32_t custom_shader,
    WGPUTextureFormat target_format,
    WGPUTextureFormat depth_format,
    std::uint32_t sample_count) {
    WGPUShaderModule vertex_module = load_wgsl_module(
        device,
        plan.has_depth
            ? (plan.scroll
                  ? "sprite_depth_uvscroll.vert"
                  : "sprite_depth.vert")
            : (plan.scroll ? "sprite_uvscroll.vert" : "sprite.vert"));
    // The custom program replaces the fragment stage alone -- the pin
    // composes it from the same prologue -- so it pairs with whichever
    // vertex stage the layout chose.
    const std::string fragment_name =
        sprite_fragment_shader_name(custom_shader);
    WGPUShaderModule fragment_module = load_wgsl_module(
        device,
        fragment_name);

    // The generated instance layout (sprite_layer.hpp, from
    // sprite-pipeline.ts): the pure-2D attributes at their pinned byte
    // offsets, stepped per instance. Only the float count is translated
    // to this API's vertex formats.
    std::array<
        WGPUVertexAttribute,
        upstream::sprite_instance_attributes.size() + 2u>
        attributes{};
    const std::size_t attribute_count =
        upstream::sprite_instance_attributes.size() +
        (plan.has_depth ? 1u : 0u) + (plan.scroll ? 1u : 0u);
    for (std::size_t index = 0; index < attribute_count; ++index) {
        upstream::SpriteInstanceAttribute row{};
        if (index < upstream::sprite_instance_attributes.size()) {
            row = upstream::sprite_instance_attributes[index];
        } else if (
            plan.has_depth &&
            index == upstream::sprite_instance_attributes.size()) {
            row = upstream::sprite_depth_attribute;
        } else {
            row = upstream::sprite_uvscroll_attribute;
            row.byte_offset =
                plan.instance_stride_bytes - 2u * sizeof(float);
        }
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
    instance_layout.arrayStride = plan.instance_stride_bytes;
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
    WGPUDepthStencilState depth_state = WGPU_DEPTH_STENCIL_STATE_INIT;
    depth_state.format = depth_format;
    depth_state.depthCompare =
        dawn_depth_compare(upstream::pinned_depth_compare);
    depth_state.depthWriteEnabled = plan.depth_write
        ? WGPUOptionalBool_True
        : WGPUOptionalBool_False;
    descriptor.depthStencil = plan.has_depth ? &depth_state : nullptr;
    descriptor.multisample.count = sample_count;
    descriptor.multisample.mask = 0xFFFFFFFFu;
    descriptor.multisample.alphaToCoverageEnabled =
        plan.has_depth && plan.depth_write && plan.alpha_to_coverage &&
            sample_count > 1u
            ? WGPUOptionalBool_True
            : WGPUOptionalBool_False;
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
/**
 * Build the GPU resources for ONE layer: its bind-group layouts, pipeline,
 * buffers and atlas bindings.
 */
inline DawnSpriteLayer build_dawn_sprite_layer(
    WGPUDevice device,
    WGPUQueue queue,
    Engine& engine,
    Sprite2DLayerHandle handle,
    const DawnSpriteAtlasBinding& atlas_binding,
    WGPUTextureFormat target_format,
    WGPUTextureFormat depth_format = WGPUTextureFormat_Undefined,
    std::uint32_t sample_count = 1u,
    WGPURenderPipeline shared_pipeline = nullptr,
    std::array<WGPUBindGroupLayout, 4> shared_group_layouts = {}) {
    const Sprite2DLayerRecord& layer =
        engine.sprite_layers[handle.value];
    DawnSpriteLayer gpu;
    gpu.layer = handle;
    gpu.pipeline_version = layer.pipeline_version;
    gpu.owns_pipeline = shared_pipeline == nullptr;
    gpu.owns_group_layouts = shared_pipeline == nullptr;
    if (shared_pipeline) {
        gpu.group_layouts = shared_group_layouts;
        gpu.pipeline = shared_pipeline;
    } else {
        const SpriteLayerPipelinePlan plan =
            sprite_layer_pipeline_plan(layer);
        gpu.group_layouts = create_dawn_sprite_layer_layouts(
            device,
            layer.custom_shader,
            layer.custom_textures.size());
        gpu.pipeline = create_dawn_sprite_layer_pipeline(
            device,
            gpu.group_layouts,
            layer.blend,
            plan,
            layer.custom_shader,
            target_format,
            depth_format,
            sample_count);
    }

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
    gpu.instance_buffer_bytes = instance_descriptor.size;
    gpu.layer_uniforms = dawn_sprite_uniform_buffer(device);
    gpu.atlas = atlas_binding.texture;
    gpu.atlas_view = atlas_binding.view;
    gpu.sampler = atlas_binding.sampler;

    WGPUBindGroupEntry vertex_binding = WGPU_BIND_GROUP_ENTRY_INIT;
    vertex_binding.binding = 0;
    vertex_binding.buffer = gpu.layer_uniforms;
    vertex_binding.size = 64;
    WGPUBindGroupDescriptor vertex_group =
        WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    vertex_group.layout = gpu.group_layouts[1];
    vertex_group.entryCount = 1;
    vertex_group.entries = &vertex_binding;
    gpu.vertex_group =
        wgpuDeviceCreateBindGroup(device, &vertex_group);

    std::vector<WGPUBindGroupEntry> texture_bindings;
    append_dawn_texture_pair(
        texture_bindings,
        DawnSampledTexture{
            gpu.atlas, gpu.atlas_view, gpu.sampler});
    for (const PixelsTexture& extra : layer.custom_textures) {
        gpu.extras.push_back(
            upload_dawn_extra_texture(device, queue, extra));
        append_dawn_texture_pair(
            texture_bindings, gpu.extras.back());
    }
    WGPUBindGroupDescriptor texture_group =
        WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    texture_group.layout = gpu.group_layouts[2];
    texture_group.entryCount =
        static_cast<std::uint32_t>(texture_bindings.size());
    texture_group.entries = texture_bindings.data();
    gpu.texture_group =
        wgpuDeviceCreateBindGroup(device, &texture_group);

    std::array<WGPUBindGroupEntry, 2> fragment_bindings{};
    fragment_bindings[0] = WGPU_BIND_GROUP_ENTRY_INIT;
    fragment_bindings[1] = WGPU_BIND_GROUP_ENTRY_INIT;
    fragment_bindings[0].binding = 0;
    fragment_bindings[0].buffer = gpu.layer_uniforms;
    fragment_bindings[0].size = 64;
    if (layer.custom_shader) {
        gpu.fx_uniforms = dawn_sprite_uniform_buffer(
            device, upstream::sprite_fx_ubo_bytes);
        fragment_bindings[1].binding = 1;
        fragment_bindings[1].buffer = gpu.fx_uniforms;
        fragment_bindings[1].size = upstream::sprite_fx_ubo_bytes;
    }
    WGPUBindGroupDescriptor fragment_group =
        WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    fragment_group.layout = gpu.group_layouts[3];
    fragment_group.entryCount = layer.custom_shader ? 2u : 1u;
    fragment_group.entries = fragment_bindings.data();
    gpu.fragment_group =
    wgpuDeviceCreateBindGroup(device, &fragment_group);
    return gpu;
}

/** Release one layer's GPU objects. */
inline void release_dawn_sprite_layer(DawnSpriteLayer& layer) {
    if (layer.vertex_group) wgpuBindGroupRelease(layer.vertex_group);
    if (layer.texture_group) wgpuBindGroupRelease(layer.texture_group);
    if (layer.fragment_group) {
        wgpuBindGroupRelease(layer.fragment_group);
    }
    release_dawn_extra_textures(layer.extras);
    if (layer.owns_pipeline && layer.pipeline) {
        wgpuRenderPipelineRelease(layer.pipeline);
    }
    if (layer.instances) wgpuBufferRelease(layer.instances);
    if (layer.layer_uniforms) {
        wgpuBufferRelease(layer.layer_uniforms);
    }
    if (layer.fx_uniforms) wgpuBufferRelease(layer.fx_uniforms);
    if (layer.owns_group_layouts) {
        for (WGPUBindGroupLayout layout : layer.group_layouts) {
            if (layout) wgpuBindGroupLayoutRelease(layout);
        }
    }
}

/** Release only the per-layer GPU objects, keeping the shared index buffer. */
inline void release_dawn_sprite_pass_layers(DawnSpritePass& pass) {
    for (DawnSpriteLayer& layer : pass.layers) {
        release_dawn_sprite_layer(layer);
    }
    pass.layers.clear();
}

/**
 * Bring the pass's per-layer records in step with the renderer's list. Why
 * an entry moves rather than being rebuilt is the SDL_GPU sibling's.
 *
 * Releasing needs no wait here either: a WebGPU object is reference-counted
 * and a submitted command buffer holds its own reference, so releasing one
 * an in-flight frame still reads drops this code's reference and nothing
 * else. (The mesh-set rebuild in `pal_dawn.cpp` waits for a different
 * reason -- it re-uploads INTO buffers in-flight work reads.)
 */
inline void rebuild_dawn_sprite_pass_layers(
    WGPUDevice device,
    WGPUQueue queue,
    Engine& engine,
    DawnSpritePass& pass,
    const std::vector<WGPUTexture>& render_textures,
    const std::vector<WGPUTextureView>& render_texture_views) {
    const SpriteRendererRecord& renderer =
        engine.sprite_renderers[pass.renderer.value];
    std::vector<DawnSpriteLayer> next;
    next.reserve(renderer.layers.size());
    // Standalone membership is depth-guarded once, by the generated
    // add/create writers ("SpriteRenderer requires layers with depth ==
    // none."), so neither backend re-checks it here.
    for (const Sprite2DLayerHandle& handle : renderer.layers) {
        const Sprite2DLayerRecord& layer =
            engine.sprite_layers[handle.value];
        const auto found = std::find_if(
            pass.layers.begin(),
            pass.layers.end(),
            [&](const DawnSpriteLayer& candidate) {
                return candidate.layer.value == handle.value;
            });
        if (found != pass.layers.end()) {
            next.push_back(std::move(*found));
            pass.layers.erase(found);
            continue;
        }
        const DawnSpriteAtlasBinding& atlas_binding =
            ensure_dawn_sprite_atlas_binding(
                device,
                queue,
                engine,
                layer.atlas,
                render_textures,
                render_texture_views,
                pass.atlases);
        next.push_back(build_dawn_sprite_layer(
            device,
            queue,
            engine,
            handle,
            atlas_binding,
            pass.target_format));
    }
    // Whatever is left was dropped from the list.
    release_dawn_sprite_pass_layers(pass);
    pass.layers = std::move(next);
    for (auto atlas = pass.atlases.begin(); atlas != pass.atlases.end();) {
        const bool used = std::any_of(
            renderer.layers.begin(),
            renderer.layers.end(),
            [&](const Sprite2DLayerHandle handle) {
                return engine.sprite_layers[handle.value].atlas.value ==
                    atlas->handle.value;
            });
        if (used) {
            ++atlas;
        } else {
            release_dawn_sprite_atlas_binding(*atlas);
            atlas = pass.atlases.erase(atlas);
        }
    }
    pass.layers_version = renderer.layers_version;
}

/**
 * The version-guarded form, for the frame loop. Creation calls the rebuild
 * directly, for the reason its SDL_GPU sibling states.
 */
inline void sync_dawn_sprite_pass_layers(
    WGPUDevice device,
    WGPUQueue queue,
    Engine& engine,
    DawnSpritePass& pass,
    const std::vector<WGPUTexture>& render_textures,
    const std::vector<WGPUTextureView>& render_texture_views) {
    const SpriteRendererRecord& renderer =
        engine.sprite_renderers[pass.renderer.value];
    if (renderer.layers_version != pass.layers_version) {
        rebuild_dawn_sprite_pass_layers(
            device,
            queue,
            engine,
            pass,
            render_textures,
            render_texture_views);
    }
    for (std::size_t index = 0; index < renderer.layers.size(); ++index) {
        const Sprite2DLayerHandle handle = renderer.layers[index];
        const Sprite2DLayerRecord& layer =
            engine.sprite_layers[handle.value];
        DawnSpriteLayer& gpu = pass.layers[index];
        if (gpu.pipeline_version == layer.pipeline_version) {
            continue;
        }
        const double elapsed_ms = gpu.elapsed_ms;
        release_dawn_sprite_layer(gpu);
        gpu = build_dawn_sprite_layer(
            device,
            queue,
            engine,
            handle,
            find_dawn_sprite_atlas_binding(pass.atlases, layer.atlas),
            pass.target_format);
        gpu.elapsed_ms = elapsed_ms;
    }
}

inline DawnSpritePass create_dawn_sprite_pass(
    WGPUDevice device,
    WGPUQueue queue,
    Engine& engine,
    SpriteRendererHandle renderer_handle,
    const std::vector<WGPUTexture>& render_textures,
    const std::vector<WGPUTextureView>& render_texture_views,
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

    pass.target_format = target_format;
    rebuild_dawn_sprite_pass_layers(
        device,
        queue,
        engine,
        pass,
        render_textures,
        render_texture_views);
    return pass;
}

/**
 * `_update`: dirty instance data plus the per-layer UBO, which the pinned
 * `uploadLayer` also builds here because it depends on the target size.
 */
inline void upload_dawn_sprite_layer(
    WGPUDevice device,
    WGPUQueue queue,
    Engine& engine,
    Sprite2DLayerHandle handle,
    DawnSpriteLayer& gpu,
    std::uint32_t width,
    std::uint32_t height,
    float delta_ms) {
    Sprite2DLayerRecord& layer = engine.sprite_layers[handle.value];
    // sprite-renderable.ts uploadLayer returns here before FX, texture,
    // instance or UBO work. A hidden custom layer pauses its clock.
    if (!layer.visible || layer.count == 0) return;
    const std::uint64_t needed_bytes =
        static_cast<std::uint64_t>(layer.instance_data.size()) *
        sizeof(float);
    if (gpu.instance_buffer_bytes < needed_bytes) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.usage = WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst;
        descriptor.size = needed_bytes;
        WGPUBuffer replacement =
            wgpuDeviceCreateBuffer(device, &descriptor);
        if (!replacement) {
            dawn_error("wgpuDeviceCreateBuffer grown sprite instances");
        }
        wgpuBufferRelease(gpu.instances);
        gpu.instances = replacement;
        gpu.instance_buffer_bytes = needed_bytes;
        gpu.uploaded = false;
    }
    for (
        std::size_t extra_index = 0;
        extra_index < layer.custom_textures.size();
        ++extra_index) {
        const PixelsTexture& extra = layer.custom_textures[extra_index];
        DawnSampledTexture& uploaded = gpu.extras[extra_index];
        if (uploaded.uploaded_version != extra.version) {
            update_dawn_extra_texture(queue, uploaded, extra);
        }
    }
    if (!gpu.uploaded || gpu.uploaded_version != layer.version) {
        // The shared derivation (`resolve_sprite_dirty_range`) answers
        // which rows this copy uploads; only the write call is Dawn's.
        const auto [dirty_begin, dirty_end] =
            resolve_sprite_dirty_range(
                layer, gpu.uploaded, gpu.uploaded_version);
        // A Y-sorted layer stages its packed GPU-order rows here and hands
        // back the draw slots this copy transfers; every other layer gets
        // its own canonical rows back unchanged.
        const SpriteInstanceUpload transfer =
            resolve_sprite_instance_upload(
                engine, layer, dirty_begin, dirty_end);
        if (transfer.begin < transfer.end) {
            const std::size_t stride_bytes =
                layer.instance_floats_per_sprite * sizeof(float);
            wgpuQueueWriteBuffer(
                queue,
                gpu.instances,
                static_cast<std::uint64_t>(transfer.begin) * stride_bytes,
                transfer.data +
                    static_cast<std::size_t>(transfer.begin) *
                        layer.instance_floats_per_sprite,
                static_cast<std::size_t>(transfer.end - transfer.begin) *
                    stride_bytes);
            mark_sprite_dirty_range_consumed(layer);
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
    if (!gpu.layer_ubo_uploaded || gpu.uploaded_layer_ubo != ubo) {
        wgpuQueueWriteBuffer(
            queue, gpu.layer_uniforms, 0, ubo.data(), sizeof(ubo));
        gpu.uploaded_layer_ubo = ubo;
        gpu.layer_ubo_uploaded = true;
    }
    // The pin advances the clock and rewrites the fx block here, in
    // `_update`, whether or not the instance data moved.
    if (layer.custom_shader) {
        gpu.elapsed_ms += delta_ms;
        std::array<float, upstream::sprite_fx_ubo_bytes / 4u> fx{};
        upstream::build_sprite_fx_ubo(
            static_cast<float>(gpu.elapsed_ms / 1000.0),
            layer.shader_params,
            fx);
        wgpuQueueWriteBuffer(
            queue, gpu.fx_uniforms, 0, fx.data(), sizeof(fx));
    }
}

inline void upload_dawn_sprite_pass(
    WGPUDevice device,
    WGPUQueue queue,
    Engine& engine,
    DawnSpritePass& pass,
    std::uint32_t width,
    std::uint32_t height,
    float delta_ms) {
    const SpriteRendererRecord& renderer =
        engine.sprite_renderers[pass.renderer.value];
    for (std::size_t index = 0; index < renderer.layers.size(); ++index) {
        upload_dawn_sprite_layer(
            device,
            queue,
            engine,
            renderer.layers[index],
            pass.layers[index],
            width,
            height,
            delta_ms);
    }
}

inline void record_dawn_sprite_layer(
    WGPURenderPassEncoder encoder,
    const Sprite2DLayerRecord& layer,
    const DawnSpriteLayer& gpu) {
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

/** `_record`: encode the draws into a render pass the caller opened. */
inline void record_dawn_sprite_pass(
    WGPURenderPassEncoder encoder,
    Engine& engine,
    const DawnSpritePass& pass) {
    const SpriteRendererRecord& renderer =
        engine.sprite_renderers[pass.renderer.value];

    wgpuRenderPassEncoderSetIndexBuffer(
        encoder,
        pass.index_buffer,
        WGPUIndexFormat_Uint16,
        0,
        6u * sizeof(std::uint16_t));

    // The per-frame layer order (pal_gpu_shared.hpp): the pinned
    // by-`order` stable sort both backends draw with.
    if (renderer.layers.empty()) return;
    const std::vector<std::size_t> draw_order =
        sprite_layer_draw_order(engine, renderer);
    for (const std::size_t index : draw_order) {
        const Sprite2DLayerRecord& layer =
            engine.sprite_layers[renderer.layers[index].value];
        if (!layer.visible || layer.count == 0) {
            continue;
        }
        const DawnSpriteLayer& gpu = pass.layers[index];
        record_dawn_sprite_layer(encoder, layer, gpu);
    }
}

inline DawnSceneSpritePass create_dawn_scene_sprite_pass(
    WGPUDevice device,
    WGPUQueue queue,
    Engine& engine,
    const std::vector<Sprite2DLayerHandle>& handles,
    const std::vector<WGPUTexture>& render_textures,
    const std::vector<WGPUTextureView>& render_texture_views,
    WGPUTextureFormat target_format,
    WGPUTextureFormat depth_format,
    std::uint32_t sample_count) {
    DawnSceneSpritePass pass;
    pass.handles = handles;
    pass.target_format = target_format;
    pass.depth_format = depth_format;
    pass.sample_count = sample_count;
    const std::array<std::uint16_t, 6> quad_indices{
        0u, 1u, 2u, 0u, 2u, 3u};
    WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
    descriptor.usage = WGPUBufferUsage_Index | WGPUBufferUsage_CopyDst;
    descriptor.size = sizeof(quad_indices);
    pass.index_buffer = wgpuDeviceCreateBuffer(device, &descriptor);
    if (!pass.index_buffer) {
        dawn_error("wgpuDeviceCreateBuffer scene sprite indices");
    }
    wgpuQueueWriteBuffer(
        queue,
        pass.index_buffer,
        0,
        quad_indices.data(),
        sizeof(quad_indices));
    pass.layers.reserve(handles.size());
    for (const Sprite2DLayerHandle handle : handles) {
        const Sprite2DLayerRecord& layer =
            engine.sprite_layers[handle.value];
        if (layer.depth_mode == Sprite2DDepthMode::none) {
            throw std::runtime_error(
                "A scene-attached Sprite2D layer must have depth enabled.");
        }
        WGPURenderPipeline shared_pipeline = nullptr;
        std::array<WGPUBindGroupLayout, 4> shared_group_layouts{};
        for (std::size_t previous = 0; previous < pass.layers.size(); ++previous) {
            if (sprite_scene_pipeline_compatible(
                    engine.sprite_layers[pass.handles[previous].value],
                    engine.sprite_layers[handle.value])) {
                shared_pipeline = pass.layers[previous].pipeline;
                shared_group_layouts = pass.layers[previous].group_layouts;
                break;
            }
        }
        const DawnSpriteAtlasBinding& atlas_binding =
            ensure_dawn_sprite_atlas_binding(
                device,
                queue,
                engine,
                layer.atlas,
                render_textures,
                render_texture_views,
                pass.atlases);
        pass.layers.push_back(build_dawn_sprite_layer(
            device,
            queue,
            engine,
            handle,
            atlas_binding,
            target_format,
            depth_format,
            sample_count,
            shared_pipeline,
            shared_group_layouts));
    }
    return pass;
}

inline void sync_dawn_scene_sprite_pass_pipelines(
    WGPUDevice device,
    WGPUQueue queue,
    Engine& engine,
    DawnSceneSpritePass& pass) {
    bool rebuild = false;
    for (std::size_t index = 0; index < pass.handles.size(); ++index) {
        const Sprite2DLayerRecord& layer =
            engine.sprite_layers[pass.handles[index].value];
        if (layer.depth_mode == Sprite2DDepthMode::none) {
            throw std::runtime_error(
                "A scene-attached Sprite2D layer must have depth enabled.");
        }
        rebuild = rebuild ||
            pass.layers[index].pipeline_version != layer.pipeline_version;
    }
    if (!rebuild) return;

    std::vector<double> elapsed_ms;
    elapsed_ms.reserve(pass.layers.size());
    for (const DawnSpriteLayer& layer : pass.layers) {
        elapsed_ms.push_back(layer.elapsed_ms);
    }
    // Compatible layers borrow layouts and pipelines from an earlier owner,
    // so tear borrowers down first before selecting the new ownership graph.
    for (auto layer = pass.layers.rbegin(); layer != pass.layers.rend(); ++layer) {
        release_dawn_sprite_layer(*layer);
    }
    pass.layers.clear();
    pass.layers.reserve(pass.handles.size());
    for (std::size_t index = 0; index < pass.handles.size(); ++index) {
        const Sprite2DLayerHandle handle = pass.handles[index];
        const Sprite2DLayerRecord& layer =
            engine.sprite_layers[handle.value];
        WGPURenderPipeline shared_pipeline = nullptr;
        std::array<WGPUBindGroupLayout, 4> shared_group_layouts{};
        for (std::size_t previous = 0; previous < pass.layers.size(); ++previous) {
            if (sprite_scene_pipeline_compatible(
                    engine.sprite_layers[pass.handles[previous].value],
                    layer)) {
                shared_pipeline = pass.layers[previous].pipeline;
                shared_group_layouts = pass.layers[previous].group_layouts;
                break;
            }
        }
        pass.layers.push_back(build_dawn_sprite_layer(
            device,
            queue,
            engine,
            handle,
            find_dawn_sprite_atlas_binding(pass.atlases, layer.atlas),
            pass.target_format,
            pass.depth_format,
            pass.sample_count,
            shared_pipeline,
            shared_group_layouts));
        pass.layers.back().elapsed_ms = elapsed_ms[index];
    }
}

inline void upload_dawn_scene_sprite_pass(
    WGPUDevice device,
    WGPUQueue queue,
    Engine& engine,
    DawnSceneSpritePass& pass,
    std::uint32_t width,
    std::uint32_t height,
    float delta_ms) {
    sync_dawn_scene_sprite_pass_pipelines(
        device, queue, engine, pass);
    for (std::size_t index = 0; index < pass.handles.size(); ++index) {
        upload_dawn_sprite_layer(
            device,
            queue,
            engine,
            pass.handles[index],
            pass.layers[index],
            width,
            height,
            delta_ms);
    }
}

inline void record_dawn_scene_sprite_pass(
    WGPURenderPassEncoder encoder,
    Engine& engine,
    const DawnSceneSpritePass& pass,
    Sprite2DDepthMode depth_mode) {
    wgpuRenderPassEncoderSetIndexBuffer(
        encoder,
        pass.index_buffer,
        WGPUIndexFormat_Uint16,
        0,
        6u * sizeof(std::uint16_t));
    // Scene renderables carry fixed order 100/200 from their depth bucket;
    // layer.order belongs only to a standalone SpriteRenderer. Preserve the
    // scene's stable insertion order inside the selected bucket.
    for (std::size_t index = 0; index < pass.handles.size(); ++index) {
        const Sprite2DLayerRecord& layer =
            engine.sprite_layers[pass.handles[index].value];
        if (
            layer.depth_mode != depth_mode || !layer.visible ||
            layer.count == 0) {
            continue;
        }
        record_dawn_sprite_layer(encoder, layer, pass.layers[index]);
    }
}

inline void release_dawn_scene_sprite_pass(DawnSceneSpritePass& pass) {
    // Borrowers release their bind groups before the first compatible layer
    // releases the layouts and pipeline they share.
    for (auto layer = pass.layers.rbegin(); layer != pass.layers.rend(); ++layer) {
        release_dawn_sprite_layer(*layer);
    }
    pass.layers.clear();
    release_dawn_sprite_atlas_bindings(pass.atlases);
    if (pass.index_buffer) {
        wgpuBufferRelease(pass.index_buffer);
        pass.index_buffer = nullptr;
    }
}

inline void release_dawn_sprite_pass(DawnSpritePass& pass) {
    release_dawn_sprite_pass_layers(pass);
    release_dawn_sprite_atlas_bindings(pass.atlases);
    if (pass.index_buffer) {
        wgpuBufferRelease(pass.index_buffer);
        pass.index_buffer = nullptr;
    }
}

} // namespace bbl::pal

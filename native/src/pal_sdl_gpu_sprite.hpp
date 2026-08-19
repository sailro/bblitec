#pragma once

// The pure-2D sprite pass on SDL_GPU.
//
// A `SpriteRenderer` is a rendering CONTEXT on the engine, not a renderer of
// its own. Upstream's frame loop walks `engine._renderingContexts`, calling
// `_update` on each and then `_record` on each, so a `SceneContext` and a
// `SpriteRenderer` compose into one frame — that is how the pinned corpus
// draws a HUD over 3D (scene 52). Owning a window, a device and a loop would
// make that composition impossible, so this header holds only the context's
// two halves:
//
//   `upload_sprite_pass`  — `_update`: dirty instance data, before the
//                           frame's command buffer is acquired, because
//                           D3D12 rejects an upload interleaved with a draw
//                           across two open command lists.
//   `record_sprite_pass`  — `_record`: bind and draw into a render pass the
//                           caller already opened, so the caller decides the
//                           target and whether it clears or loads.
//
// SDL_GPU only. Nothing here is shared with Dawn, which owns the same two
// halves for itself in `pal_dawn_sprite.hpp`.

#include <bblite/runtime.hpp>
#include <bblite/upstream/sprite_layer.hpp>

#include <algorithm>
#include <array>
#include <cstdint>
#include <stdexcept>
#include <vector>

#include <SDL3/SDL.h>
#include <SDL3/SDL_gpu.h>

#include "pal_gpu_shared.hpp"
#include "pal_sdl_gpu_shared.hpp"

namespace bbl::pal {
/** Per-layer GPU state, matching the pinned `LayerGpu`. */
struct SpriteLayerGpu {
    // One pipeline per layer: the uvScroll opt-in widens a layer's stride
    // and adds an attribute, so the layout a pipeline describes is the
    // layer's, not the renderer's. The pin keys its own cache the same way.
    SDL_GPUGraphicsPipeline* pipeline = nullptr;
    SDL_GPUBuffer* instances = nullptr;
    SDL_GPUTexture* atlas = nullptr;
    SDL_GPUSampler* sampler = nullptr;
    std::uint64_t uploaded_version = 0;
    bool uploaded = false;
};

/** One registered `SpriteRenderer`, as GPU resources. */
struct SpritePass {
    SDL_GPUBuffer* index_buffer = nullptr;
    std::vector<SpriteLayerGpu> layers;
    SpriteRendererHandle renderer{};
};

inline SDL_GPUBlendFactor sprite_blend_factor(SpriteBlendFactor factor) {
    switch (factor) {
        case SpriteBlendFactor::zero:
            return SDL_GPU_BLENDFACTOR_ZERO;
        case SpriteBlendFactor::one:
            return SDL_GPU_BLENDFACTOR_ONE;
        case SpriteBlendFactor::src_alpha:
            return SDL_GPU_BLENDFACTOR_SRC_ALPHA;
        case SpriteBlendFactor::one_minus_src_alpha:
            return SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
        case SpriteBlendFactor::dst:
            return SDL_GPU_BLENDFACTOR_DST_COLOR;
        case SpriteBlendFactor::dst_alpha:
            return SDL_GPU_BLENDFACTOR_DST_ALPHA;
    }
    return SDL_GPU_BLENDFACTOR_ONE;
}

/**
 * One layer's pipeline.
 *
 * The uvScroll opt-in widens a layer's instance stride and adds an
 * attribute, so the layout a pipeline describes belongs to the layer
 * rather than to the renderer it draws in. The pin keys a shared cache on
 * that layout instead; one pipeline per layer is the same picture while a
 * renderer holds one layer of each layout, which is every reached scene.
 */
inline SDL_GPUGraphicsPipeline* create_sprite_layer_pipeline(
    SDL_GPUDevice* device,
    const SpriteBlendDescriptor& blend,
    bool scroll,
    SDL_GPUTextureFormat target_format) {
    SDL_GPUShader* vertex_shader = load_shader(
        device,
        scroll ? "sprite_uvscroll.vert" : "sprite.vert",
        SDL_GPU_SHADERSTAGE_VERTEX,
        0,
        1,
        "mainVertex");
    SDL_GPUShader* fragment_shader = load_shader(
        device,
        "sprite.frag",
        SDL_GPU_SHADERSTAGE_FRAGMENT,
        1,
        1,
        "mainFragment");

    // The generated instance layout (sprite_layer.hpp, from
    // sprite-pipeline.ts): instance-stepped attributes at the pinned byte
    // offsets, triangle list, no culling, single sample. Only the float
    // count is translated to this API's element formats.
    std::array<
        SDL_GPUVertexAttribute,
        upstream::sprite_instance_attributes.size() + 1u>
        attributes{};
    const std::size_t attribute_count =
        upstream::sprite_instance_attributes.size() + (scroll ? 1u : 0u);
    for (std::size_t index = 0; index < attribute_count; ++index) {
        const upstream::SpriteInstanceAttribute& row =
            index < upstream::sprite_instance_attributes.size()
                ? upstream::sprite_instance_attributes[index]
                : upstream::sprite_uvscroll_attribute;
        SDL_GPUVertexElementFormat format =
            SDL_GPU_VERTEXELEMENTFORMAT_FLOAT;
        switch (row.float_count) {
            case 1u:
                format = SDL_GPU_VERTEXELEMENTFORMAT_FLOAT;
                break;
            case 2u:
                format = SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2;
                break;
            case 3u:
                format = SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3;
                break;
            case 4u:
                format = SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4;
                break;
            default:
                throw std::runtime_error(
                    "Sprite instance attribute has an unsupported float "
                    "count.");
        }
        attributes[index] = SDL_GPUVertexAttribute{
            row.shader_location,
            0,
            format,
            row.byte_offset};
    }
    SDL_GPUVertexBufferDescription instance_buffer{};
    instance_buffer.slot = 0;
    instance_buffer.pitch = scroll
        ? upstream::sprite_uvscroll_stride_bytes
        : upstream::sprite_instance_stride_bytes;
    instance_buffer.input_rate = SDL_GPU_VERTEXINPUTRATE_INSTANCE;
    instance_buffer.instance_step_rate = 0;

    SDL_GPUColorTargetDescription target{};
    target.format = target_format;
    target.blend_state.enable_blend = blend.enabled;
    target.blend_state.src_color_blendfactor =
        sprite_blend_factor(blend.color.src);
    target.blend_state.dst_color_blendfactor =
        sprite_blend_factor(blend.color.dst);
    target.blend_state.color_blend_op = SDL_GPU_BLENDOP_ADD;
    target.blend_state.src_alpha_blendfactor =
        sprite_blend_factor(blend.alpha.src);
    target.blend_state.dst_alpha_blendfactor =
        sprite_blend_factor(blend.alpha.dst);
    target.blend_state.alpha_blend_op = SDL_GPU_BLENDOP_ADD;
    target.blend_state.color_write_mask =
        SDL_GPU_COLORCOMPONENT_R | SDL_GPU_COLORCOMPONENT_G |
        SDL_GPU_COLORCOMPONENT_B | SDL_GPU_COLORCOMPONENT_A;

    SDL_GPUGraphicsPipelineCreateInfo pipeline_info{};
    pipeline_info.vertex_shader = vertex_shader;
    pipeline_info.fragment_shader = fragment_shader;
    pipeline_info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    pipeline_info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
    pipeline_info.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
    pipeline_info.vertex_input_state.vertex_buffer_descriptions =
        &instance_buffer;
    pipeline_info.vertex_input_state.num_vertex_buffers = 1;
    pipeline_info.vertex_input_state.vertex_attributes = attributes.data();
    pipeline_info.vertex_input_state.num_vertex_attributes =
        static_cast<Uint32>(attribute_count);
    pipeline_info.target_info.color_target_descriptions = &target;
    pipeline_info.target_info.num_color_targets = 1;
    SDL_GPUGraphicsPipeline* pipeline = SDL_CreateGPUGraphicsPipeline(device, &pipeline_info);
    if (!pipeline) {
        gpu_error("SDL_CreateGPUGraphicsPipeline sprite");
    }
    SDL_ReleaseGPUShader(device, vertex_shader);
    SDL_ReleaseGPUShader(device, fragment_shader);
    return pipeline;
}
/**
 * Build the pipeline and per-layer resources for one registered renderer.
 * `target_format` is the format of the colour attachment the caller will
 * record into; the pass is always single-sampled, as the pinned renderer's
 * own `sampleCount: 1` swapchain pass is.
 */
inline SpritePass create_sprite_pass(
    SDL_GPUDevice* device,
    Engine& engine,
    SpriteRendererHandle renderer_handle,
    SDL_GPUTextureFormat target_format) {
    const SpriteRendererRecord& renderer =
        engine.sprite_renderers[renderer_handle.value];
    if (renderer.layers.empty()) {
        throw std::runtime_error("SpriteRenderer has no layers.");
    }
    SpritePass pass;
    pass.renderer = renderer_handle;

    // The shared two-triangle quad every sprite instance draws.
    const std::array<std::uint16_t, 6> quad_indices{
        0u, 1u, 2u, 0u, 2u, 3u};
    pass.index_buffer = upload_buffer(
        device,
        SDL_GPU_BUFFERUSAGE_INDEX,
        quad_indices.data(),
        quad_indices.size() * sizeof(std::uint16_t));

    pass.layers.resize(renderer.layers.size());
    for (std::size_t index = 0; index < renderer.layers.size(); ++index) {
        const Sprite2DLayerRecord& layer =
            engine.sprite_layers[renderer.layers[index].value];
        const SpriteAtlasRecord& atlas =
            engine.sprite_atlases[layer.atlas.value];
        SpriteLayerGpu& gpu = pass.layers[index];
        gpu.pipeline = create_sprite_layer_pipeline(
            device,
            layer.blend,
            layer.uv_scroll,
            target_format);
        SDL_GPUBufferCreateInfo buffer_info{};
        buffer_info.usage = SDL_GPU_BUFFERUSAGE_VERTEX;
        buffer_info.size = static_cast<Uint32>(
            layer.instance_data.size() * sizeof(float));
        gpu.instances = SDL_CreateGPUBuffer(device, &buffer_info);
        if (!gpu.instances) {
            gpu_error("SDL_CreateGPUBuffer sprite instances");
        }
        // rgba8unorm: `loadTexture2D` leaves srgb off, so the atlas
        // texels reach the blend stage as the bytes on disk.
        gpu.atlas = upload_2d_texture(
            device,
            atlas.rgba.data(),
            atlas.rgba.size(),
            atlas.width,
            atlas.height,
            SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
            "sprite atlas");
        gpu.sampler = create_texture_sampler(device, atlas.sampler);
    }
    return pass;
}

/**
 * `_update`: re-upload the layers whose CPU data moved. Runs on its own
 * command buffer, so callers must call it before acquiring the frame's.
 */
inline void upload_sprite_pass(
    SDL_GPUDevice* device,
    Engine& engine,
    SpritePass& pass) {
    const SpriteRendererRecord& renderer =
        engine.sprite_renderers[pass.renderer.value];
    for (std::size_t index = 0; index < renderer.layers.size(); ++index) {
        Sprite2DLayerRecord& layer =
            engine.sprite_layers[renderer.layers[index].value];
        SpriteLayerGpu& gpu = pass.layers[index];
        if (gpu.uploaded && gpu.uploaded_version == layer.version) {
            continue;
        }
        if (layer.count > 0) {
            update_buffer(
                device,
                gpu.instances,
                layer.instance_data.data(),
                static_cast<std::size_t>(layer.count) *
                    layer.instance_floats_per_sprite * sizeof(float));
        }
        gpu.uploaded = true;
        gpu.uploaded_version = layer.version;
    }
}

/**
 * `_record`: encode the renderer's draws into an already-open render pass.
 * The caller owns the target and its load op, which is what lets a scene
 * renderer append a HUD to its own frame and a sprite-only driver clear and
 * draw into a frame of its own.
 */
inline void record_sprite_pass(
    SDL_GPUCommandBuffer* command,
    SDL_GPURenderPass* render_pass,
    Engine& engine,
    const SpritePass& pass,
    std::uint32_t width,
    std::uint32_t height) {
    const SpriteRendererRecord& renderer =
        engine.sprite_renderers[pass.renderer.value];

    const SDL_GPUBufferBinding index_binding{pass.index_buffer, 0};
    SDL_BindGPUIndexBuffer(
        render_pass, &index_binding, SDL_GPU_INDEXELEMENTSIZE_16BIT);

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
        const SpriteLayerGpu& gpu = pass.layers[index];
        SDL_BindGPUGraphicsPipeline(render_pass, gpu.pipeline);
        std::array<float, 16> ubo{};
        upstream::build_sprite_layer_ubo(
            layer,
            static_cast<float>(width),
            static_cast<float>(height),
            ubo);
        SDL_PushGPUVertexUniformData(command, 0, ubo.data(), sizeof(ubo));
        SDL_PushGPUFragmentUniformData(command, 0, ubo.data(), sizeof(ubo));
        const SDL_GPUTextureSamplerBinding atlas_binding{
            gpu.atlas, gpu.sampler};
        SDL_BindGPUFragmentSamplers(render_pass, 0, &atlas_binding, 1);
        const SDL_GPUBufferBinding instance_binding{gpu.instances, 0};
        SDL_BindGPUVertexBuffers(render_pass, 0, &instance_binding, 1);
        SDL_DrawGPUIndexedPrimitives(
            render_pass, 6, layer.count, 0, 0, 0);
    }
}

inline void release_sprite_pass(
    SDL_GPUDevice* device,
    SpritePass& pass) {
    for (SpriteLayerGpu& layer : pass.layers) {
        if (layer.pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(device, layer.pipeline);
        }
        if (layer.instances) SDL_ReleaseGPUBuffer(device, layer.instances);
        if (layer.atlas) SDL_ReleaseGPUTexture(device, layer.atlas);
        if (layer.sampler) SDL_ReleaseGPUSampler(device, layer.sampler);
    }
    pass.layers.clear();
    if (pass.index_buffer) {
        SDL_ReleaseGPUBuffer(device, pass.index_buffer);
        pass.index_buffer = nullptr;
    }
}

} // namespace bbl::pal

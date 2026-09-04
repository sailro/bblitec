#pragma once

// The Sprite2D passes on SDL_GPU: standalone SpriteRenderer contexts and the
// depth-hosted layer lane recorded inside a scene pass.
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
    // Which layer this belongs to. The pin keys `sr._layerGpu` by the layer
    // object for the same reason: a membership change must move an entry,
    // not rebuild it -- `elapsed_ms` below is a per-layer clock that a
    // rebuild would reset for layers nobody touched.
    Sprite2DLayerHandle layer{};
    // One pipeline per layer: the uvScroll opt-in widens a layer's stride
    // and adds an attribute, so the layout a pipeline describes is the
    // layer's, not the renderer's. The pin keys its own cache the same way.
    SDL_GPUGraphicsPipeline* pipeline = nullptr;
    SDL_GPUBuffer* instances = nullptr;
    std::size_t instance_buffer_bytes = 0;
    // Scene passes share an identical fixed-function/program pipeline. The
    // first compatible layer owns it; later layers only borrow it.
    bool owns_pipeline = true;
    // Owners stay atlas-then-extras for updates and release. The bound list
    // follows the compacted fragment sidecar and may omit either.
    std::vector<SDL_GPUTextureSamplerBinding> textures;
    std::vector<SDL_GPUTextureSamplerBinding> bound_textures;
    std::vector<std::uint64_t> extra_uploaded_versions;
    std::uint64_t uploaded_version = 0;
    std::uint64_t pipeline_version = 0;
    bool uploaded = false;
    // Where this layer's fragment stage kept its two uniform blocks, from
    // the sidecar the shader step wrote beside it. A custom body that reads
    // neither leaves both at -1.
    int layer_block_slot = 0;
    int fx_block_slot = -1;
    // The custom shader's own clock: seconds since this layer's first
    // frame, which the pin accumulates inside the layer's fx attachment.
    // JavaScript `number` accumulation stays double precision; only the
    // final SpriteFx UBO write narrows to f32.
    double elapsed_ms = 0.0;
};

/** One pass-owned atlas texture/sampler pair, borrowed by every layer. */
struct SpriteAtlasGpu {
    SpriteAtlasHandle atlas{};
    SDL_GPUTexture* texture = nullptr;
    SDL_GPUSampler* sampler = nullptr;
    // Render textures belong to the driver; decoded atlas textures belong
    // to this cache. The sampler is always cache-owned.
    bool owns_texture = false;
};

/** One registered `SpriteRenderer`, as GPU resources. */
struct SpritePass {
    SDL_GPUBuffer* index_buffer = nullptr;
    std::vector<SpriteLayerGpu> layers;
    std::vector<SpriteAtlasGpu> atlases;
    SpriteRendererHandle renderer{};
    // The renderer's layer list this pass was synchronized against; a bump
    // is what makes `sync_sprite_pass_layers` walk it again.
    std::uint64_t layers_version = 0;
    // The colour attachment's format, so a layer added later builds its
    // pipeline against the same target without the caller threading it back
    // through every frame.
    SDL_GPUTextureFormat target_format = SDL_GPU_TEXTUREFORMAT_INVALID;
};

/** Sprite layers attached to the scene's depth-hosted renderable lane. */
struct SceneSpritePass {
    SDL_GPUBuffer* index_buffer = nullptr;
    std::vector<SpriteLayerGpu> layers;
    std::vector<SpriteAtlasGpu> atlases;
    std::vector<Sprite2DLayerHandle> handles;
    SDL_GPUTextureFormat target_format = SDL_GPU_TEXTUREFORMAT_INVALID;
    SDL_GPUTextureFormat depth_format = SDL_GPU_TEXTUREFORMAT_INVALID;
    SDL_GPUSampleCount sample_count = SDL_GPU_SAMPLECOUNT_1;
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
 * attribute, so the layout participates in pipeline identity. Standalone
 * renderer passes retain their per-layer pipeline records; a scene pass
 * reuses the first compatible depth/blend/program/layout pipeline and gives
 * ownership only to that first layer, mirroring the pin's shared cache for
 * the multi-layer case.
 */
inline SDL_GPUGraphicsPipeline* create_sprite_layer_pipeline(
    SDL_GPUDevice* device,
    const SpriteBlendDescriptor& blend,
    bool scroll,
    bool has_depth,
    bool depth_write,
    bool alpha_to_coverage,
    std::uint32_t custom_shader,
    const PinnedStageSlots& slots,
    SDL_GPUTextureFormat target_format,
    SDL_GPUTextureFormat depth_format,
    SDL_GPUSampleCount sample_count,
    std::uint32_t instance_stride_bytes) {
    SDL_GPUShader* vertex_shader = load_shader(
        device,
        has_depth
            ? (scroll ? "sprite_depth_uvscroll.vert" : "sprite_depth.vert")
            : (scroll ? "sprite_uvscroll.vert" : "sprite.vert"),
        SDL_GPU_SHADERSTAGE_VERTEX,
        0,
        1,
        "mainVertex");
    // The custom program replaces the fragment stage alone -- the pin
    // composes it from the same prologue -- so it pairs with whichever
    // vertex stage the layout chose, and adds the fx block as a second
    // fragment uniform.
    const std::string fragment_name =
        sprite_fragment_shader_name(custom_shader);
    SDL_GPUShader* fragment_shader = load_shader(
        device,
        fragment_name.c_str(),
        SDL_GPU_SHADERSTAGE_FRAGMENT,
        static_cast<std::uint32_t>(slots.textures.size()),
        static_cast<std::uint32_t>(slots.uniforms.size()),
        "mainFragment");

    // The generated instance layout (sprite_layer.hpp, from
    // sprite-pipeline.ts): instance-stepped attributes at the pinned byte
    // offsets, triangle list, no culling, single sample. Only the float
    // count is translated to this API's element formats.
    std::array<
        SDL_GPUVertexAttribute,
        upstream::sprite_instance_attributes.size() + 2u>
        attributes{};
    const std::size_t attribute_count =
        upstream::sprite_instance_attributes.size() +
        (has_depth ? 1u : 0u) + (scroll ? 1u : 0u);
    for (std::size_t index = 0; index < attribute_count; ++index) {
        upstream::SpriteInstanceAttribute row{};
        if (index < upstream::sprite_instance_attributes.size()) {
            row = upstream::sprite_instance_attributes[index];
        } else if (
            has_depth &&
            index == upstream::sprite_instance_attributes.size()) {
            row = upstream::sprite_depth_attribute;
        } else {
            row = upstream::sprite_uvscroll_attribute;
            row.byte_offset = instance_stride_bytes - 2u * sizeof(float);
        }
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
    instance_buffer.pitch = instance_stride_bytes;
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
    pipeline_info.multisample_state.sample_count = sample_count;
    pipeline_info.multisample_state.enable_alpha_to_coverage =
        has_depth && depth_write && alpha_to_coverage &&
        sample_count != SDL_GPU_SAMPLECOUNT_1;
    pipeline_info.vertex_input_state.vertex_buffer_descriptions =
        &instance_buffer;
    pipeline_info.vertex_input_state.num_vertex_buffers = 1;
    pipeline_info.vertex_input_state.vertex_attributes = attributes.data();
    pipeline_info.vertex_input_state.num_vertex_attributes =
        static_cast<Uint32>(attribute_count);
    pipeline_info.target_info.color_target_descriptions = &target;
    pipeline_info.target_info.num_color_targets = 1;
    if (has_depth) {
        pipeline_info.depth_stencil_state.compare_op =
            gpu_depth_compare(upstream::pinned_depth_compare);
        pipeline_info.depth_stencil_state.enable_depth_test = true;
        pipeline_info.depth_stencil_state.enable_depth_write = depth_write;
        pipeline_info.target_info.depth_stencil_format = depth_format;
        pipeline_info.target_info.has_depth_stencil_target = true;
    }
    SDL_GPUGraphicsPipeline* pipeline = SDL_CreateGPUGraphicsPipeline(device, &pipeline_info);
    if (!pipeline) {
        gpu_error("SDL_CreateGPUGraphicsPipeline sprite");
    }
    SDL_ReleaseGPUShader(device, vertex_shader);
    SDL_ReleaseGPUShader(device, fragment_shader);
    return pipeline;
}

inline SDL_GPUGraphicsPipeline* create_sprite_layer_pipeline(
    SDL_GPUDevice* device,
    const Sprite2DLayerRecord& layer,
    const PinnedStageSlots& slots,
    SDL_GPUTextureFormat target_format,
    SDL_GPUTextureFormat depth_format,
    SDL_GPUSampleCount sample_count) {
    const SpriteLayerPipelinePlan plan =
        sprite_layer_pipeline_plan(layer);
    return create_sprite_layer_pipeline(
        device,
        layer.blend,
        plan.scroll,
        plan.has_depth,
        plan.depth_write,
        plan.alpha_to_coverage,
        layer.custom_shader,
        slots,
        target_format,
        depth_format,
        sample_count,
        plan.instance_stride_bytes);
}

inline SpriteAtlasGpu& sprite_atlas_gpu(
    SDL_GPUDevice* device,
    Engine& engine,
    SpriteAtlasHandle handle,
    const std::vector<SDL_GPUTexture*>& render_textures,
    std::vector<SpriteAtlasGpu>& cache) {
    const auto found = std::find_if(
        cache.begin(),
        cache.end(),
        [&](const SpriteAtlasGpu& candidate) {
            return candidate.atlas.value == handle.value;
        });
    if (found != cache.end()) return *found;

    const SpriteAtlasRecord& atlas = engine.sprite_atlases[handle.value];
    SpriteAtlasGpu gpu;
    gpu.atlas = handle;
    gpu.texture = atlas.has_render_texture
        ? render_textures[atlas.render_texture.value]
        : upload_2d_texture(
            device,
            atlas.rgba.data(),
            atlas.rgba.size(),
            atlas.width,
            atlas.height,
            SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
            "sprite atlas");
    gpu.sampler = create_texture_sampler(device, atlas.sampler);
    gpu.owns_texture = !atlas.has_render_texture;
    cache.push_back(gpu);
    return cache.back();
}

inline void release_sprite_atlas_gpu(
    SDL_GPUDevice* device,
    SpriteAtlasGpu& atlas) {
    if (atlas.owns_texture && atlas.texture) {
        SDL_ReleaseGPUTexture(device, atlas.texture);
    }
    if (atlas.sampler) SDL_ReleaseGPUSampler(device, atlas.sampler);
}

inline void release_sprite_atlas_cache(
    SDL_GPUDevice* device,
    std::vector<SpriteAtlasGpu>& cache) {
    for (SpriteAtlasGpu& atlas : cache) {
        release_sprite_atlas_gpu(device, atlas);
    }
    cache.clear();
}
/**
 * Build the GPU resources for ONE layer: its pipeline, instance buffer and
 * texture bindings. `target_format` is the colour attachment format.
 * Standalone renderers stay single-sampled; a depth-hosted scene layer
 * receives that scene's depth format and multisample count.
 */
inline SpriteLayerGpu build_sprite_layer_gpu(
    SDL_GPUDevice* device,
    Engine& engine,
    Sprite2DLayerHandle handle,
    const std::vector<SDL_GPUTexture*>& render_textures,
    std::vector<SpriteAtlasGpu>& atlas_cache,
    SDL_GPUTextureFormat target_format,
    SDL_GPUTextureFormat depth_format = SDL_GPU_TEXTUREFORMAT_INVALID,
    SDL_GPUSampleCount sample_count = SDL_GPU_SAMPLECOUNT_1,
    SDL_GPUGraphicsPipeline* shared_pipeline = nullptr) {
    Sprite2DLayerRecord& layer =
        engine.sprite_layers[handle.value];
    SpriteLayerGpu gpu;
    gpu.layer = handle;
    const std::string fragment_name =
        sprite_fragment_shader_name(layer.custom_shader);
    const PinnedStageSlots slots = read_pinned_stage_slots(
        fragment_name);
    gpu.layer_block_slot = stage_uniform_slot(slots, "L");
    gpu.fx_block_slot = stage_uniform_slot(slots, "fx");
    gpu.pipeline = shared_pipeline;
    gpu.owns_pipeline = shared_pipeline == nullptr;
    gpu.pipeline_version = layer.pipeline_version;
    if (!gpu.pipeline) {
        gpu.pipeline = create_sprite_layer_pipeline(
            device,
            layer,
            slots,
            target_format,
            depth_format,
            sample_count);
    }
    SDL_GPUBufferCreateInfo buffer_info{};
    buffer_info.usage = SDL_GPU_BUFFERUSAGE_VERTEX;
    buffer_info.size = static_cast<Uint32>(
        layer.instance_data.size() * sizeof(float));
    gpu.instances = SDL_CreateGPUBuffer(device, &buffer_info);
    if (!gpu.instances) {
        gpu_error("SDL_CreateGPUBuffer sprite instances");
    }
    gpu.instance_buffer_bytes = buffer_info.size;
    layer.dirty_sprite_begin = layer.count == 0u ? invalid_handle : 0u;
    layer.dirty_sprite_end = layer.count;
    // rgba8unorm: `loadTexture2D` leaves srgb off, so the atlas
    // texels reach the blend stage as the bytes on disk.
    SpriteAtlasGpu& atlas_gpu = sprite_atlas_gpu(
        device,
        engine,
        layer.atlas,
        render_textures,
        atlas_cache);
    gpu.textures = sprite_fragment_textures(
        device,
        atlas_gpu.texture,
        atlas_gpu.sampler,
        layer.custom_textures,
        "sprite custom texture");
    gpu.bound_textures = select_sprite_fragment_textures(
        slots,
        gpu.textures,
        layer.custom_texture_names,
        "sprite fragment shader");
    gpu.extra_uploaded_versions.reserve(
        layer.custom_textures.size());
    for (const PixelsTexture& extra : layer.custom_textures) {
        gpu.extra_uploaded_versions.push_back(extra.version);
    }
    return gpu;
}

/** Release one layer's GPU objects. */
inline void release_sprite_layer_gpu(
    SDL_GPUDevice* device,
    SpriteLayerGpu& layer) {
    if (layer.owns_pipeline && layer.pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(device, layer.pipeline);
    }
    if (layer.instances) SDL_ReleaseGPUBuffer(device, layer.instances);
    // The pass-level atlas cache owns both entries in slot zero. Extras
    // remain layer-owned and are released by the generic helper.
    if (!layer.textures.empty()) {
        layer.textures[0].texture = nullptr;
        layer.textures[0].sampler = nullptr;
    }
    release_sprite_fragment_textures(device, layer.textures);
}

/** Release only the per-layer GPU objects, keeping the shared index buffer. */
inline void release_sprite_pass_layers(
    SDL_GPUDevice* device,
    SpritePass& pass) {
    for (SpriteLayerGpu& layer : pass.layers) {
        release_sprite_layer_gpu(device, layer);
    }
    pass.layers.clear();
}

/**
 * Bring the pass's per-layer records in step with the renderer's list.
 *
 * The pin keys `sr._layerGpu` by the layer object: adding one compiles only
 * the new layer's pipeline, and removing one disposes only that layer's
 * entry. This mirrors that, keyed by handle -- an entry that is still a
 * member MOVES rather than being rebuilt, which matters beyond the wasted
 * pipeline compile because `elapsed_ms` is a per-layer clock a rebuild
 * would reset for layers nobody touched.
 *
 * Releasing needs no wait: SDL_GPU documents every `SDL_ReleaseGPU*` as
 * freeing "as soon as it is safe to do so", so a resource an in-flight
 * frame still reads outlives this call. (That is the same contract the
 * driver's own resize path relies on when it releases the colour target.)
 */
inline void rebuild_sprite_pass_layers(
    SDL_GPUDevice* device,
    Engine& engine,
    SpritePass& pass,
    const std::vector<SDL_GPUTexture*>& render_textures) {
    const SpriteRendererRecord& renderer =
        engine.sprite_renderers[pass.renderer.value];
    std::vector<SpriteLayerGpu> next;
    next.reserve(renderer.layers.size());
    for (const Sprite2DLayerHandle& handle : renderer.layers) {
        const auto found = std::find_if(
            pass.layers.begin(),
            pass.layers.end(),
            [&](const SpriteLayerGpu& candidate) {
                return candidate.layer.value == handle.value;
            });
        if (found != pass.layers.end()) {
            next.push_back(std::move(*found));
            pass.layers.erase(found);
            continue;
        }
        next.push_back(build_sprite_layer_gpu(
            device,
            engine,
            handle,
            render_textures,
            pass.atlases,
            pass.target_format));
    }
    // Whatever is left was dropped from the list.
    release_sprite_pass_layers(device, pass);
    pass.layers = std::move(next);
    for (auto atlas = pass.atlases.begin(); atlas != pass.atlases.end();) {
        const bool used = std::any_of(
            renderer.layers.begin(),
            renderer.layers.end(),
            [&](const Sprite2DLayerHandle handle) {
                return engine.sprite_layers[handle.value].atlas.value ==
                    atlas->atlas.value;
            });
        if (used) {
            ++atlas;
        } else {
            release_sprite_atlas_gpu(device, *atlas);
            atlas = pass.atlases.erase(atlas);
        }
    }
    pass.layers_version = renderer.layers_version;
}

/**
 * The version-guarded form, for the frame loop. Creation calls the rebuild
 * directly: a fresh pass and an untouched renderer are both at version zero,
 * so a guarded call there would build nothing at all.
 */
inline void sync_sprite_pass_layers(
    SDL_GPUDevice* device,
    Engine& engine,
    SpritePass& pass,
    const std::vector<SDL_GPUTexture*>& render_textures) {
    const SpriteRendererRecord& renderer =
        engine.sprite_renderers[pass.renderer.value];
    if (renderer.layers_version == pass.layers_version) return;
    rebuild_sprite_pass_layers(device, engine, pass, render_textures);
}

inline void rebuild_sprite_layer_pipeline(
    SDL_GPUDevice* device,
    const Sprite2DLayerRecord& layer,
    SpriteLayerGpu& gpu,
    SDL_GPUTextureFormat target_format,
    SDL_GPUTextureFormat depth_format,
    SDL_GPUSampleCount sample_count) {
    const std::string fragment_name =
        sprite_fragment_shader_name(layer.custom_shader);
    const PinnedStageSlots slots = read_pinned_stage_slots(fragment_name);
    gpu.pipeline = create_sprite_layer_pipeline(
        device,
        layer,
        slots,
        target_format,
        depth_format,
        sample_count);
    gpu.owns_pipeline = true;
    gpu.pipeline_version = layer.pipeline_version;
}

/** Refresh runtime-widened standalone layouts before their next upload. */
inline void sync_sprite_pass_pipelines(
    SDL_GPUDevice* device,
    Engine& engine,
    SpritePass& pass) {
    for (SpriteLayerGpu& gpu : pass.layers) {
        const Sprite2DLayerRecord& layer =
            engine.sprite_layers[gpu.layer.value];
        if (gpu.pipeline_version == layer.pipeline_version) continue;
        if (gpu.owns_pipeline && gpu.pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(device, gpu.pipeline);
        }
        gpu.pipeline = nullptr;
        rebuild_sprite_layer_pipeline(
            device,
            layer,
            gpu,
            pass.target_format,
            SDL_GPU_TEXTUREFORMAT_INVALID,
            SDL_GPU_SAMPLECOUNT_1);
    }
}

inline SpritePass create_sprite_pass(
    SDL_GPUDevice* device,
    Engine& engine,
    SpriteRendererHandle renderer_handle,
    const std::vector<SDL_GPUTexture*>& render_textures,
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

    pass.target_format = target_format;
    rebuild_sprite_pass_layers(device, engine, pass, render_textures);
    return pass;
}

/**
 * `_update`: re-upload the layers whose CPU data moved. The copies stage
 * into the caller's run-lifetime batch, whose submit runs on a command
 * buffer of its own -- so callers submit it before acquiring the frame's.
 */
inline void upload_sprite_layer_gpu(
    SDL_GPUDevice* device,
    Engine& engine,
    Sprite2DLayerHandle handle,
    SpriteLayerGpu& gpu,
    float delta_ms,
    GpuBufferUploadBatch& buffer_uploads) {
    Sprite2DLayerRecord& layer = engine.sprite_layers[handle.value];
    // sprite-renderable.ts uploadLayer returns here before FX, texture,
    // instance or UBO work. A hidden custom layer pauses its clock.
    if (!layer.visible || layer.count == 0) return;
    const std::size_t needed_bytes =
        layer.instance_data.size() * sizeof(float);
    if (gpu.instance_buffer_bytes < needed_bytes) {
        SDL_GPUBufferCreateInfo buffer_info{};
        buffer_info.usage = SDL_GPU_BUFFERUSAGE_VERTEX;
        buffer_info.size = static_cast<Uint32>(needed_bytes);
        SDL_GPUBuffer* replacement =
            SDL_CreateGPUBuffer(device, &buffer_info);
        if (!replacement) {
            gpu_error("SDL_CreateGPUBuffer grown sprite instances");
        }
        SDL_ReleaseGPUBuffer(device, gpu.instances);
        gpu.instances = replacement;
        gpu.instance_buffer_bytes = needed_bytes;
        gpu.uploaded = false;
    }
    for (
        std::size_t extra_index = 0;
        extra_index < layer.custom_textures.size();
        ++extra_index) {
        const PixelsTexture& extra = layer.custom_textures[extra_index];
        if (gpu.extra_uploaded_versions[extra_index] == extra.version) {
            continue;
        }
        upload_2d_texture_into(
            device,
            gpu.textures[extra_index + 1u].texture,
            extra.rgba.data(),
            extra.rgba.size(),
            extra.width,
            extra.height,
            "sprite custom texture update");
        gpu.extra_uploaded_versions[extra_index] = extra.version;
    }
    // The pin advances the clock in `_update`, before and regardless of
    // whether the instance data moved.
    if (layer.custom_shader) {
        gpu.elapsed_ms += delta_ms;
    }
    if (!gpu.uploaded || gpu.uploaded_version != layer.version) {
        // The shared derivation (`resolve_sprite_dirty_range`) answers
        // which rows this copy uploads; only the write call is SDL's.
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
            const std::size_t offset =
                static_cast<std::size_t>(transfer.begin) * stride_bytes;
            const std::size_t bytes =
                static_cast<std::size_t>(transfer.end - transfer.begin) *
                stride_bytes;
            const float* data = transfer.data +
                static_cast<std::ptrdiff_t>(transfer.begin) *
                    layer.instance_floats_per_sprite;
            buffer_uploads.update(
                gpu.instances,
                offset,
                data,
                bytes);
            mark_sprite_dirty_range_consumed(layer);
        }
        gpu.uploaded = true;
        gpu.uploaded_version = layer.version;
    }
}

inline void upload_sprite_pass(
    SDL_GPUDevice* device,
    Engine& engine,
    SpritePass& pass,
    float delta_ms,
    GpuBufferUploadBatch& buffer_uploads) {
    sync_sprite_pass_pipelines(device, engine, pass);
    const SpriteRendererRecord& renderer =
        engine.sprite_renderers[pass.renderer.value];
    for (std::size_t index = 0; index < renderer.layers.size(); ++index) {
        upload_sprite_layer_gpu(
            device,
            engine,
            renderer.layers[index],
            pass.layers[index],
            delta_ms,
            buffer_uploads);
    }
}

inline void record_sprite_layer_gpu(
    SDL_GPUCommandBuffer* command,
    SDL_GPURenderPass* render_pass,
    const Sprite2DLayerRecord& layer,
    const SpriteLayerGpu& gpu,
    std::uint32_t width,
    std::uint32_t height) {
    SDL_BindGPUGraphicsPipeline(render_pass, gpu.pipeline);
    std::array<float, 16> ubo{};
    upstream::build_sprite_layer_ubo(
        layer,
        static_cast<float>(width),
        static_cast<float>(height),
        ubo);
    SDL_PushGPUVertexUniformData(command, 0, ubo.data(), sizeof(ubo));
    push_stage_uniform(
        command, gpu.layer_block_slot, ubo.data(), sizeof(ubo));
    if (gpu.fx_block_slot >= 0) {
        std::array<float, upstream::sprite_fx_ubo_bytes / 4u> fx{};
        upstream::build_sprite_fx_ubo(
            static_cast<float>(gpu.elapsed_ms / 1000.0),
            layer.shader_params,
            fx);
        push_stage_uniform(
            command, gpu.fx_block_slot, fx.data(), sizeof(fx));
    }
    if (!gpu.bound_textures.empty()) {
        SDL_BindGPUFragmentSamplers(
            render_pass,
            0,
            gpu.bound_textures.data(),
            static_cast<Uint32>(gpu.bound_textures.size()));
    }
    const SDL_GPUBufferBinding instance_binding{gpu.instances, 0};
    SDL_BindGPUVertexBuffers(render_pass, 0, &instance_binding, 1);
    SDL_DrawGPUIndexedPrimitives(render_pass, 6, layer.count, 0, 0, 0);
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
    if (renderer.layers.empty()) return;
    const std::vector<std::size_t> draw_order =
        sprite_layer_draw_order(engine, renderer);
    for (const std::size_t index : draw_order) {
        const Sprite2DLayerRecord& layer =
            engine.sprite_layers[renderer.layers[index].value];
        if (!layer.visible || layer.count == 0) {
            continue;
        }
        const SpriteLayerGpu& gpu = pass.layers[index];
        record_sprite_layer_gpu(
            command, render_pass, layer, gpu, width, height);
    }
}

inline SceneSpritePass create_scene_sprite_pass(
    SDL_GPUDevice* device,
    Engine& engine,
    const std::vector<Sprite2DLayerHandle>& handles,
    const std::vector<SDL_GPUTexture*>& render_textures,
    SDL_GPUTextureFormat target_format,
    SDL_GPUTextureFormat depth_format,
    SDL_GPUSampleCount sample_count) {
    SceneSpritePass pass;
    pass.handles = handles;
    pass.target_format = target_format;
    pass.depth_format = depth_format;
    pass.sample_count = sample_count;
    const std::array<std::uint16_t, 6> quad_indices{
        0u, 1u, 2u, 0u, 2u, 3u};
    pass.index_buffer = upload_buffer(
        device,
        SDL_GPU_BUFFERUSAGE_INDEX,
        quad_indices.data(),
        quad_indices.size() * sizeof(std::uint16_t));
    pass.layers.reserve(handles.size());
    for (const Sprite2DLayerHandle handle : handles) {
        if (engine.sprite_layers[handle.value].depth_mode ==
            Sprite2DDepthMode::none) {
            throw std::runtime_error(
                "A scene-attached Sprite2D layer must have depth enabled.");
        }
        SDL_GPUGraphicsPipeline* shared_pipeline = nullptr;
        for (std::size_t previous = 0; previous < pass.layers.size(); ++previous) {
            if (sprite_scene_pipeline_compatible(
                    engine.sprite_layers[pass.handles[previous].value],
                    engine.sprite_layers[handle.value])) {
                shared_pipeline = pass.layers[previous].pipeline;
                break;
            }
        }
        pass.layers.push_back(build_sprite_layer_gpu(
            device,
            engine,
            handle,
            render_textures,
            pass.atlases,
            target_format,
            depth_format,
            sample_count,
            shared_pipeline));
    }
    return pass;
}

inline void upload_scene_sprite_pass(
    SDL_GPUDevice* device,
    Engine& engine,
    SceneSpritePass& pass,
    float delta_ms,
    GpuBufferUploadBatch& buffer_uploads) {
    bool rebuild_pipelines = false;
    for (std::size_t index = 0; index < pass.handles.size(); ++index) {
        if (pass.layers[index].pipeline_version !=
            engine.sprite_layers[pass.handles[index].value].pipeline_version) {
            rebuild_pipelines = true;
            break;
        }
    }
    if (rebuild_pipelines) {
        // Borrowers point at their first compatible owner's pipeline. Tear
        // down only owners, then resolve the whole small cache again so a
        // changed layer can leave or join a compatibility class safely.
        for (SpriteLayerGpu& gpu : pass.layers) {
            if (gpu.owns_pipeline && gpu.pipeline) {
                SDL_ReleaseGPUGraphicsPipeline(device, gpu.pipeline);
            }
            gpu.pipeline = nullptr;
            gpu.owns_pipeline = false;
        }
        for (std::size_t index = 0; index < pass.handles.size(); ++index) {
            const Sprite2DLayerRecord& layer =
                engine.sprite_layers[pass.handles[index].value];
            SDL_GPUGraphicsPipeline* shared_pipeline = nullptr;
            for (std::size_t previous = 0; previous < index; ++previous) {
                if (sprite_scene_pipeline_compatible(
                        engine.sprite_layers[pass.handles[previous].value],
                        layer)) {
                    shared_pipeline = pass.layers[previous].pipeline;
                    break;
                }
            }
            SpriteLayerGpu& gpu = pass.layers[index];
            if (shared_pipeline) {
                gpu.pipeline = shared_pipeline;
                gpu.pipeline_version = layer.pipeline_version;
                continue;
            }
            rebuild_sprite_layer_pipeline(
                device,
                layer,
                gpu,
                pass.target_format,
                pass.depth_format,
                pass.sample_count);
        }
    }
    for (std::size_t index = 0; index < pass.handles.size(); ++index) {
        upload_sprite_layer_gpu(
            device,
            engine,
            pass.handles[index],
            pass.layers[index],
            delta_ms,
            buffer_uploads);
    }
}

inline void record_scene_sprite_pass(
    SDL_GPUCommandBuffer* command,
    SDL_GPURenderPass* render_pass,
    Engine& engine,
    const SceneSpritePass& pass,
    Sprite2DDepthMode depth_mode,
    std::uint32_t width,
    std::uint32_t height) {
    const SDL_GPUBufferBinding index_binding{pass.index_buffer, 0};
    SDL_BindGPUIndexBuffer(
        render_pass, &index_binding, SDL_GPU_INDEXELEMENTSIZE_16BIT);
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
        record_sprite_layer_gpu(
            command,
            render_pass,
            layer,
            pass.layers[index],
            width,
            height);
    }
}

inline void release_scene_sprite_pass(
    SDL_GPUDevice* device,
    SceneSpritePass& pass) {
    for (SpriteLayerGpu& layer : pass.layers) {
        release_sprite_layer_gpu(device, layer);
    }
    pass.layers.clear();
    release_sprite_atlas_cache(device, pass.atlases);
    if (pass.index_buffer) {
        SDL_ReleaseGPUBuffer(device, pass.index_buffer);
        pass.index_buffer = nullptr;
    }
}

inline void release_sprite_pass(
    SDL_GPUDevice* device,
    SpritePass& pass) {
    release_sprite_pass_layers(device, pass);
    release_sprite_atlas_cache(device, pass.atlases);
    if (pass.index_buffer) {
        SDL_ReleaseGPUBuffer(device, pass.index_buffer);
        pass.index_buffer = nullptr;
    }
}

} // namespace bbl::pal

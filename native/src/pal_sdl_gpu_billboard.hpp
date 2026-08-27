#pragma once

// World-space billboards, as an SDL_GPU pass that composes into the scene's
// own render pass.
//
// A 2D sprite layer owns its whole pass; a billboard system does not. It
// draws after the scene's transparent meshes, against the scene's depth
// buffer and camera, which is what makes a billboard occlude and be occluded
// by geometry. That is why this takes an existing `SDL_GPURenderPass*` rather
// than beginning one, and why the pipeline it builds carries the transparent
// depth contract: test on, write off.
//
// The instance layout, the quad, the UBO and the sort all come from
// `billboard_system.hpp`, which the billboard lowerer generates out of the
// pinned pipeline module. Nothing here decides a number.

#include <bblite/pal_gpu.hpp>
#include <bblite/runtime.hpp>
#include <bblite/upstream/billboard_system.hpp>
// The fx block a custom-shader system binds is the shared custom-shader
// module's, which the sprite family's header carries for both.
#include <bblite/upstream/sprite_layer.hpp>

#include <algorithm>
#include <array>
#include <cstdint>
#include <numeric>
#include <stdexcept>
#include <vector>

// billboard_draw_plan / billboard_needs_upload: the program ladder and
// the upload gate, decided once for both backends.
#include "pal_gpu_shared.hpp"
#include "pal_sdl_gpu_shared.hpp"
// sprite_blend_factor: one translation of the pinned blend enum, shared
// with the 2D layer's pass.
#include "pal_sdl_gpu_sprite.hpp"

namespace bbl::pal {

/** One billboard system, as GPU resources. */
struct BillboardPass {
    SDL_GPUGraphicsPipeline* pipeline = nullptr;
    // The mode-4 wrapper's second pipeline: a stock Add pass over the same
    // instances, built only when the descriptor carries two passes. Its
    // fragment is the stock one, so it binds the same textures and the same
    // system block at that stage's own slots.
    SDL_GPUGraphicsPipeline* add_pipeline = nullptr;
    int add_system_block_slot = -1;
    SDL_GPUBuffer* index_buffer = nullptr;
    SDL_GPUBuffer* instances = nullptr;
    // The atlas and any extra textures, in the order the composed program
    // declares them, built when the pass is.
    std::vector<SDL_GPUTextureSamplerBinding> textures;
    BillboardSystemHandle system{};
    // The reordered upload, kept so an unchanged view re-uploads nothing.
    std::vector<float> sorted;
    // What the buffer holds — the view it was sorted for and the count it
    // carried — so `billboard_needs_upload` can gate the re-upload and a
    // post-frame append invalidates it (pal_gpu_shared.hpp).
    BillboardUploadStamp upload_stamp;
    // Where this system's fragment stage kept its two uniform blocks, from
    // the sidecar the shader step wrote beside it. A custom body that reads
    // neither leaves both at -1.
    int system_block_slot = 0;
    int fx_block_slot = -1;
    // The custom shader's own clock: seconds since this system's first
    // frame, which the pin accumulates inside its fx attachment.
    float elapsed_ms = 0.0f;
};

/** The vertex block the reconstructed billboard stage declares. */
struct BillboardSceneUniforms {
    std::array<float, 16> view_projection{};
    std::array<float, 16> view{};
};

inline SDL_GPUVertexElementFormat billboard_attribute_format(
    std::uint32_t float_count) {
    switch (float_count) {
        case 1u:
            return SDL_GPU_VERTEXELEMENTFORMAT_FLOAT;
        case 2u:
            return SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2;
        case 3u:
            return SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3;
        case 4u:
            return SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4;
        default:
            throw std::runtime_error(
                "Billboard instance attribute has an unsupported float "
                "count.");
    }
}

inline BillboardPass create_billboard_pass(
    SDL_GPUDevice* device,
    Engine& engine,
    BillboardSystemHandle system_handle,
    SDL_GPUTextureFormat target_format,
    SDL_GPUTextureFormat depth_format,
    SDL_GPUSampleCount sample_count) {
    const BillboardSystemRecord& system =
        engine.billboard_systems[system_handle.value];
    const SpriteAtlasRecord& atlas =
        engine.sprite_atlases[system.atlas.value];
    BillboardPass pass;
    pass.system = system_handle;

    pass.index_buffer = upload_buffer(
        device,
        SDL_GPU_BUFFERUSAGE_INDEX,
        upstream::billboard_index_data.data(),
        upstream::billboard_index_data.size() *
            sizeof(std::uint16_t));

    // The program ladder and the pass rules, decided once for both
    // backends (`billboard_draw_plan`, pal_gpu_shared.hpp); this side
    // keeps only its API mechanics.
    const BillboardDrawPlan plan = billboard_draw_plan(system);
    SDL_GPUShader* vertex_shader = load_shader(
        device,
        plan.vertex_stem,
        SDL_GPU_SHADERSTAGE_VERTEX,
        0,
        // The axis-locked basis reads the system block for its lock axis.
        plan.vertex_reads_system_block ? 2u : 1u,
        "mainVertex");
    const PinnedStageSlots slots =
        read_pinned_stage_slots(plan.fragment_stem);
    pass.system_block_slot = stage_uniform_slot(slots, "billboards");
    pass.fx_block_slot = stage_uniform_slot(slots, "fx");
    SDL_GPUShader* fragment_shader = load_shader(
        device,
        plan.fragment_stem,
        SDL_GPU_SHADERSTAGE_FRAGMENT,
        static_cast<std::uint32_t>(slots.textures.size()),
        static_cast<std::uint32_t>(slots.uniforms.size()),
        "mainFragment");

    std::array<
        SDL_GPUVertexAttribute,
        upstream::billboard_instance_attributes.size()>
        attributes{};
    for (std::size_t index = 0;
         index < upstream::billboard_instance_attributes.size();
         ++index) {
        const upstream::BillboardInstanceAttribute& row =
            upstream::billboard_instance_attributes[index];
        attributes[index] = SDL_GPUVertexAttribute{
            row.shader_location,
            0,
            billboard_attribute_format(row.float_count),
            row.byte_offset};
    }
    SDL_GPUVertexBufferDescription instance_buffer{};
    instance_buffer.slot = 0;
    instance_buffer.pitch = upstream::billboard_instance_stride_bytes;
    instance_buffer.input_rate = SDL_GPU_VERTEXINPUTRATE_INSTANCE;
    instance_buffer.instance_step_rate = 0;

    // The descriptor the system was created with: the pinned
    // billboardBlend* the scene named, lowered as data. Every pinned mode is
    // an `add`, so only the factors vary.
    // A cutout mode carries no colour blend at all: it replaces.
    const SpriteBlendDescriptor& blend = system.blend;
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

    SDL_GPUGraphicsPipelineCreateInfo info{};
    info.vertex_shader = vertex_shader;
    info.fragment_shader = fragment_shader;
    info.vertex_input_state.vertex_buffer_descriptions =
        &instance_buffer;
    info.vertex_input_state.num_vertex_buffers = 1;
    info.vertex_input_state.vertex_attributes = attributes.data();
    info.vertex_input_state.num_vertex_attributes =
        static_cast<Uint32>(attributes.size());
    info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    // The quad is expanded around a camera basis, so a billboard has no
    // consistent winding to cull against.
    info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
    // The depth pairing comes with the plan: writes iff cutout.
    info.depth_stencil_state.compare_op =
        gpu_depth_compare(upstream::pinned_depth_compare);
    info.depth_stencil_state.enable_depth_test = true;
    info.depth_stencil_state.enable_depth_write =
        plan.cutout_writes_depth;
    // The one a2c rule (pal_gpu_shared.hpp): at one sample the Dawn twin's
    // pipeline validation would reject it, and this API would quantize
    // coverage to a ~0.5 cutoff — different pixels per backend.
    info.multisample_state.enable_alpha_to_coverage =
        alpha_to_coverage_enabled(
            system.alpha_to_coverage,
            gpu_sample_count_value(sample_count));
    info.multisample_state.sample_count = sample_count;
    info.target_info.color_target_descriptions = &target;
    info.target_info.num_color_targets = 1;
    info.target_info.depth_stencil_format = depth_format;
    info.target_info.has_depth_stencil_target = true;
    pass.pipeline = SDL_CreateGPUGraphicsPipeline(device, &info);
    if (!pass.pipeline) gpu_error("SDL_CreateGPUGraphicsPipeline");
    SDL_ReleaseGPUShader(device, vertex_shader);
    SDL_ReleaseGPUShader(device, fragment_shader);

    if (plan.particle_passes == 2) {
        // The mode-4 second pass: the STOCK program, the Add blend the
        // generated builder resolved, and everything else identical -- the
        // pin builds it as a copy of the system with its custom shader
        // cleared, over the same instance and index buffers.
        const SpriteBlendDescriptor& add = system.add_pass_blend;
        SDL_GPUColorTargetDescription add_target = target;
        add_target.blend_state.enable_blend = add.enabled;
        add_target.blend_state.src_color_blendfactor =
            sprite_blend_factor(add.color.src);
        add_target.blend_state.dst_color_blendfactor =
            sprite_blend_factor(add.color.dst);
        add_target.blend_state.src_alpha_blendfactor =
            sprite_blend_factor(add.alpha.src);
        add_target.blend_state.dst_alpha_blendfactor =
            sprite_blend_factor(add.alpha.dst);
        const PinnedStageSlots add_slots =
            read_pinned_stage_slots("billboard.frag");
        pass.add_system_block_slot =
            stage_uniform_slot(add_slots, "billboards");
        SDL_GPUShader* add_vertex = load_shader(
            device,
            "billboard.vert",
            SDL_GPU_SHADERSTAGE_VERTEX,
            0,
            1u,
            "mainVertex");
        SDL_GPUShader* add_fragment = load_shader(
            device,
            "billboard.frag",
            SDL_GPU_SHADERSTAGE_FRAGMENT,
            static_cast<std::uint32_t>(add_slots.textures.size()),
            static_cast<std::uint32_t>(add_slots.uniforms.size()),
            "mainFragment");
        SDL_GPUGraphicsPipelineCreateInfo add_info = info;
        add_info.vertex_shader = add_vertex;
        add_info.fragment_shader = add_fragment;
        add_info.target_info.color_target_descriptions = &add_target;
        pass.add_pipeline =
            SDL_CreateGPUGraphicsPipeline(device, &add_info);
        if (!pass.add_pipeline) {
            gpu_error("SDL_CreateGPUGraphicsPipeline");
        }
        SDL_ReleaseGPUShader(device, add_vertex);
        SDL_ReleaseGPUShader(device, add_fragment);
    }

    SDL_GPUBufferCreateInfo instances{};
    instances.usage = SDL_GPU_BUFFERUSAGE_VERTEX;
    instances.size = static_cast<Uint32>(
        static_cast<std::size_t>(system.capacity) *
        upstream::billboard_instance_stride_bytes);
    pass.instances = SDL_CreateGPUBuffer(device, &instances);
    if (!pass.instances) gpu_error("SDL_CreateGPUBuffer");

    // rgba8unorm: `loadTexture2D` leaves srgb off, so the atlas texels
    // reach the blend stage as the bytes on disk.
    pass.textures = sprite_fragment_textures(
        device,
        upload_2d_texture(
            device,
            atlas.rgba.data(),
            atlas.rgba.size(),
            atlas.width,
            atlas.height,
            SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
            "billboard atlas",
            atlas_mip_levels(atlas)),
        create_texture_sampler(device, atlas.sampler),
        system.custom_textures,
        "billboard custom texture");
    return pass;
}

/**
 * Sorts the instances back to front in view space and uploads them.
 *
 * With depth writes off the draw ORDER is the composite, so this runs every
 * frame the camera moves rather than only when the system changes.
 */
inline void upload_billboard_pass(
    SDL_GPUDevice* device,
    const Scene& scene,
    Engine& engine,
    BillboardPass& pass,
    const std::array<float, 16>& view,
    float delta_ms) {
    const BillboardSystemRecord& system =
        engine.billboard_systems[pass.system.value];
    // The pin advances the clock in `_update`, before and regardless of
    // whether the sorted instance data moved.
    if (system.custom_shader) {
        pass.elapsed_ms += delta_ms;
    }
    // One gating rule for both backends (`billboard_needs_upload`):
    // `update_buffer` creates a transfer buffer and submits a command
    // buffer of its own, so re-uploading an identical buffer every frame
    // is the one real per-frame cost here -- every other upload in this
    // renderer is version-gated the same way.
    const Vec3d fo_offset =
        frame_floating_origin_offset(scene, engine);
    if (
        !billboard_needs_upload(system, pass.upload_stamp, view, fo_offset)) {
        return;
    }
    upstream::billboard_upload_instances(
        system,
        view,
        pass.sorted
#if BBLITE_FLOATING_ORIGIN
        ,
        fo_offset
#endif
    );
    update_buffer(
        device,
        pass.instances,
        pass.sorted.data(),
        pass.sorted.size() * sizeof(float));
    stamp_billboard_upload(pass.upload_stamp, system, view, fo_offset);
}

/** Records the billboard draw into a pass the scene renderer already began. */
inline void record_billboard_pass(
    SDL_GPUCommandBuffer* command,
    SDL_GPURenderPass* render_pass,
    Engine& engine,
    const BillboardPass& pass,
    const std::array<float, 16>& view_projection,
    const std::array<float, 16>& view) {
    const BillboardSystemRecord& system =
        engine.billboard_systems[pass.system.value];
    if (!system.visible || system.count == 0) {
        return;
    }
    SDL_BindGPUGraphicsPipeline(render_pass, pass.pipeline);

    BillboardSceneUniforms scene_uniforms{};
    scene_uniforms.view_projection = view_projection;
    scene_uniforms.view = view;
    SDL_PushGPUVertexUniformData(
        command,
        0,
        &scene_uniforms,
        sizeof(scene_uniforms));

    // Each block at the slot its own stage kept it in, which a custom body
    // decides by reading it or not. The axis-locked vertex stage reads the
    // system block too, so it is built whenever either stage wants it.
    const bool axis_locked =
        billboard_draw_plan(system).vertex_reads_system_block;
    std::array<float, upstream::billboard_system_ubo_bytes / 4>
        system_ubo{};
    if (pass.system_block_slot >= 0 || axis_locked) {
        upstream::build_billboard_system_ubo(system, system_ubo);
    }
    push_stage_uniform(
        command,
        pass.system_block_slot,
        system_ubo.data(),
        system_ubo.size() * sizeof(float));
    if (pass.fx_block_slot >= 0) {
        std::array<float, upstream::sprite_fx_ubo_bytes / 4u> fx{};
        upstream::build_sprite_fx_ubo(
            pass.elapsed_ms / 1000.0f, system.shader_params, fx);
        push_stage_uniform(
            command, pass.fx_block_slot, fx.data(), fx.size() * sizeof(float));
    }
    if (axis_locked) {
        // The same block, in the vertex stage that reads the lock axis.
        SDL_PushGPUVertexUniformData(
            command,
            1,
            system_ubo.data(),
            static_cast<Uint32>(system_ubo.size() * sizeof(float)));
    }

    SDL_GPUBufferBinding instance_binding{};
    instance_binding.buffer = pass.instances;
    instance_binding.offset = 0;
    SDL_BindGPUVertexBuffers(render_pass, 0, &instance_binding, 1);

    SDL_GPUBufferBinding index_binding{};
    index_binding.buffer = pass.index_buffer;
    index_binding.offset = 0;
    SDL_BindGPUIndexBuffer(
        render_pass,
        &index_binding,
        SDL_GPU_INDEXELEMENTSIZE_16BIT);

    SDL_BindGPUFragmentSamplers(
        render_pass,
        0,
        pass.textures.data(),
        static_cast<Uint32>(pass.textures.size()));

    SDL_DrawGPUIndexedPrimitives(
        render_pass,
        static_cast<Uint32>(upstream::billboard_index_data.size()),
        system.count,
        0,
        0,
        0);

    if (pass.add_pipeline) {
        // The pin's own mode-4 wrapper: the primary draw leaves the instance
        // and index buffers bound, so the second pass binds only its
        // pipeline and its own system block before drawing the same
        // instances again. It restores the primary pipeline afterwards, so a
        // caller caching the bound pipeline stays correct.
        SDL_BindGPUGraphicsPipeline(render_pass, pass.add_pipeline);
        // The stock fragment keeps the block at the same slot the Multiply
        // one did for every pairing that can occur, so the push is normally
        // redundant -- but the slot is read from each stage's own sidecar
        // rather than assumed, so a stage that moved it still gets one.
        if (pass.add_system_block_slot != pass.system_block_slot) {
            push_stage_uniform(
                command,
                pass.add_system_block_slot,
                system_ubo.data(),
                system_ubo.size() * sizeof(float));
        }
        SDL_DrawGPUIndexedPrimitives(
            render_pass,
            static_cast<Uint32>(upstream::billboard_index_data.size()),
            system.count,
            0,
            0,
            0);
        SDL_BindGPUGraphicsPipeline(render_pass, pass.pipeline);
    }
}

inline void release_billboard_pass(
    SDL_GPUDevice* device,
    BillboardPass& pass) {
    release_sprite_fragment_textures(device, pass.textures);
    if (pass.instances) SDL_ReleaseGPUBuffer(device, pass.instances);
    if (pass.index_buffer) {
        SDL_ReleaseGPUBuffer(device, pass.index_buffer);
    }
    if (pass.pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(device, pass.pipeline);
    }
    if (pass.add_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(device, pass.add_pipeline);
    }
    pass = BillboardPass{};
}

}  // namespace bbl::pal

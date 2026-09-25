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
#include "pal_gpu_textures.hpp"
#include "pal_gpu_surface.hpp"
#include "pal_gpu_sprites.hpp"
#include "pal_gpu_pipeline.hpp"
#include "pal_sdl_gpu_shared.hpp"
// sprite_blend_factor: one translation of the pinned blend enum, shared
// with the 2D layer's pass.
#include "pal_sdl_gpu_sprite.hpp"

namespace bbl::pal {

/** One billboard system, as GPU resources. */
struct BillboardResources {
    OwnedSdlPipeline pipeline;
    // The mode-4 wrapper's second pipeline: a stock Add pass over the same
    // instances, built only when the descriptor carries two passes. It is
    // the stock program, so it binds the same textures and blocks at its
    // own stages' slots.
    OwnedSdlPipeline add_pipeline;
    PinnedStageSlots add_vertex_slots;
    PinnedStageSlots add_fragment_slots;
    SDL_GPUBuffer* index_buffer = nullptr;
    SDL_GPUBuffer* instances = nullptr;
    // Owners stay atlas-then-extras; the bound list follows the compacted
    // fragment sidecar and can omit resources the shader did not keep.
    std::vector<SDL_GPUTextureSamplerBinding> textures;
    std::vector<SDL_GPUTextureSamplerBinding> bound_textures;
    BillboardSystemHandle system{};
    // The reordered upload, kept so an unchanged view re-uploads nothing.
    std::vector<float> sorted;
    // What the buffer holds — its source instance version and the view it was
    // sorted for — so `billboard_needs_upload` can gate the re-upload.
    BillboardUploadStamp upload_stamp;
    // The program's two stages' sidecars: which of the pin's blocks --
    // the scene block, the system block, the fx block -- each stage kept,
    // and at which slot.
    PinnedStageSlots vertex_slots;
    PinnedStageSlots fragment_slots;
    // The custom shader's own clock: seconds since this system's first
    // frame, which the pin accumulates inside its fx attachment.
    // Mirrors the JavaScript `number` accumulator until the f32 UBO write.
    double elapsed_ms = 0.0;
};

inline void release_billboard_resources(SDL_GPUDevice*, BillboardResources&) noexcept;
using BillboardPass = OwnedGpuRecord<BillboardResources, std::remove_pointer_t<SDL_GPUDevice*>,
                                     release_billboard_resources>;

inline SDL_GPUVertexElementFormat billboard_attribute_format(std::uint32_t float_count) {
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
        throw std::runtime_error("Billboard instance attribute has an unsupported float "
                                 "count.");
    }
}

inline BillboardPass create_billboard_pass(SDL_GPUDevice* device, Engine& engine,
                                           BillboardSystemHandle system_handle,
                                           SDL_GPUTextureFormat target_format,
                                           SDL_GPUTextureFormat depth_format,
                                           SDL_GPUSampleCount sample_count) {
    const BillboardSystemRecord& system = handle_at(engine.billboard_systems, system_handle);
    const SpriteAtlasRecord& atlas = handle_at(engine.sprite_atlases, system.atlas);
    BillboardPass pass{device};
    pass.system = system_handle;

    pass.index_buffer =
        upload_buffer(device, SDL_GPU_BUFFERUSAGE_INDEX, upstream::billboard_index_data.data(),
                      upstream::billboard_index_data.size() * sizeof(std::uint16_t));

    // The program ladder and the pass rules, decided once for both
    // backends (`billboard_draw_plan`, pal_gpu_shared.hpp); this side
    // keeps only its API mechanics.
    const BillboardDrawPlan plan = billboard_draw_plan(system);
    // The program's one module, both stages compiled from it and each
    // created from its own sidecar. Which blocks a stage kept is the
    // module's to say: the axis-locked basis reads the system block in the
    // vertex stage, and a custom body may read the scene block.
    const std::string stem = plan.program_stem;
    PinnedStage vertex_stage =
        load_pinned_stage(device, stem + ".vert", SDL_GPU_SHADERSTAGE_VERTEX);
    PinnedStage fragment_stage =
        load_pinned_stage(device, stem + ".frag", SDL_GPU_SHADERSTAGE_FRAGMENT);
    auto& vertex_shader = vertex_stage.shader;
    auto& fragment_shader = fragment_stage.shader;
    pass.vertex_slots = vertex_stage.slots;
    pass.fragment_slots = fragment_stage.slots;
    const PinnedStageSlots& slots = pass.fragment_slots;

    std::array<SDL_GPUVertexAttribute, upstream::billboard_instance_attributes.size()> attributes{};
    for (std::size_t index = 0; index < upstream::billboard_instance_attributes.size(); ++index) {
        const upstream::BillboardInstanceAttribute& row =
            upstream::billboard_instance_attributes[index];
        attributes[index] = SDL_GPUVertexAttribute{
            row.shader_location, 0, billboard_attribute_format(row.float_count), row.byte_offset};
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
    target.blend_state.src_color_blendfactor = sprite_blend_factor(blend.color.src);
    target.blend_state.dst_color_blendfactor = sprite_blend_factor(blend.color.dst);
    target.blend_state.color_blend_op = SDL_GPU_BLENDOP_ADD;
    target.blend_state.src_alpha_blendfactor = sprite_blend_factor(blend.alpha.src);
    target.blend_state.dst_alpha_blendfactor = sprite_blend_factor(blend.alpha.dst);
    target.blend_state.alpha_blend_op = SDL_GPU_BLENDOP_ADD;
    target.blend_state.color_write_mask = SDL_GPU_COLORCOMPONENT_R | SDL_GPU_COLORCOMPONENT_G |
                                          SDL_GPU_COLORCOMPONENT_B | SDL_GPU_COLORCOMPONENT_A;

    SDL_GPUGraphicsPipelineCreateInfo info{};
    info.vertex_shader = vertex_shader.get();
    info.fragment_shader = fragment_shader.get();
    info.vertex_input_state.vertex_buffer_descriptions = &instance_buffer;
    info.vertex_input_state.num_vertex_buffers = 1;
    info.vertex_input_state.vertex_attributes = attributes.data();
    info.vertex_input_state.num_vertex_attributes = static_cast<Uint32>(attributes.size());
    info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    // The quad is expanded around a camera basis, so a billboard has no
    // consistent winding to cull against.
    info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
    // The depth pairing comes with the plan: writes iff cutout.
    info.depth_stencil_state.compare_op = gpu_depth_compare(upstream::pinned_depth_compare);
    info.depth_stencil_state.enable_depth_test = true;
    info.depth_stencil_state.enable_depth_write = plan.cutout_writes_depth;
    // The one a2c rule (shared GPU helpers): at one sample the Dawn twin's
    // pipeline validation would reject it, and this API would quantize
    // coverage to a ~0.5 cutoff — different pixels per backend.
    info.multisample_state.enable_alpha_to_coverage =
        alpha_to_coverage_enabled(system.alpha_to_coverage, gpu_sample_count_value(sample_count));
    info.multisample_state.sample_count = sample_count;
    info.target_info.color_target_descriptions = &target;
    info.target_info.num_color_targets = 1;
    info.target_info.depth_stencil_format = depth_format;
    info.target_info.has_depth_stencil_target = true;
    pass.pipeline = OwnedSdlPipeline{create_sdl_gpu_graphics_pipeline(device, &info), {device}};
    if (!pass.pipeline)
        gpu_error("SDL_CreateGPUGraphicsPipeline");
    vertex_shader.reset();
    fragment_shader.reset();

    if (plan.particle_passes == 2) {
        // The mode-4 second pass: the STOCK program, the Add blend the
        // generated builder resolved, and everything else identical -- the
        // pin builds it as a copy of the system with its custom shader
        // cleared, over the same instance and index buffers.
        const SpriteBlendDescriptor& add = system.add_pass_blend;
        SDL_GPUColorTargetDescription add_target = target;
        add_target.blend_state.enable_blend = add.enabled;
        add_target.blend_state.src_color_blendfactor = sprite_blend_factor(add.color.src);
        add_target.blend_state.dst_color_blendfactor = sprite_blend_factor(add.color.dst);
        add_target.blend_state.src_alpha_blendfactor = sprite_blend_factor(add.alpha.src);
        add_target.blend_state.dst_alpha_blendfactor = sprite_blend_factor(add.alpha.dst);
        PinnedStage add_vertex =
            load_pinned_stage(device, "billboard.vert", SDL_GPU_SHADERSTAGE_VERTEX);
        PinnedStage add_fragment =
            load_pinned_stage(device, "billboard.frag", SDL_GPU_SHADERSTAGE_FRAGMENT);
        pass.add_vertex_slots = add_vertex.slots;
        pass.add_fragment_slots = add_fragment.slots;
        SDL_GPUGraphicsPipelineCreateInfo add_info = info;
        add_info.vertex_shader = add_vertex.shader.get();
        add_info.fragment_shader = add_fragment.shader.get();
        add_info.target_info.color_target_descriptions = &add_target;
        pass.add_pipeline =
            OwnedSdlPipeline{create_sdl_gpu_graphics_pipeline(device, &add_info), {device}};
        if (!pass.add_pipeline) {
            gpu_error("SDL_CreateGPUGraphicsPipeline");
        }
    }

    SDL_GPUBufferCreateInfo instances{};
    instances.usage = SDL_GPU_BUFFERUSAGE_VERTEX;
    instances.size = static_cast<Uint32>(static_cast<std::size_t>(system.capacity) *
                                         upstream::billboard_instance_stride_bytes);
    pass.instances = SDL_CreateGPUBuffer(device, &instances);
    if (!pass.instances)
        gpu_error("SDL_CreateGPUBuffer");

    // rgba8unorm: `loadTexture2D` leaves srgb off, so the atlas texels
    // reach the blend stage as the bytes on disk.
    pass.textures.resize(1);
    pass.textures[0].texture = upload_2d_texture(
        device, atlas.rgba.data(), atlas.rgba.size(), atlas.width, atlas.height,
        SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM, "billboard atlas", atlas_mip_levels(atlas));
    pass.textures[0].sampler = create_texture_sampler(device, atlas.sampler);
    append_sprite_fragment_textures(device, pass.textures, system.custom_textures,
                                    "billboard custom texture");
    pass.bound_textures = select_sprite_fragment_textures(
        slots, pass.textures, system.custom_texture_names, "billboard fragment shader");
    return pass;
}

/**
 * Sorts the instances back to front in view space and uploads them.
 *
 * With depth writes off the draw ORDER is the composite, so this runs every
 * frame the camera moves rather than only when the system changes.
 */
inline void upload_billboard_pass(SDL_GPUDevice* device, const Scene& scene, Engine& engine,
                                  BillboardPass& pass, const std::array<float, 16>& view,
                                  double delta_ms) {
    const BillboardSystemRecord& system = handle_at(engine.billboard_systems, pass.system);
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
    const Vec3d fo_offset = frame_floating_origin_offset(scene, engine);
    if (!billboard_needs_upload(system, pass.upload_stamp, view, fo_offset)) {
        return;
    }
    // `context._camera`: the pass that draws a system renders through its
    // scene's camera.
    upstream::billboard_upload_instances(system, scene_camera(engine, scene) != nullptr, view,
                                         pass.sorted, fo_offset);
    update_buffer(device, pass.instances, pass.sorted.data(), pass.sorted.size() * sizeof(float));
    stamp_billboard_upload(pass.upload_stamp, system, view, fo_offset);
}

/**
 * Records the billboard draw into a pass the scene renderer already began.
 *
 * `scene_block` is the pass's scene block, which the pin binds at the
 * program's group 0; each stage takes the blocks its own sidecar kept, at
 * their slots, and a block the program declares that none of the three
 * is refuses.
 */
inline void record_billboard_pass(SDL_GPUCommandBuffer* command, SDL_GPURenderPass* render_pass,
                                  Engine& engine, const BillboardPass& pass,
                                  const upstream::SceneUniforms& scene_block) {
    const BillboardSystemRecord& system = handle_at(engine.billboard_systems, pass.system);
    if (!system.visible || system.count == 0) {
        return;
    }
    SDL_BindGPUGraphicsPipeline(render_pass, pass.pipeline.get());

    std::array<float, upstream::billboard_system_ubo_bytes / 4> system_ubo{};
    upstream::build_billboard_system_ubo(system, system_ubo);
    std::array<float, upstream::sprite_fx_ubo_bytes / 4u> fx{};
    if (system.custom_shader) {
        upstream::build_sprite_fx_ubo(static_cast<float>(pass.elapsed_ms / 1000.0),
                                      system.shader_params, fx);
    }
    const auto blocks = [&](const std::string& name, std::size_t) -> PinnedStageBlock {
        if (name == "scene")
            return {&scene_block, sizeof(scene_block)};
        if (name == "billboards")
            return {system_ubo.data(), system_ubo.size() * sizeof(float)};
        if (name == "fx" && system.custom_shader)
            return {fx.data(), fx.size() * sizeof(float)};
        return {};
    };
    push_stage_uniforms(command, pass.vertex_slots, false, "billboard vertex stage", blocks);
    push_stage_uniforms(command, pass.fragment_slots, true, "billboard fragment stage", blocks);

    SDL_GPUBufferBinding instance_binding{};
    instance_binding.buffer = pass.instances;
    instance_binding.offset = 0;
    SDL_BindGPUVertexBuffers(render_pass, 0, &instance_binding, 1);

    SDL_GPUBufferBinding index_binding{};
    index_binding.buffer = pass.index_buffer;
    index_binding.offset = 0;
    SDL_BindGPUIndexBuffer(render_pass, &index_binding, SDL_GPU_INDEXELEMENTSIZE_16BIT);

    if (!pass.bound_textures.empty()) {
        SDL_BindGPUFragmentSamplers(render_pass, 0, pass.bound_textures.data(),
                                    static_cast<Uint32>(pass.bound_textures.size()));
    }

    SDL_DrawGPUIndexedPrimitives(render_pass,
                                 static_cast<Uint32>(upstream::billboard_index_data.size()),
                                 system.count, 0, 0, 0);

    if (pass.add_pipeline) {
        // The pin's own mode-4 wrapper: the primary draw leaves the instance
        // and index buffers bound, so the second pass binds only its
        // pipeline and its own system block before drawing the same
        // instances again. It restores the primary pipeline afterwards, so a
        // caller caching the bound pipeline stays correct.
        SDL_BindGPUGraphicsPipeline(render_pass, pass.add_pipeline.get());
        SDL_BindGPUFragmentSamplers(render_pass, 0, pass.textures.data(), 1);
        // The stock program's own stages, each at the slots its sidecar
        // kept rather than the Multiply program's.
        push_stage_uniforms(command, pass.add_vertex_slots, false,
                            "billboard add-pass vertex stage", blocks);
        push_stage_uniforms(command, pass.add_fragment_slots, true,
                            "billboard add-pass fragment stage", blocks);
        SDL_DrawGPUIndexedPrimitives(render_pass,
                                     static_cast<Uint32>(upstream::billboard_index_data.size()),
                                     system.count, 0, 0, 0);
        SDL_BindGPUGraphicsPipeline(render_pass, pass.pipeline.get());
    }
}

inline void release_billboard_resources([[maybe_unused]] SDL_GPUDevice* device,
                                        BillboardResources& pass) noexcept {
    release_sprite_fragment_textures(device, pass.textures);
    if (pass.instances)
        SDL_ReleaseGPUBuffer(device, pass.instances);
    if (pass.index_buffer) {
        SDL_ReleaseGPUBuffer(device, pass.index_buffer);
    }
    pass = BillboardResources{};
}

inline void release_billboard_pass(SDL_GPUDevice*, BillboardPass& pass) { pass.reset(); }

} // namespace bbl::pal

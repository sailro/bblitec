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
// The fx block a custom-shader system binds is the shared custom-shader
// module's, which the sprite family's header carries for both.
#include <bblite/upstream/sprite_layer.hpp>

#include <algorithm>
#include <array>
#include <cstdint>
#include <numeric>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

// billboard_draw_plan / billboard_needs_upload: the program ladder and
// the upload gate, decided once for both backends.
#include "pal_gpu_shared.hpp"
#include "pal_dawn_shared.hpp"
// dawn_sprite_blend_factor: one translation of the pinned blend enum,
// shared with the 2D layer's pass.
#include "pal_dawn_sprite.hpp"

namespace bbl::pal {

/**
 * The pin's per-pass scene block one pass target binds at a billboard
 * program's group 0, and the group over it.
 */
struct DawnBillboardScene {
    WGPUBuffer uniforms = nullptr;
    WGPUBindGroup group = nullptr;
};

/** One billboard system, as Dawn resources. */
struct DawnBillboardResources {
    /**
     * The mip levels the atlas texture was created with, for the caller to
     * fill. The blit that fills them belongs to the frame state, which this
     * header cannot see -- so the pass reports what it allocated and the
     * caller, which holds that state, generates them.
     */
    std::uint32_t atlas_mip_levels = 1u;
    WGPURenderPipeline pipeline = nullptr;
    // The program's one module: both stages enter where it declares them.
    WGPUShaderModule module = nullptr;
    // The mode-4 wrapper's second pass: a stock Add pipeline over the same
    // instances and the same bind groups, built only when the descriptor
    // carries two passes. Its layout is identical -- the Multiply system
    // declares no fx block either -- so nothing but the pipeline differs.
    WGPURenderPipeline add_pipeline = nullptr;
    WGPUShaderModule add_module = nullptr;
    // The pin's two groups: the pass's scene block at 0, the system's own
    // block, atlas and custom resources at 1.
    std::array<WGPUBindGroupLayout, 2> group_layouts{};
    WGPUBuffer index_buffer = nullptr;
    WGPUBuffer instances = nullptr;
    // The system block (group 1).
    WGPUBuffer system_uniforms = nullptr;
    // Group 0 as the program declares it -- the pin's scene block -- and
    // one block and group per pass target the system draws into: the
    // frame's own, and each scene-stage render task's, keyed by the task,
    // as the pin binds each task's own scene group.
    std::vector<DawnReflectedLayoutEntry> scene_layout;
    DawnBillboardScene frame_scene;
    std::unordered_map<std::uint32_t, DawnBillboardScene> task_scenes;
    // Bound beside the system uniforms for a custom-shader system, and
    // null for a plain one, which is the pin's own nullable fx attachment.
    WGPUBuffer fx_uniforms = nullptr;
    // The custom shader's own clock: seconds since this system's first
    // frame, which the pin accumulates inside its fx attachment.
    // Mirrors the JavaScript `number` accumulator until the f32 UBO write.
    double elapsed_ms = 0.0;
    WGPUTexture atlas = nullptr;
    WGPUTextureView atlas_view = nullptr;
    WGPUSampler sampler = nullptr;
    // The custom shader's extra textures, in the order they bind after
    // the atlas.
    std::vector<DawnSampledTexture> extras;
    WGPUBindGroup system_group = nullptr;
    BillboardSystemHandle system{};
    // The reordered upload, kept across frames.
    std::vector<float> sorted;
    // What the buffer holds — its source instance version and the view it was
    // sorted for — so `billboard_needs_upload` can gate the re-upload.
    BillboardUploadStamp upload_stamp;
};

inline void release_dawn_billboard_resources(WGPUDevice, DawnBillboardResources&) noexcept;
using DawnBillboardPass = OwnedGpuRecord<DawnBillboardResources, std::remove_pointer_t<WGPUDevice>,
                                         release_dawn_billboard_resources>;

inline WGPUVertexFormat dawn_billboard_format(std::uint32_t float_count) {
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
        throw std::runtime_error("Billboard instance attribute has an unsupported float "
                                 "count.");
    }
}

/** A pass target's scene block and the group over it, laid out as group 0. */
inline DawnBillboardScene create_dawn_billboard_scene(WGPUDevice device,
                                                      const DawnBillboardResources& pass) {
    DawnBillboardScene scene;
    WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
    descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
    descriptor.size = sizeof(upstream::SceneUniforms);
    scene.uniforms = wgpuDeviceCreateBuffer(device, &descriptor);
    if (!scene.uniforms)
        dawn_error("wgpuDeviceCreateBuffer billboard scene block");
    scene.group = create_dawn_named_group(device, pass.group_layouts[0], pass.scene_layout, 0,
                                          [&](std::string_view name, WGPUBindGroupEntry& entry) {
                                              if (name != "scene")
                                                  return false;
                                              entry.buffer = scene.uniforms;
                                              entry.size = sizeof(upstream::SceneUniforms);
                                              return true;
                                          });
    return scene;
}

inline void release_dawn_billboard_scene(DawnBillboardScene& scene) noexcept {
    if (scene.group)
        wgpuBindGroupRelease(scene.group);
    if (scene.uniforms)
        wgpuBufferRelease(scene.uniforms);
    scene = DawnBillboardScene{};
}

/**
 * A scene-stage render task's own pass block, as the pin binds each task's
 * scene group: written into the task's own buffer, so every task drawing
 * the system in one submission reads the block of the task it draws for.
 */
inline void write_dawn_billboard_task_scene(WGPUDevice device, WGPUQueue queue,
                                            DawnBillboardPass& pass, std::uint32_t task,
                                            const upstream::SceneUniforms& scene_block) {
    auto found = pass.task_scenes.find(task);
    if (found == pass.task_scenes.end())
        found = pass.task_scenes.emplace(task, create_dawn_billboard_scene(device, pass)).first;
    wgpuQueueWriteBuffer(queue, found->second.uniforms, 0, &scene_block, sizeof(scene_block));
}

/** The scene group a task binds, written by `write_dawn_billboard_task_scene`. */
inline const DawnBillboardScene& dawn_billboard_task_scene(const DawnBillboardPass& pass,
                                                           std::uint32_t task) {
    const auto found = pass.task_scenes.find(task);
    if (found == pass.task_scenes.end())
        dawn_error("billboard system drawn by render task " + std::to_string(task) +
                   " has no scene block written for that task.");
    return found->second;
}

inline DawnBillboardPass
create_dawn_billboard_pass(WGPUDevice device, WGPUQueue queue, Engine& engine,
                           BillboardSystemHandle system_handle, WGPUTextureFormat target_format,
                           WGPUTextureFormat depth_format, std::uint32_t sample_count) {
    const BillboardSystemRecord& system = handle_at(engine.billboard_systems, system_handle);
    const SpriteAtlasRecord& atlas = handle_at(engine.sprite_atlases, system.atlas);
    DawnBillboardPass pass{device};
    pass.system = system_handle;

    {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.usage = WGPUBufferUsage_Index | WGPUBufferUsage_CopyDst;
        descriptor.size = sizeof(std::uint16_t) * upstream::billboard_index_data.size();
        pass.index_buffer = wgpuDeviceCreateBuffer(device, &descriptor);
        if (!pass.index_buffer) {
            dawn_error("wgpuDeviceCreateBuffer billboard indices");
        }
        wgpuQueueWriteBuffer(queue, pass.index_buffer, 0, upstream::billboard_index_data.data(),
                             static_cast<std::size_t>(descriptor.size));
    }

    // The program ladder and the pass rules, decided once for both
    // backends (`billboard_draw_plan`, pal_gpu_shared.hpp); this side
    // keeps only its API mechanics.
    const BillboardDrawPlan plan = billboard_draw_plan(system);
    // The program's one module, deployed whole under the fragment stem;
    // both stages enter where it declares them.
    const std::string stem = plan.program_stem;
    const std::string vertex_stem = stem + ".vert", fragment_stem = stem + ".frag";
    pass.module = load_wgsl_module(device, fragment_stem);

    // Both groups are laid out from what the program's stages declare in
    // them (their `.slots` layout lines): the pin's scene block at 0, the
    // system block, atlas pair and a custom program's fx block and extra
    // pairs at 1. The mode-4 add pass draws the stock program under the
    // same layout, so its stages are laid out with the pass's own.
    std::vector<DawnLayoutStage> stages{{vertex_stem, WGPUShaderStage_Vertex},
                                        {fragment_stem, WGPUShaderStage_Fragment}};
    if (plan.particle_passes == 2) {
        stages.push_back({"billboard.vert", WGPUShaderStage_Vertex});
        stages.push_back({"billboard.frag", WGPUShaderStage_Fragment});
    }
    if (dawn_reflected_group_count(stages) != pass.group_layouts.size())
        dawn_error("billboard program " + stem + " declares groups other than the pin's two.");
    for (std::uint32_t group = 0; group < pass.group_layouts.size(); ++group)
        pass.group_layouts[group] = create_dawn_reflected_layout(device, stages, group);
    auto attributes = vertex_attribute_array<upstream::billboard_instance_attributes.size()>();
    for (std::size_t index = 0; index < upstream::billboard_instance_attributes.size(); ++index) {
        const upstream::BillboardInstanceAttribute& row =
            upstream::billboard_instance_attributes[index];
        attributes[index] = WGPUVertexAttribute{nullptr, dawn_billboard_format(row.float_count),
                                                row.byte_offset, row.shader_location};
    }
    WGPUVertexBufferLayout instance_layout = WGPU_VERTEX_BUFFER_LAYOUT_INIT;
    instance_layout.stepMode = WGPUVertexStepMode_Instance;
    instance_layout.arrayStride = upstream::billboard_instance_stride_bytes;
    instance_layout.attributeCount = static_cast<std::uint32_t>(attributes.size());
    instance_layout.attributes = attributes.data();

    // The descriptor the system was created with: the pinned
    // billboardBlend* the scene named, lowered as data.
    const SpriteBlendDescriptor& blend = system.blend;
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
    fragment_state.module = pass.module;
    fragment_state.targetCount = 1;
    fragment_state.targets = &color_target;

    // The depth pairing comes with the plan: writes iff cutout.
    WGPUDepthStencilState depth_state = WGPU_DEPTH_STENCIL_STATE_INIT;
    depth_state.format = depth_format;
    depth_state.depthCompare = dawn_depth_compare(upstream::pinned_depth_compare);
    depth_state.depthWriteEnabled =
        plan.cutout_writes_depth ? WGPUOptionalBool_True : WGPUOptionalBool_False;

    WGPUPipelineLayoutDescriptor layout_descriptor = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    layout_descriptor.bindGroupLayoutCount = static_cast<std::uint32_t>(pass.group_layouts.size());
    layout_descriptor.bindGroupLayouts = pass.group_layouts.data();
    DawnPipelineLayout pipeline_layout{wgpuDeviceCreatePipelineLayout(device, &layout_descriptor)};

    WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = pipeline_layout;
    descriptor.vertex.module = pass.module;
    descriptor.vertex.bufferCount = 1;
    descriptor.vertex.buffers = &instance_layout;
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    // The quad is expanded around a camera basis, so a billboard has no
    // consistent winding to cull against.
    descriptor.primitive.cullMode = WGPUCullMode_None;
    descriptor.depthStencil = &depth_state;
    descriptor.multisample.count = sample_count;
    descriptor.multisample.mask = 0xFFFFFFFFu;
    // The one a2c rule (pal_gpu_shared.hpp): at one sample WebGPU rejects
    // an a2c pipeline outright.
    descriptor.multisample.alphaToCoverageEnabled =
        alpha_to_coverage_enabled(system.alpha_to_coverage, sample_count);
    descriptor.fragment = &fragment_state;
    pass.pipeline = wgpuDeviceCreateRenderPipeline(device, &descriptor);
    if (!pass.pipeline) {
        pipeline_layout.reset();
        dawn_error("wgpuDeviceCreateRenderPipeline billboard");
    }

    if (plan.particle_passes == 2) {
        // The mode-4 second pass: the STOCK program, the Add blend the
        // generated builder resolved, and the same layout -- the pin builds
        // it as a copy of the system with its custom shader cleared.
        const SpriteBlendDescriptor& add = system.add_pass_blend;
        WGPUBlendState add_blend{};
        add_blend.color.operation = WGPUBlendOperation_Add;
        add_blend.color.srcFactor = dawn_sprite_blend_factor(add.color.src);
        add_blend.color.dstFactor = dawn_sprite_blend_factor(add.color.dst);
        add_blend.alpha.operation = WGPUBlendOperation_Add;
        add_blend.alpha.srcFactor = dawn_sprite_blend_factor(add.alpha.src);
        add_blend.alpha.dstFactor = dawn_sprite_blend_factor(add.alpha.dst);
        WGPUColorTargetState add_target = color_target;
        add_target.blend = add.enabled ? &add_blend : nullptr;
        pass.add_module = load_wgsl_module(device, "billboard.frag");
        WGPUFragmentState add_fragment = fragment_state;
        add_fragment.module = pass.add_module;
        add_fragment.targets = &add_target;
        WGPURenderPipelineDescriptor add_descriptor = descriptor;
        add_descriptor.vertex.module = pass.add_module;
        add_descriptor.fragment = &add_fragment;
        pass.add_pipeline = wgpuDeviceCreateRenderPipeline(device, &add_descriptor);
        if (!pass.add_pipeline) {
            pipeline_layout.reset();
            dawn_error("wgpuDeviceCreateRenderPipeline billboard add pass");
        }
    }
    pipeline_layout.reset();

    {
        WGPUBufferDescriptor instance_descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        instance_descriptor.usage = WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst;
        instance_descriptor.size =
            static_cast<std::uint64_t>(system.capacity) * upstream::billboard_instance_stride_bytes;
        pass.instances = wgpuDeviceCreateBuffer(device, &instance_descriptor);
        if (!pass.instances) {
            dawn_error("wgpuDeviceCreateBuffer billboard instances");
        }

        WGPUBufferDescriptor uniform_descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        uniform_descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        uniform_descriptor.size = upstream::billboard_system_ubo_bytes;
        pass.system_uniforms = wgpuDeviceCreateBuffer(device, &uniform_descriptor);
        if (!pass.system_uniforms) {
            dawn_error("wgpuDeviceCreateBuffer billboard uniforms");
        }
        if (system.custom_shader) {
            uniform_descriptor.size = upstream::sprite_fx_ubo_bytes;
            pass.fx_uniforms = wgpuDeviceCreateBuffer(device, &uniform_descriptor);
            if (!pass.fx_uniforms) {
                dawn_error("wgpuDeviceCreateBuffer billboard fx");
            }
        }
    }

    // rgba8unorm: `loadTexture2D` leaves srgb off, so the atlas texels reach
    // the blend stage as the bytes on disk.
    const std::uint32_t mip_levels = atlas_mip_levels(atlas);
    pass.atlas = upload_dawn_rgba_texture(device, queue, atlas.rgba.data(), atlas.rgba.size(),
                                          atlas.width, atlas.height, mip_levels);
    pass.atlas_mip_levels = mip_levels;
    pass.atlas_view = create_dawn_texture_view(pass.atlas, nullptr);
    pass.sampler = create_texture_sampler(device, atlas.sampler);

    for (const PixelsTexture& extra : system.custom_textures) {
        pass.extras.push_back(upload_dawn_extra_texture(device, queue, extra));
    }
    // Each binding the program declares takes the resource that serves the
    // name it is declared under: the pin's own names, whichever binding
    // numbers its composer gave them.
    const auto serve = [&](std::string_view name, WGPUBindGroupEntry& entry) {
        if (name == "billboards") {
            entry.buffer = pass.system_uniforms;
            entry.size = upstream::billboard_system_ubo_bytes;
        } else if (name == "fx" && pass.fx_uniforms) {
            entry.buffer = pass.fx_uniforms;
            entry.size = upstream::sprite_fx_ubo_bytes;
        } else if (name == "atlasTex") {
            entry.textureView = pass.atlas_view;
        } else if (name == "atlasSamp") {
            entry.sampler = pass.sampler;
        } else {
            return serve_dawn_extra_texture(name, system.custom_texture_names, pass.extras, entry);
        }
        return true;
    };
    pass.system_group =
        create_dawn_reflected_group(device, pass.group_layouts[1], stages, 1, serve);
    pass.scene_layout = dawn_reflected_layout(stages, 0);
    pass.frame_scene = create_dawn_billboard_scene(device, pass);
    return pass;
}

/**
 * Sorts the instances back to front in view space and uploads them, with the
 * uniforms the frame's camera settles.
 *
 * The UBO writes are small and run every frame; the sort+upload is gated
 * by the shared `billboard_needs_upload` rule, exactly as the SDL twin
 * gates it.
 */
inline void upload_dawn_billboard_pass(WGPUQueue queue, const Scene& scene, Engine& engine,
                                       DawnBillboardPass& pass,
                                       const upstream::SceneUniforms& scene_block,
                                       double delta_ms) {
    const BillboardSystemRecord& system = handle_at(engine.billboard_systems, pass.system);
    const std::array<float, 16>& view = scene_block.view;

    // The pass's scene block, which the program binds at group 0.
    wgpuQueueWriteBuffer(queue, pass.frame_scene.uniforms, 0, &scene_block, sizeof(scene_block));

    std::array<float, upstream::billboard_system_ubo_bytes / 4> system_ubo{};
    upstream::build_billboard_system_ubo(system, system_ubo);
    wgpuQueueWriteBuffer(queue, pass.system_uniforms, 0, system_ubo.data(),
                         system_ubo.size() * sizeof(float));

    // The pin advances the clock in `_update`, before and regardless of
    // whether the sorted instance data moved.
    if (system.custom_shader) {
        pass.elapsed_ms += delta_ms;
        std::array<float, upstream::sprite_fx_ubo_bytes / 4u> fx{};
        upstream::build_sprite_fx_ubo(static_cast<float>(pass.elapsed_ms / 1000.0),
                                      system.shader_params, fx);
        wgpuQueueWriteBuffer(queue, pass.fx_uniforms, 0, fx.data(), fx.size() * sizeof(float));
    }

    // One gating rule for both backends (`billboard_needs_upload`): an
    // unchanged view over unchanged instance data re-sorts and re-uploads
    // nothing.
    const Vec3d fo_offset = frame_floating_origin_offset(scene, engine);
    if (!billboard_needs_upload(system, pass.upload_stamp, view, fo_offset)) {
        return;
    }
    upstream::billboard_upload_instances(system, view, pass.sorted
#if BBLITE_FLOATING_ORIGIN
                                         ,
                                         fo_offset
#endif
    );
    wgpuQueueWriteBuffer(queue, pass.instances, 0, pass.sorted.data(),
                         pass.sorted.size() * sizeof(float));
    stamp_billboard_upload(pass.upload_stamp, system, view, fo_offset);
}

/**
 * Records the draw into an encoder the scene renderer already opened,
 * binding `scene` -- the frame's or the drawing task's own -- at group 0.
 */
inline void record_dawn_billboard_pass(WGPURenderPassEncoder encoder, Engine& engine,
                                       const DawnBillboardPass& pass,
                                       const DawnBillboardScene& scene) {
    const BillboardSystemRecord& system = handle_at(engine.billboard_systems, pass.system);
    if (!system.visible || system.count == 0) {
        return;
    }
    wgpuRenderPassEncoderSetPipeline(encoder, pass.pipeline);
    wgpuRenderPassEncoderSetIndexBuffer(encoder, pass.index_buffer, WGPUIndexFormat_Uint16, 0,
                                        sizeof(std::uint16_t) *
                                            upstream::billboard_index_data.size());
    wgpuRenderPassEncoderSetBindGroup(encoder, 0, scene.group, 0, nullptr);
    wgpuRenderPassEncoderSetBindGroup(encoder, 1, pass.system_group, 0, nullptr);
    wgpuRenderPassEncoderSetVertexBuffer(encoder, 0, pass.instances, 0,
                                         static_cast<std::uint64_t>(system.count) *
                                             upstream::billboard_instance_stride_bytes);
    wgpuRenderPassEncoderDrawIndexed(
        encoder, static_cast<std::uint32_t>(upstream::billboard_index_data.size()), system.count, 0,
        0, 0);

    if (pass.add_pipeline) {
        // The pin's own mode-4 wrapper: the primary draw leaves its buffers
        // and bind groups bound, so the second pass sets only its pipeline
        // before drawing the same instances, then restores the primary one.
        wgpuRenderPassEncoderSetPipeline(encoder, pass.add_pipeline);
        wgpuRenderPassEncoderDrawIndexed(
            encoder, static_cast<std::uint32_t>(upstream::billboard_index_data.size()),
            system.count, 0, 0, 0);
        wgpuRenderPassEncoderSetPipeline(encoder, pass.pipeline);
    }
}

inline void release_dawn_billboard_resources([[maybe_unused]] WGPUDevice device,
                                             DawnBillboardResources& pass) noexcept {
    if (pass.fx_uniforms)
        wgpuBufferRelease(pass.fx_uniforms);
    release_dawn_extra_textures(pass.extras);
    release_dawn_billboard_scene(pass.frame_scene);
    for (auto& [task, scene] : pass.task_scenes) {
        (void)task;
        release_dawn_billboard_scene(scene);
    }
    if (pass.system_group)
        wgpuBindGroupRelease(pass.system_group);
    if (pass.sampler)
        wgpuSamplerRelease(pass.sampler);
    if (pass.atlas_view)
        wgpuTextureViewRelease(pass.atlas_view);
    if (pass.atlas)
        wgpuTextureRelease(pass.atlas);

    if (pass.system_uniforms)
        wgpuBufferRelease(pass.system_uniforms);
    if (pass.instances)
        wgpuBufferRelease(pass.instances);
    if (pass.index_buffer)
        wgpuBufferRelease(pass.index_buffer);
    if (pass.add_pipeline)
        wgpuRenderPipelineRelease(pass.add_pipeline);
    if (pass.add_module)
        wgpuShaderModuleRelease(pass.add_module);
    for (WGPUBindGroupLayout layout : pass.group_layouts) {
        if (layout)
            wgpuBindGroupLayoutRelease(layout);
    }
    if (pass.module)
        wgpuShaderModuleRelease(pass.module);
    if (pass.pipeline)
        wgpuRenderPipelineRelease(pass.pipeline);
    pass = DawnBillboardResources{};
}

inline void release_dawn_billboard_pass(DawnBillboardPass& pass) { pass.reset(); }

} // namespace bbl::pal

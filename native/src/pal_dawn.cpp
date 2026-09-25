// The Dawn scene renderer's driver: the pass helpers, the pipelines the
// frame run builds and the frame run itself. The feature families it draws
// through are their own files (pal_dawn_scene_<family>.cpp), compiled with it
// as one translation unit (pal_dawn_scene_all.cpp).
#include <bblite/upstream/pinned_surface.hpp>
#include "pal_gpu_common.hpp"
#include "pal_gpu_frame.hpp"
#include "pal_gpu_textures.hpp"
#include "pal_gpu_surface.hpp"
#include "pal_gpu_sprites.hpp"
#include "pal_gpu_vertex.hpp"
#include "pal_gpu_materials.hpp"
#include "pal_gpu_shadows.hpp"
#include "pal_gpu_scene_blocks.hpp"
#include "pal_gpu_picking.hpp"
#include "pal_gpu_targets.hpp"
#include "pal_gpu_pipeline.hpp"
#include "pal_gpu_shader_passes.hpp"
#include <bblite/features/compute_frame_graph.hpp>
#include <bblite/features/device_recovery.hpp>
#include <bblite/features/gpu_task_timing.hpp>
#include <bblite/features/has_billboards.hpp>
#include <bblite/features/has_clustered_lights.hpp>
#include <bblite/features/has_effect_task.hpp>
#include <bblite/features/has_geometry_output.hpp>
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_picking.hpp>
#include <bblite/features/has_post_process.hpp>
#include <bblite/features/has_screen_space.hpp>
#include <bblite/features/has_splats.hpp>
#include <bblite/features/has_sprite_renderer.hpp>
#include <bblite/features/has_text.hpp>
#include <bblite/features/has_ui.hpp>
#include <bblite/features/mesh_position_update.hpp>
#include <bblite/features/offscreen_surfaces.hpp>
#include <bblite/features/workers.hpp>

#include "pal_dawn_scene.hpp"

namespace bbl::pal {
inline namespace dawn_scene {

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER)
void set_pass_viewport(WGPURenderPassEncoder pass, const std::optional<PixelViewport>& resolved) {
    if (!resolved.has_value())
        return;
    const PixelViewport& rect = *resolved;
    wgpuRenderPassEncoderSetViewport(pass, static_cast<float>(rect.x), static_cast<float>(rect.y),
                                     static_cast<float>(rect.width),
                                     static_cast<float>(rect.height), 0.0f, 1.0f);
    wgpuRenderPassEncoderSetScissorRect(
        pass, static_cast<std::uint32_t>(rect.x), static_cast<std::uint32_t>(rect.y),
        static_cast<std::uint32_t>(rect.width), static_cast<std::uint32_t>(rect.height));
}

void set_task_camera_viewport(WGPURenderPassEncoder pass, const CameraRecord* camera,
                              std::uint32_t target_width, std::uint32_t target_height) {
    set_pass_viewport(pass,
                      upstream::pass_camera_viewport(camera, static_cast<double>(target_width),
                                                     static_cast<double>(target_height)));
}

WGPUBuffer create_buffer(DawnState& state, WGPUBufferUsage usage, const void* data,
                         std::uint64_t size) {
    WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
    descriptor.usage = usage | WGPUBufferUsage_CopyDst;
    descriptor.size = (size + 3) & ~3ull;
    DawnBuffer buffer{wgpuDeviceCreateBuffer(state.device, &descriptor)};
    if (!buffer)
        dawn_error("wgpuDeviceCreateBuffer");
    if (data) {
        wgpuQueueWriteBuffer(state.queue, buffer, 0, data, size);
    }
    return buffer.release();
}

void fill_base_vertex_attributes(WGPUVertexAttribute* attributes) {
    std::uint32_t next = 0;
    const auto attribute = [&](std::uint32_t location, WGPUVertexFormat format,
                               std::uint64_t offset) {
        WGPUVertexAttribute& entry = attributes[next++];
        entry = WGPU_VERTEX_ATTRIBUTE_INIT;
        entry.format = format;
        entry.offset = offset;
        entry.shaderLocation = location;
    };
    attribute(0, WGPUVertexFormat_Float32x3, offsetof(GpuVertex, position));
    attribute(1, WGPUVertexFormat_Float32x3, offsetof(GpuVertex, normal));
    attribute(2, WGPUVertexFormat_Float32x4, offsetof(GpuVertex, tangent));
    attribute(3, WGPUVertexFormat_Float32x2, offsetof(GpuVertex, uv));
    attribute(5, WGPUVertexFormat_Float32x2, offsetof(GpuVertex, uv2));
    attribute(6, WGPUVertexFormat_Float32x4, offsetof(GpuVertex, color));
#if BBLITE_GPU_DEFORMATION
    attribute(8, WGPUVertexFormat_Float32x4, offsetof(GpuVertex, joints));
    attribute(9, WGPUVertexFormat_Float32x4, offsetof(GpuVertex, weights));
    attribute(10, WGPUVertexFormat_Float32x3, offsetof(GpuVertex, morph_position_0));
    attribute(11, WGPUVertexFormat_Float32x3, offsetof(GpuVertex, morph_position_1));
    attribute(12, WGPUVertexFormat_Float32x3, offsetof(GpuVertex, morph_normal_0));
    attribute(13, WGPUVertexFormat_Float32x3, offsetof(GpuVertex, morph_normal_1));
    attribute(14, WGPUVertexFormat_Float32x3, offsetof(GpuVertex, morph_tangent_0));
    attribute(15, WGPUVertexFormat_Float32x3, offsetof(GpuVertex, morph_tangent_1));
#endif
    if (next != base_vertex_attribute_count) {
        dawn_error("The shared stage's vertex table lost a lane.");
    }
}

PipelineKindTraits pipeline_traits(upstream::RenderPipelineKind kind) {
    const RenderPipelineKindTraits traits = pipeline_kind_traits(kind);
    if (traits.family == upstream::RenderMaterialKind::node) {
        dawn_error("render pipeline kind " + std::to_string(static_cast<int>(kind)) +
                   " is not implemented yet.");
    }
    PipelineKindTraits result;
    result.standard = traits.family == upstream::RenderMaterialKind::standard;
    result.transparent = traits.transparent;
    result.cull = dawn_cull_mode(traits.cull);
    result.front = traits.clockwise_front_face ? WGPUFrontFace_CW : WGPUFrontFace_CCW;
    result.shader = traits.family == upstream::RenderMaterialKind::shader;
    result.shader_a2c = pipeline_kind_wants_a2c(kind);
    // buildPrimitiveState's own table, in WebGPU's names. Every index draws
    // through the loader's uint32 buffer, so a strip's index format is that.
    switch (traits.topology) {
    case MeshTopology::triangles:
        result.topology = WGPUPrimitiveTopology_TriangleList;
        break;
    case MeshTopology::points:
        result.topology = WGPUPrimitiveTopology_PointList;
        break;
    case MeshTopology::lines:
        result.topology = WGPUPrimitiveTopology_LineList;
        break;
    case MeshTopology::line_strip:
        result.topology = WGPUPrimitiveTopology_LineStrip;
        result.strip_index_format = WGPUIndexFormat_Uint32;
        break;
    }
    return result;
}

WGPUBindGroupLayout diagnostic_group_layout(DawnState& state, std::uint32_t group) {
    return state.layouts.group(state.device, {DawnLayoutFamily::diagnostic, 0, group}, [group] {
        return dawn_reflected_layout_entries(diagnostic_stages, group);
    });
}

WGPUPipelineLayout diagnostic_pipeline_layout(DawnState& state) {
    return state.layouts.pipeline(state.device, {DawnLayoutFamily::diagnostic}, [&] {
        return std::vector{diagnostic_group_layout(state, 0), diagnostic_group_layout(state, 1),
                           diagnostic_group_layout(state, 2), diagnostic_group_layout(state, 3)};
    });
}

WGPUTextureSampleType shader_sample_type(upstream::ShaderSamplerSampleType type) {
    switch (type) {
    case upstream::ShaderSamplerSampleType::unfilterable_float:
        return WGPUTextureSampleType_UnfilterableFloat;
    case upstream::ShaderSamplerSampleType::depth:
        return WGPUTextureSampleType_Depth;
    case upstream::ShaderSamplerSampleType::float_sample:
        return WGPUTextureSampleType_Float;
    }
    dawn_error("Unknown shader sampler sample type.");
}

WGPUTextureViewDimension shader_view_dimension(upstream::ShaderSamplerViewDimension dimension) {
    switch (dimension) {
    case upstream::ShaderSamplerViewDimension::texture_2d_array:
        return WGPUTextureViewDimension_2DArray;
    case upstream::ShaderSamplerViewDimension::texture_2d:
        return WGPUTextureViewDimension_2D;
    }
    dawn_error("Unknown shader sampler view dimension.");
}

WGPUBindGroupLayout shader_group_layout(DawnState& state, std::uint32_t variant,
                                        std::size_t group) {
    return state.layouts.group(state.device, {DawnLayoutFamily::shader, variant, group}, [&] {
        const upstream::ShaderVariantInfo& info = upstream::shader_variant_info(variant);
        std::vector<WGPUBindGroupLayoutEntry> entries;
        switch (group) {
        case 0: {
            std::uint32_t binding = 0;
            for (const upstream::ShaderStorageBufferInfo& storage : info.storage_buffers) {
                if (storage.vertex)
                    entries.push_back(storage_layout_entry(binding++, WGPUShaderStage_Vertex));
            }
            break;
        }
        case 1:
            if (info.vertex.present)
                entries.push_back(uniform_layout_entry(0, WGPUShaderStage_Vertex));
            break;
        case 2: {
            // Fragment storage follows the texture/sampler pairs.
            std::uint32_t binding = static_cast<std::uint32_t>(info.samplers.size() * 2);
            for (const upstream::ShaderStorageBufferInfo& storage : info.storage_buffers) {
                if (storage.fragment)
                    entries.push_back(storage_layout_entry(binding++, WGPUShaderStage_Fragment));
            }
            for (std::size_t slot = 0; slot < info.samplers.size(); ++slot) {
                const upstream::ShaderSamplerShape shape = slot < info.sampler_shapes.size()
                                                               ? info.sampler_shapes[slot]
                                                               : upstream::ShaderSamplerShape{};
                WGPUBindGroupLayoutEntry texture = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
                texture.binding = static_cast<std::uint32_t>(slot * 2);
                texture.visibility = WGPUShaderStage_Fragment;
                texture.texture.sampleType = shader_sample_type(shape.sample_type);
                texture.texture.viewDimension = shader_view_dimension(shape.view_dimension);
                entries.push_back(texture);
                WGPUBindGroupLayoutEntry sampler = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
                sampler.binding = static_cast<std::uint32_t>(slot * 2 + 1);
                sampler.visibility = WGPUShaderStage_Fragment;
                sampler.sampler.type =
                    shape.comparison ? WGPUSamplerBindingType_Comparison
                    : shape.sample_type == upstream::ShaderSamplerSampleType::unfilterable_float
                        ? WGPUSamplerBindingType_NonFiltering
                        : WGPUSamplerBindingType_Filtering;
                entries.push_back(sampler);
            }
            break;
        }
        case 3:
            if (info.fragment.present)
                entries.push_back(uniform_layout_entry(0, WGPUShaderStage_Fragment));
            break;
        default:
            dawn_error("a ShaderMaterial layout has four groups.");
        }
        return entries;
    });
}

WGPUPipelineLayout shader_pipeline_layout_for(DawnState& state, std::uint32_t variant) {
    if (variant >= upstream::shader_variant_count())
        dawn_error("Unknown shader variant id.");
    return state.layouts.pipeline(state.device, {DawnLayoutFamily::shader, variant}, [&] {
        return std::vector{
            shader_group_layout(state, variant, 0), shader_group_layout(state, variant, 1),
            shader_group_layout(state, variant, 2), shader_group_layout(state, variant, 3)};
    });
}

DawnPipeline& pipeline_for(DawnState& state, upstream::RenderPipelineKind kind,
                           std::uint32_t shader_variant,
                           /** Zero asks for the frame's own sample count. */
                           std::uint32_t requested_samples, bool has_depth, bool shadow_pass,
                           std::optional<DawnTaskTarget> target) {
    // The main set is whatever matches the frame; a render-task target
    // that differs gets its own. Written as "matches the frame" rather
    // than "is 4x" so a single-sample run keeps one main set instead of
    // filing every pipeline under the task buckets.
    const std::uint32_t samples = requested_samples == 0 ? state.sample_count : requested_samples;
    const auto color_format = target ? target->color : state.frame_color_format;
    const auto depth_format = target ? target->depth
                                     : (shadow_pass ? WGPUTextureFormat_Depth32Float
                                                    : WGPUTextureFormat_Depth24PlusStencil8);
    auto& pipeline_map = state.pipelines;
    const auto pipeline_key =
        std::make_tuple(kind, shader_variant, samples, color_format,
                        has_depth ? depth_format : WGPUTextureFormat_Undefined, shadow_pass);
    const auto existing = pipeline_map.find(pipeline_key);
    if (existing != pipeline_map.end())
        return existing->second;
    const PipelineKindTraits traits = pipeline_traits(kind);
    // Every other family draws through its composed variant pipelines;
    // this one builds ShaderMaterial pipelines alone.
    if (!traits.shader) {
        dawn_error(traits.standard ? "transcribed Standard pipeline requested; the composed "
                                     "variants own every Standard draw."
                                   : "transcribed PBR pipeline requested; the composed "
                                     "variants own every PBR draw.");
    }
    const upstream::ShaderVariantInfo& shader_info = upstream::shader_variant_info(shader_variant);

    auto attributes = vertex_attribute_array<base_vertex_attribute_count>();
    fill_base_vertex_attributes(attributes.data());
    std::array<WGPUVertexBufferLayout, vertex_streams.size()> vertex_layouts{};
    vertex_layouts[0].stepMode = WGPUVertexStepMode_Vertex;
    vertex_layouts[0].arrayStride = sizeof(GpuVertex);
    vertex_layouts[0].attributeCount = attributes.size();
    vertex_layouts[0].attributes = attributes.data();
#if BBLITE_GPU_INSTANCING
    // Per-instance world-matrix columns at locations 16-19, exactly
    // like the SDL backend's second vertex buffer.
    auto instance_attributes = vertex_attribute_array<4>();
    for (std::uint32_t column = 0; column < 4; ++column) {
        instance_attributes[column].format = WGPUVertexFormat_Float32x4;
        instance_attributes[column].offset = column * 16;
        instance_attributes[column].shaderLocation = instance_matrix_first_location + column;
    }
    vertex_layouts[1].stepMode = WGPUVertexStepMode_Instance;
    vertex_layouts[1].arrayStride = sizeof(std::array<float, 16>);
    vertex_layouts[1].attributeCount = instance_attributes.size();
    vertex_layouts[1].attributes = instance_attributes.data();
    constexpr std::uint32_t matrix_vertex_buffer_count = 2;
#else
    constexpr std::uint32_t matrix_vertex_buffer_count = 1;
#endif
#if BBLITE_GPU_INSTANCE_COLORS
    // The per-instance RGBA stream the pin's own thin-instance module
    // appends after the matrix lanes, in its own tightly-packed buffer.
    // Only a material that declares the lane widens its layout, exactly as
    // the SDL backend widens that one pipeline: every other pipeline keeps
    // the layout it had, so no draw of theirs owes the slot a buffer.
    WGPUVertexAttribute instance_color_attribute = WGPU_VERTEX_ATTRIBUTE_INIT;
    instance_color_attribute.format = WGPUVertexFormat_Float32x4;
    instance_color_attribute.offset = 0;
    instance_color_attribute.shaderLocation = instance_color_location;
    vertex_layouts[2].stepMode = WGPUVertexStepMode_Instance;
    vertex_layouts[2].arrayStride = sizeof(std::array<float, 4>);
    vertex_layouts[2].attributeCount = 1;
    vertex_layouts[2].attributes = &instance_color_attribute;
    const std::uint32_t vertex_buffer_count =
        shader_info.instance_colors ? matrix_vertex_buffer_count + 1 : matrix_vertex_buffer_count;
#else
    constexpr std::uint32_t vertex_buffer_count = matrix_vertex_buffer_count;
#endif

    if (state.shader_vertex_modules.size() < upstream::shader_variant_count()) {
        state.shader_vertex_modules.resize(upstream::shader_variant_count(), nullptr);
        state.shader_fragment_modules.resize(upstream::shader_variant_count(), nullptr);
    }
    if (!state.shader_vertex_modules[shader_variant]) {
        const std::string base_name = shader_info.name;
        state.shader_vertex_modules[shader_variant] =
            load_wgsl_module(state, (base_name + ".vert").c_str());
    }
    if (!shadow_pass && !state.shader_fragment_modules[shader_variant]) {
        const std::string base_name = shader_info.name;
        state.shader_fragment_modules[shader_variant] =
            load_wgsl_module(state, (base_name + ".frag").c_str());
    }
    WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = shader_pipeline_layout_for(state, shader_variant);
    descriptor.vertex.module = state.shader_vertex_modules[shader_variant];
    descriptor.vertex.entryPoint = string_view("mainVertex");
    descriptor.vertex.bufferCount = vertex_buffer_count;
    descriptor.vertex.buffers = vertex_layouts.data();

    // The material's own primitive: the pin builds a shader pipeline at
    // `material._topology ?? "triangle-list"`, and a line material is the
    // one reached material that names the second one.
    descriptor.primitive.topology = shader_info.topology == upstream::ShaderTopology::line_list
                                        ? WGPUPrimitiveTopology_LineList
                                        : WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.frontFace = traits.front;
    // The pinned shader-pipeline mapping drives variant state:
    // backFaceCulling selects the cull mode, and depthWrite=false turns
    // depth writes off (as a transparent draw does).
    descriptor.primitive.cullMode =
        shader_info.back_face_culling ? WGPUCullMode_Back : WGPUCullMode_None;

    const bool depth_write_off = traits.transparent || !shader_info.depth_write;
    WGPUDepthStencilState depth_stencil = WGPU_DEPTH_STENCIL_STATE_INIT;
    depth_stencil.format = depth_format;
    depth_stencil.depthWriteEnabled =
        depth_write_off ? WGPUOptionalBool_False : WGPUOptionalBool_True;
    depth_stencil.depthCompare = dawn_depth_compare(
        shader_info.depth_compare ? *shader_info.depth_compare : pass_depth_compare(shadow_pass));
    // Depth-less render-task targets need attachment-compatible
    // pipelines; WebGPU validates what SDL_GPU tolerated.
    descriptor.depthStencil = has_depth ? &depth_stencil : nullptr;

    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    // The one a2c rule (shared GPU helpers): coverage needs samples to
    // spread across; at one sample WebGPU rejects the pipeline outright.
    descriptor.multisample.alphaToCoverageEnabled =
        alpha_to_coverage_enabled(traits.shader_a2c, samples);

    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = color_format;
    WGPUBlendState blend{};
    if (traits.transparent || shader_info.alpha_blending) {
        blend = blend_state_from(shader_info.additive_blending ? shader_additive_blend
                                                               : transparent_blend);
        color_target.blend = &blend;
    }
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = state.shader_fragment_modules[shader_variant];
    fragment.entryPoint = string_view("mainFragment");
    fragment.targetCount = 1;
    fragment.targets = &color_target;
    descriptor.fragment = shadow_pass ? nullptr : &fragment;

    DawnRenderPipeline pipeline{wgpuDeviceCreateRenderPipeline(state.device, &descriptor)};
    if (!pipeline)
        dawn_error("wgpuDeviceCreateRenderPipeline");
    DawnPipeline& slot = pipeline_map[pipeline_key];
    slot.pipeline = pipeline.release();
    return slot;
}

WGPURenderPipeline depth_only_pipeline_for(DawnState& state, bool double_sided,
                                           std::uint32_t samples, WGPUTextureFormat format) {
    WGPURenderPipeline& slot =
        state.depth_only_pipelines[std::make_tuple(double_sided, samples, format)];
    if (slot)
        return slot;
    if (!state.depth_only_module) {
        state.depth_only_module = load_wgsl_module(state, "depth-only.frag");
    }
    // Explicit stage layouts let both culling variants share the mesh's
    // morph group and the task's camera/world/deformation group.
    const std::array<DawnLayoutStage, 1> stages{{{"pbr.vert", WGPUShaderStage_Vertex}}};
    DawnBindGroupLayout morph_layout{create_dawn_reflected_layout(state.device, stages, 0)};
    DawnBindGroupLayout mesh_layout{create_dawn_reflected_layout(state.device, stages, 1)};
    const std::array<WGPUBindGroupLayout, 2> group_layouts{morph_layout.get(), mesh_layout.get()};
    WGPUPipelineLayoutDescriptor layout_descriptor = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    layout_descriptor.bindGroupLayoutCount = group_layouts.size();
    layout_descriptor.bindGroupLayouts = group_layouts.data();
    DawnPipelineLayout layout{wgpuDeviceCreatePipelineLayout(state.device, &layout_descriptor)};
    auto attributes = vertex_attribute_array<base_vertex_attribute_count>();
    fill_base_vertex_attributes(attributes.data());
    std::array<WGPUVertexBufferLayout, 2> vertex_layouts{};
    vertex_layouts[0].stepMode = WGPUVertexStepMode_Vertex;
    vertex_layouts[0].arrayStride = sizeof(GpuVertex);
    vertex_layouts[0].attributeCount = attributes.size();
    vertex_layouts[0].attributes = attributes.data();
#if BBLITE_GPU_INSTANCING
    auto instance_attributes = vertex_attribute_array<4>();
    for (std::uint32_t column = 0; column < 4; ++column) {
        instance_attributes[column].format = WGPUVertexFormat_Float32x4;
        instance_attributes[column].offset = column * 16;
        instance_attributes[column].shaderLocation = instance_matrix_first_location + column;
    }
    vertex_layouts[1].stepMode = WGPUVertexStepMode_Instance;
    vertex_layouts[1].arrayStride = sizeof(std::array<float, 16>);
    vertex_layouts[1].attributeCount = instance_attributes.size();
    vertex_layouts[1].attributes = instance_attributes.data();
#endif
    WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = layout;
    descriptor.vertex.module = state.vertex_module;
    descriptor.vertex.entryPoint = string_view("mainVertex");
    descriptor.vertex.bufferCount = BBLITE_GPU_INSTANCING ? 2 : 1;
    descriptor.vertex.buffers = vertex_layouts.data();
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.frontFace = WGPUFrontFace_CCW;
    descriptor.primitive.cullMode = double_sided ? WGPUCullMode_None : WGPUCullMode_Back;
    WGPUDepthStencilState depth_stencil = WGPU_DEPTH_STENCIL_STATE_INIT;
    depth_stencil.format = format;
    depth_stencil.depthWriteEnabled = WGPUOptionalBool_True;
    depth_stencil.depthCompare = dawn_depth_compare(upstream::pinned_depth_compare);
    descriptor.depthStencil = &depth_stencil;
    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = state.depth_only_module;
    fragment.entryPoint = string_view("mainFragment");
    fragment.targetCount = 0;
    descriptor.fragment = &fragment;
    slot = wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
    if (!slot)
        dawn_error("depth-only pipeline creation failed.");
    return slot;
}

WGPURenderPipeline create_diagnostic_pipeline(DawnState& state, WGPUShaderModule fragment_module,
                                              bool double_sided, std::uint32_t samples,
                                              const WGPUTextureFormat* color_formats,
                                              std::uint32_t color_count) {
    auto attributes = vertex_attribute_array<base_vertex_attribute_count>();
    fill_base_vertex_attributes(attributes.data());
    std::array<WGPUVertexBufferLayout, 2> vertex_layouts{};
    vertex_layouts[0].stepMode = WGPUVertexStepMode_Vertex;
    vertex_layouts[0].arrayStride = sizeof(GpuVertex);
    vertex_layouts[0].attributeCount = attributes.size();
    vertex_layouts[0].attributes = attributes.data();
#if BBLITE_GPU_INSTANCING
    auto instance_attributes = vertex_attribute_array<4>();
    for (std::uint32_t column = 0; column < 4; ++column) {
        instance_attributes[column].format = WGPUVertexFormat_Float32x4;
        instance_attributes[column].offset = column * 16;
        instance_attributes[column].shaderLocation = 16 + column;
    }
    vertex_layouts[1].stepMode = WGPUVertexStepMode_Instance;
    vertex_layouts[1].arrayStride = sizeof(std::array<float, 16>);
    vertex_layouts[1].attributeCount = instance_attributes.size();
    vertex_layouts[1].attributes = instance_attributes.data();
    constexpr std::uint32_t vertex_buffer_count = 2;
#else
    constexpr std::uint32_t vertex_buffer_count = 1;
#endif
    WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = diagnostic_pipeline_layout(state);
    descriptor.vertex.module = state.vertex_module;
    descriptor.vertex.entryPoint = string_view("mainVertex");
    descriptor.vertex.bufferCount = vertex_buffer_count;
    descriptor.vertex.buffers = vertex_layouts.data();
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.frontFace = WGPUFrontFace_CCW;
    descriptor.primitive.cullMode = double_sided ? WGPUCullMode_None : WGPUCullMode_Back;
    WGPUDepthStencilState depth_stencil = WGPU_DEPTH_STENCIL_STATE_INIT;
    depth_stencil.format = WGPUTextureFormat_Depth24PlusStencil8;
    depth_stencil.depthWriteEnabled = WGPUOptionalBool_True;
    depth_stencil.depthCompare = dawn_depth_compare(upstream::pinned_depth_compare);
    descriptor.depthStencil = &depth_stencil;
    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    std::array<WGPUColorTargetState, 4> color_targets{};
    for (std::uint32_t index = 0; index < color_count; ++index) {
        color_targets[index] = WGPU_COLOR_TARGET_STATE_INIT;
        color_targets[index].format = color_formats[index];
    }
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = fragment_module;
    fragment.entryPoint = string_view("mainFragment");
    fragment.targetCount = color_count;
    fragment.targets = color_targets.data();
    descriptor.fragment = &fragment;
    DawnRenderPipeline pipeline{wgpuDeviceCreateRenderPipeline(state.device, &descriptor)};
    if (!pipeline) {
        dawn_error("diagnostic render pipeline creation failed.");
    }
    return pipeline.release();
}
#endif

} // namespace dawn_scene
} // namespace bbl::pal

#if BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER
namespace bbl::pal {
class DawnSceneRun {

    struct State : FrameSession {
        const bool cpu_profile = environment_variable("BBLITE_CPU_PROFILE") == "1";
        const MemoryProfile mem_profile;
        CpuStartupMark cpu_startup_mark{cpu_profile, "dawn"};
        const std::vector<std::shared_ptr<Scene>> active_registered_scenes = engine.scenes();
        const std::shared_ptr<Scene> active_scene = active_registered_scenes.front();
        Scene& scene = *active_scene;
        DawnState state;
        std::uint32_t width = 0, height = 0;
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        std::unique_ptr<UiRmlRuntime, decltype(&destroy_ui_rml_runtime)> ui_runtime{
            nullptr, &destroy_ui_rml_runtime};
#endif
        upstream::RenderPlan render_plan;
        std::vector<upstream::RenderPlan> overlay_plans;
        std::vector<std::uint64_t> overlay_topology_versions;
        std::uint64_t synced_render_topology_version = 0, synced_draw_list_epoch = 0;
        std::uint32_t synced_material_family_mask = 0;
        CameraPointerState pointer_state;
        SurfaceCameraPointerState surface_pointer_state;
        CameraTraceState camera_trace_state;
        // Each pass's view-projection and scene blocks, which a camera-less
        // pass keeps.
        RetainedSceneBlocks pass_blocks;
        std::vector<float> shader_block_scratch;
#if BBLITE_OFFSCREEN_SURFACES
        OffscreenRun* offscreen = nullptr;
        OffscreenImagePool<DawnOffscreenImage> offscreen_images;
#endif
#if BBLITE_HAS_PICKING
#if BBLITE_HAS_BILLBOARDS
        DawnBillboardPickContributor billboard_pick;
#endif
        std::optional<PickHookGuard> pick_hook_guard;
#endif
#if BBLITE_DEVICE_RECOVERY
        std::optional<DrawCountScope> draw_count_scope;
#endif
        explicit State(Engine& target) : FrameSession(target) {}
    } data_;

    struct Frame {
        // Keep construction explicit while optional inspects this nested type.
        Frame() {}
        bool yield_when_skipped = false;
#if BBLITE_OFFSCREEN_SURFACES
        DawnOffscreenImage* offscreen_image = nullptr;
#endif
        double benchmark_start = 0, delta_ms = 0, updated = 0, uploaded = 0, written = 0,
               acquired = 0;
        bool capture_ready = false, frame_graph_presented = false;
        PixelViewport surface_extent{};
        CameraPassMatrices frame_camera{};
        ShaderPassMatrices frame_pass_matrices{};
        const Scene* pass_scene = nullptr;
        std::vector<DawnMesh>* pass_meshes = nullptr;
#if BBLITE_NODE_VARIANTS > 0
        NodeMeshBlockCache node_mesh_blocks;
#endif
        WGPUSurfaceTexture surface_texture = WGPU_SURFACE_TEXTURE_INIT;
        DawnTexture surface;
        DawnTextureView surface_view;
        DawnCommandEncoder encoder;
        WGPUTexture capture_source = nullptr;
    };
    std::optional<Frame> frame_;

    /** The frame `prepare` opened; every later stage records into it. */
    Frame& current_frame() {
        if (!frame_)
            throw std::logic_error("Dawn scene stage ran outside an acquired frame.");
        return *frame_;
    }

    /** The run scene's `scene_camera`. */
    CameraRecord* active_camera() { return scene_camera(data_.engine, data_.scene); }

    void rebuild_task_draw_lists() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& state = data_.state;
        [[maybe_unused]] auto& render_plan = data_.render_plan;
        [[maybe_unused]] auto& overlay_plans = data_.overlay_plans;

        if (state.render_tasks.size() < engine.frame_tasks.size()) {
            state.render_tasks.resize(engine.frame_tasks.size());
        }
        for (std::size_t layer = 0; layer < engine.scenes().size(); ++layer) {
            const Scene& task_scene = *engine.scenes()[layer];
            const auto& task_plan = layer == 0 ? render_plan : overlay_plans[layer - 1];
            for (const TaskHandle handle : task_scene.tasks) {
                if (handle.value >= engine.frame_tasks.size()) {
                    throw std::runtime_error("Scene frame task handle is invalid.");
                }
                FrameTaskRecord& task = handle_at(engine.frame_tasks, handle);
                if (task.kind != FrameTaskKind::render && task.kind != FrameTaskKind::geometry) {
                    continue;
                }
                DawnRenderTask& render_task = handle_at(state.render_tasks, handle);
                if (!render_task.view_projection) {
                    render_task.view_projection =
                        create_buffer(state, WGPUBufferUsage_Uniform, nullptr, 64);
                }
                render_task.draw_lists =
                    upstream::build_render_task_draw_lists(task_plan.items, engine, task);
                task.render_recorded = true;
                task.render_meshes_dirty = false;
            }
        }
    }

    void capture_render_state() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& frame_options = data_.frame_options;
        [[maybe_unused]] auto& captures = data_.captures;
        [[maybe_unused]] auto& frame = data_.frame;
        [[maybe_unused]] auto& scene = data_.scene;
        [[maybe_unused]] auto& state = data_.state;
        [[maybe_unused]] auto& width = data_.width;
        [[maybe_unused]] auto& height = data_.height;
        [[maybe_unused]] auto& render_plan = data_.render_plan;
        [[maybe_unused]] const auto& matrix = current_frame().frame_camera.view_projection;
        [[maybe_unused]] const auto& capture_ready = current_frame().capture_ready;

        if (capture_ready && !captures.render_capture_saved &&
            !frame_options.render_capture_path.empty()) {
            const CameraRecord* camera = active_camera();
            if (!camera) {
                throw std::runtime_error("The render capture records the active camera and the "
                                         "draws it projects; this scene has no active camera.");
            }
            write_render_capture(frame_options.render_capture_path, "dawn", scene, engine, *camera,
                                 render_plan, matrix, static_cast<int>(width),
                                 static_cast<int>(height), frame
#if BBLITE_HAS_TEXT
                                 ,
                                 &state.text->device->owner->capture
#elif BBLITE_NODE_GEOMETRY_VARIANTS > 0
                                 ,
                                 nullptr
#endif
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
                                 ,
                                 &state.node_capture.capture
#endif
            );
            captures.render_capture_saved = true;
        }
    }

    void write_material_uniforms(const upstream::RenderDrawList& list,
                                 const ShaderPassMatrices& pass_matrices,
                                 bool pass_dependent_only = false) {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& state = data_.state;
        [[maybe_unused]] auto& shader_block_scratch = data_.shader_block_scratch;
        [[maybe_unused]] auto& pass_scene = current_frame().pass_scene;
        [[maybe_unused]] auto& pass_meshes = current_frame().pass_meshes;
#if BBLITE_NODE_VARIANTS > 0
        [[maybe_unused]] auto& node_mesh_blocks = current_frame().node_mesh_blocks;
#endif

        for (const upstream::RenderDrawCommand& draw : list.commands) {
            DawnMesh& draw_mesh = (*pass_meshes)[draw.item_index];
            const bool shader_draw =
                draw.item.material_kind == upstream::RenderMaterialKind::shader;
            if (pass_dependent_only && !shader_draw) {
                continue;
            }
            // The per-mesh vertex, deformation, instancing and
            // morph state is synced once per frame by the item
            // pass above; a draw writes only the blocks its
            // material kind owns.
            if (draw.item.material_kind == upstream::RenderMaterialKind::standard) {
#if BBLITE_STANDARD_VARIANTS > 0
                // The pin's own per-draw blocks; the transcribed
                // block is retired, so an unresolved draw errors
                // naming the mesh, matching the SDL_GPU backend.
                const std::size_t variant = standard_variant_for_draw(*pass_scene, engine, draw);
                if (variant == npos) {
                    dawn_error(("Standard draw for mesh " + std::to_string(draw.item.mesh.value) +
                                ", material " + std::to_string(draw.item.material.value) +
                                " resolves no composed variant: " +
                                standard_variant_request(*pass_scene, engine, draw))
                                   .c_str());
                }
                const MaterialRecord* standard_material =
                    handle_find(engine.materials, draw.item.material);
#if BBLITE_STANDARD_SKELETON
                if (upstream::standard_variant_skeleton(upstream::standard_variants[variant])) {
                    write_pinned_bone_texture(state, draw_mesh,
                                              handle_at(engine.meshes, draw.item.mesh));
                }
#endif
                DawnDrawState& standard_state =
                    ensure_standard_draw_buffers(state, draw_mesh, draw.item.material.value);
                // The bind group builds at encode: a depth-sampled
                // emissive render texture's view resolves only
                // after the frame-graph textures exist.
                standard_state.group_key =
                    variant * 2 +
                    ((standard_material && standard_material->has_emissive_render_texture) ? 1 : 0);
                write_standard_draw_blocks(state, *pass_scene, engine, draw,
                                           standard_state.mesh_uniforms, standard_state);
#else
                dawn_error("Standard draw in a build with no composed "
                           "variant table; the transcribed fragment is "
                           "retired.");
#endif
#if BBLITE_NODE_VARIANTS > 0
            } else if (draw.item.material_kind == upstream::RenderMaterialKind::node) {
                const std::size_t variant = draw.item.shader_variant;
                DawnDrawState& node_state =
                    ensure_node_draw_buffers(state, draw_mesh, draw.item.material.value,
                                             upstream::node_variants.at(variant));
                write_node_mesh_block(
                    state,
                    node_mesh_block_for(node_mesh_blocks, *pass_scene, engine, draw.item.mesh),
                    node_state);
                // The group itself is built at encode: a receiving
                // graph binds the generators' maps, which the frame
                // graph has not created yet at this point.
#endif
            } else if (shader_draw) {
                if (draw.item.material.value < engine.materials.size()) {
                    const MaterialRecord& material =
                        handle_at(engine.materials, draw.item.material);
                    const upstream::ShaderVariantInfo& shader_info =
                        upstream::shader_variant_info(draw.item.shader_variant);
                    const ShaderDrawMatrices shader_matrices(
                        *pass_scene, engine, handle_at(engine.meshes, draw.item.mesh),
                        pass_matrices);
                    const ShaderPassMatrices shader_pass_matrices =
                        shader_matrices.apply(pass_matrices);
                    // A block that is exactly the shared scene
                    // matrix binds the frame's own buffer and
                    // needs no write; everything else -- custom
                    // gathers, or several system matrices --
                    // owns the material's buffer and is filled
                    // here.
                    const auto write_stage_block =
                        [&](const upstream::ShaderVariantStageBlock& block, WGPUBuffer buffer) {
                            if (!block.present || block_is_shared_scene_matrix(block)) {
                                return;
                            }
                            shader_stage_block_floats(block, shader_pass_matrices, material,
                                                      shader_block_scratch);
                            wgpuQueueWriteBuffer(state.queue, buffer, 0,
                                                 shader_block_scratch.data(),
                                                 shader_block_scratch.size() * sizeof(float));
                        };
                    write_stage_block(shader_info.vertex, draw_mesh.shader_vertex_uniforms);
                    write_stage_block(shader_info.fragment, draw_mesh.material_uniforms);
                } else {
                    // The SDL backend's named refusal: encoding
                    // the draw with stale or zero uniforms is
                    // the silent alternative.
                    pal::refuse_invalid_frame_handle("Shader draw has an invalid material.");
                }
            } else {
#if BBLITE_PBR_VARIANTS > 0
                // The pin's own per-draw blocks. The transcribed
                // block is retired: a PBR draw that resolves no
                // variant is an error naming the mesh, matching the
                // SDL_GPU backend.
                pal::PinnedVariantKey pinned_key;
                const std::size_t variant =
                    pinned_variant_for_draw(*pass_scene, engine, draw, npos, &pinned_key);
                if (variant == npos) {
                    dawn_error(
                        ("PBR draw for mesh " + std::to_string(draw.item.mesh.value) +
                         ", material " + std::to_string(draw.item.material.value) +
                         " resolves no pinned variant: " + pal::pinned_variant_request(pinned_key))
                            .c_str());
                }
                {
                    const MeshRecord& variant_record = handle_at(engine.meshes, draw.item.mesh);
                    if (pinned_variant_skeleton(variant)) {
                        write_pinned_bone_texture(state, draw_mesh, variant_record);
                    }
#if BBLITE_VAT
                    // Before the bind group is built: the settings
                    // buffer it names has to exist by then, and a
                    // cached group keeps the same buffer while the
                    // clock is rewritten in place.
                    if (pinned_variant_vat(variant)) {
                        write_pinned_vat_texture(state, draw_mesh, variant_record, engine);
                    }
#endif
                    DawnDrawState& pinned_state = ensure_pinned_draw_bindings(
                        state, draw_mesh, draw.item.material.value, variant,
                        handle_find(engine.materials, draw.item.material));
                    write_pinned_draw_blocks(state, *pass_scene, engine, draw, variant,
                                             pinned_state);
                }
#else
                dawn_error("PBR draw in a build with no composed variant "
                           "table; the transcribed fragment is retired.");
#endif
            }
        }
    }

public:
    static constexpr FrameAcquirePhase acquire_phase = FrameAcquirePhase::before_encoding;
    explicit DawnSceneRun(Engine& engine) : data_(engine) {}
    bool keep_running() const { return data_.keep_running(); }
    void discard_frame() { frame_.reset(); }
    bool yield_when_skipped() const { return frame_ && frame_->yield_when_skipped; }

    void setup() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& frame_options = data_.frame_options;
        [[maybe_unused]] auto& cpu_startup_mark = data_.cpu_startup_mark;
        [[maybe_unused]] auto& active_registered_scenes = data_.active_registered_scenes;
        [[maybe_unused]] auto& scene = data_.scene;
        [[maybe_unused]] auto& state = data_.state;
        [[maybe_unused]] auto& width = data_.width;
        [[maybe_unused]] auto& height = data_.height;
        [[maybe_unused]] auto& render_plan = data_.render_plan;
        [[maybe_unused]] auto& overlay_plans = data_.overlay_plans;
        [[maybe_unused]] auto& overlay_topology_versions = data_.overlay_topology_versions;
        [[maybe_unused]] auto& synced_render_topology_version =
            data_.synced_render_topology_version;
        [[maybe_unused]] auto& synced_draw_list_epoch = data_.synced_draw_list_epoch;
        [[maybe_unused]] auto& synced_material_family_mask = data_.synced_material_family_mask;
        [[maybe_unused]] auto& benchmark_samples = data_.samples_ms;
        [[maybe_unused]] auto& screenshot_path = data_.frame_options.screenshot_path;
        [[maybe_unused]] const auto benchmark = data_.frame_options.benchmarking();
        [[maybe_unused]] auto& benchmark_frames = data_.frame_options.benchmark_frames;
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        [[maybe_unused]] auto& ui_runtime = data_.ui_runtime;
#endif
#if BBLITE_HAS_PICKING && BBLITE_HAS_BILLBOARDS
        [[maybe_unused]] auto& billboard_pick = data_.billboard_pick;
#endif
#if BBLITE_OFFSCREEN_SURFACES
        [[maybe_unused]] auto& offscreen = data_.offscreen;
#endif

        reject_unsupported_frame_options(frame_options, "Dawn",
                                         /*supports_single_sample=*/true,
                                         /*supports_copy_task=*/true);
        // Keep every planned wrapper alive through event dispatch. A UI callback
        // may replace the root or finish registering an awaited auxiliary scene;
        // either change rebuilds the backend before stale plans are used again.

        if (scene.transmission_enabled && !scene.tasks.empty()) {
            dawn_error("transmission combined with frame-graph tasks is not "
                       "implemented yet.");
        }
        apply_animation_seek(frame_options, scene);

        // Every attachment and pipeline reads this, so it is settled before
        // any of them is created. The count is the generated read of the
        // pin's own surface declaration, not a re-typed 4; there is no
        // capability probe here because WebGPU guarantees 4x support on the
        // surface formats this backend renders to, where SDL_GPU must ask.
        state.sample_count = frame_options.single_sample
                                 ? 1u
                                 : upstream::preferred_sample_count(engine.options.msaa_samples);

        DeviceOptions device_options = frame_device_options(frame_options);
#if BBLITE_GPU_INSTANCE_COLORS
        // With the per-instance RGBA lane the pin's own thin-instance module
        // appends, the specialized WGSL reaches the lane after the matrix
        // columns, and the limit has to cover that location.
        device_options.max_vertex_attributes = instance_color_location + 1;
#elif BBLITE_GPU_INSTANCING
        // The SDL-specialized WGSL feeds per-instance matrix columns at
        // locations 16-19; the WebGPU default caps attribute locations
        // below 16, so raise the device limit to cover location 19.
        device_options.max_vertex_attributes = 20;
#endif
        // Geometry MRT chains can exceed the default 32-byte color budget;
        // the entry's erased requiredLimits option is derived here from
        // the task records with the WebGPU render-target byte costs
        // (rgba8/bgra8/rgba16f cost 8, r32f 4, r16f 2).
        {
            std::uint32_t color_bytes_per_sample = 0;
            for (const FrameTaskRecord& task : engine.frame_tasks) {
                if (task.kind != FrameTaskKind::geometry)
                    continue;
                std::uint32_t total = 0;
                for (const GeometryTextureDescription& description : task.geometry.attachments) {
                    switch (geometry_texture_format(description)) {
                    case WGPUTextureFormat_R16Float:
                        total += 2;
                        break;
                    case WGPUTextureFormat_R32Float:
                        total += 4;
                        break;
                    default:
                        total += 8;
                        break;
                    }
                }
                if (task.geometry.target.value != invalid_handle) {
                    total += 8;
                }
                color_bytes_per_sample = std::max(color_bytes_per_sample, total);
            }
            if (color_bytes_per_sample > 32) {
                device_options.max_color_attachment_bytes_per_sample = color_bytes_per_sample;
            }
        }
        create_dawn_device(engine.options, device_options, state);
        sync_engine_canvas_size(state.window, engine);
        resize_dawn_surface(state, engine.options);
        cpu_startup_mark("window-device");

        width = state.surface_width;
        height = state.surface_height;
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        ui_runtime.reset(create_ui_rml_runtime(engine, state.window, width, height));
#endif

#if BBLITE_HAS_SPRITE_RENDERER
        // Sprite rendering contexts and their render targets may be created by a
        // before-render callback. Mirror all newly appended CPU records in handle
        // order both here and immediately after each callback run.
        sync_dawn_scene_sprites(state, engine);
#endif

        // Shared frame targets: 4x MSAA color (surface format, or linear
        // rgba16float for transmission frames whose multisampled texture
        // feeds the grab and the per-sample image processing) and the
        // browser's depth24plus-stencil8 depth buffer.
        state.frame_color_format =
            scene.transmission_enabled ? WGPUTextureFormat_RGBA16Float : state.surface_format;
        recreate_dawn_scene_targets(state, scene, width, height);
        if (scene.transmission_enabled) {
            // The pinned refraction target: the shared fixed-extent,
            // shortened-chain contract (shared GPU helpers), rgba16float.
            state.transmission_mip_count = transmission_grab_mip_count();
            WGPUTextureDescriptor transmission_descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
            transmission_descriptor.usage =
                WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding;
            transmission_descriptor.size = {
                transmission_grab_size,
                transmission_grab_size,
                1,
            };
            transmission_descriptor.format = WGPUTextureFormat_RGBA16Float;
            transmission_descriptor.mipLevelCount = state.transmission_mip_count;
            state.transmission_color =
                wgpuDeviceCreateTexture(state.device, &transmission_descriptor);
            if (!state.transmission_color) {
                dawn_error("wgpuDeviceCreateTexture transmission color");
            }
            state.transmission_color_view =
                create_dawn_texture_view(state.transmission_color, nullptr);
        }
#if BBLITE_HAS_SPRITE_RENDERER
        if (!scene.depth_hosted_sprite_layers.empty()) {
            state.scene_sprite_pass = create_dawn_scene_sprite_pass(
                state.device, state.queue, state.mips, engine, scene.depth_hosted_sprite_layers,
                state.sprite_render_textures, state.sprite_render_texture_views,
                state.frame_color_format, WGPUTextureFormat_Depth24PlusStencil8,
                state.sample_count);
            state.has_scene_sprite_pass = true;
        }
#endif

        state.vertex_module = load_wgsl_module(state, "pbr.vert");

        state.view_projection = create_buffer(state, WGPUBufferUsage_Uniform, nullptr, 64);
        state.white_texture =
            create_solid_texture(state, {255, 255, 255, 255}, WGPUTextureFormat_RGBA8Unorm, 1);
        state.white_view = create_dawn_texture_view(state.white_texture, nullptr);
        state.black_texture =
            create_solid_texture(state, {0, 0, 0, 255}, WGPUTextureFormat_RGBA8Unorm, 1);
        state.black_view = create_dawn_texture_view(state.black_texture, nullptr);
        state.normal_flat_texture =
            create_solid_texture(state, {128, 128, 255, 255}, WGPUTextureFormat_RGBA8Unorm, 1);
        state.normal_flat_view = create_dawn_texture_view(state.normal_flat_texture, nullptr);
        const auto cube_view = [&](WGPUTexture texture) {
            WGPUTextureViewDescriptor cube_descriptor = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
            cube_descriptor.dimension = WGPUTextureViewDimension_Cube;
            cube_descriptor.arrayLayerCount = 6;
            return create_dawn_texture_view(texture, &cube_descriptor);
        };
        state.black_cube =
            create_solid_texture(state, {0, 0, 0, 255}, WGPUTextureFormat_RGBA8Unorm, 6);
        state.black_cube_view = cube_view(state.black_cube);
        const std::vector<std::uint8_t> zero_rgba16f(8, 0);
        // `upload_environment` replaces this cube only when the scene carries
        // an environment. Without one the pin composes no IBL arm
        // (pbr-compose.ts `_hasIbl` needs PBR_HAS_ENV), so no variant samples
        // it; it only fills the superset layout's slot.
        state.environment_cube =
            create_solid_texture(state, zero_rgba16f, WGPUTextureFormat_RGBA16Float, 6);
        state.environment_cube_view = cube_view(state.environment_cube);
        state.brdf_texture =
            create_solid_texture(state, zero_rgba16f, WGPUTextureFormat_RGBA16Float, 1);
        state.brdf_view = create_dawn_texture_view(state.brdf_texture, nullptr);
        {
            WGPUSamplerDescriptor sampler_descriptor = WGPU_SAMPLER_DESCRIPTOR_INIT;
            sampler_descriptor.addressModeU = WGPUAddressMode_Repeat;
            sampler_descriptor.addressModeV = WGPUAddressMode_Repeat;
            sampler_descriptor.addressModeW = WGPUAddressMode_Repeat;
            sampler_descriptor.magFilter = WGPUFilterMode_Linear;
            sampler_descriptor.minFilter = WGPUFilterMode_Linear;
            sampler_descriptor.mipmapFilter = WGPUMipmapFilterMode_Linear;
            state.default_sampler = wgpuDeviceCreateSampler(state.device, &sampler_descriptor);
            sampler_descriptor.addressModeU = WGPUAddressMode_ClampToEdge;
            sampler_descriptor.addressModeV = WGPUAddressMode_ClampToEdge;
            sampler_descriptor.addressModeW = WGPUAddressMode_ClampToEdge;
            state.clamp_sampler = wgpuDeviceCreateSampler(state.device, &sampler_descriptor);
            sampler_descriptor.lodMaxClamp = 0.0f;
            state.ground_sampler = wgpuDeviceCreateSampler(state.device, &sampler_descriptor);
            WGPUSamplerDescriptor nearest_descriptor = WGPU_SAMPLER_DESCRIPTOR_INIT;
            state.nearest_sampler = wgpuDeviceCreateSampler(state.device, &nearest_descriptor);
#if BBLITE_HAS_POST_PROCESS
            WGPUSamplerDescriptor post_process_descriptor = WGPU_SAMPLER_DESCRIPTOR_INIT;
            post_process_descriptor.magFilter = WGPUFilterMode_Linear;
            post_process_descriptor.minFilter = WGPUFilterMode_Linear;
            state.post_process_bilinear_sampler =
                wgpuDeviceCreateSampler(state.device, &post_process_descriptor);
#endif
            // The pinned scene-color sampler: repeat trilinear with the
            // shared anisotropy (getTrilinearAnisotropicSampler).
            WGPUSamplerDescriptor transmission_descriptor = WGPU_SAMPLER_DESCRIPTOR_INIT;
            transmission_descriptor.addressModeU = WGPUAddressMode_Repeat;
            transmission_descriptor.addressModeV = WGPUAddressMode_Repeat;
            transmission_descriptor.addressModeW = WGPUAddressMode_Repeat;
            transmission_descriptor.magFilter = WGPUFilterMode_Linear;
            transmission_descriptor.minFilter = WGPUFilterMode_Linear;
            transmission_descriptor.mipmapFilter = WGPUMipmapFilterMode_Linear;
            transmission_descriptor.maxAnisotropy =
                static_cast<std::uint16_t>(transmission_sampler_max_anisotropy);
            state.transmission_sampler =
                wgpuDeviceCreateSampler(state.device, &transmission_descriptor);
        }
#if BBLITE_GPU_MORPH_STORAGE
        {
            const std::array<float, 1> zero_delta{0.0f};
            state.empty_morph_deltas = create_buffer(state, WGPUBufferUsage_Storage,
                                                     zero_delta.data(), sizeof(zero_delta));
            state.empty_morph_weights =
                create_buffer(state, WGPUBufferUsage_Storage, empty_morph_weight_data.data(),
                              sizeof(empty_morph_weight_data));
        }
#endif
        upload_environment(state, scene.environment);
        upload_brdf(state, scene.environment);
        state.reflection_cubes.reserve(engine.reflection_cubes.size());
        state.reflection_cube_views.reserve(engine.reflection_cubes.size());
        for (const auto& cube : engine.reflection_cubes) {
            WGPUTexture texture = upload_reflection_cube(state, cube);
            state.reflection_cubes.push_back(texture);
            state.reflection_cube_views.push_back(cube_view(texture));
        }
        cpu_startup_mark("environment-background");

        // Every scene registered after the first is a swapchain overlay layer,
        // which is the pin's own trigger (scene/swapchain-overlay.ts): a later
        // scene on the same surface keeps the base scene's colour and clears
        // only its own depth. Each layer owns a plan because a draw command
        // indexes one.

        // What each layer's plan was built against; a layer that changes its
        // renderables afterwards is refused rather than drawn stale.

        synced_render_topology_version = scene.render_topology_version;
        synced_draw_list_epoch = engine.draw_list_epoch;
        // For the post-registration family guard the topology update runs,
        // exactly as the SDL backend tracks it.
        synced_material_family_mask = scene.material_family_mask;

        const auto initialize_render_tasks = [&] {
            state.release_render_tasks();
            state.render_tasks.resize(engine.frame_tasks.size());
            for (const TaskHandle handle : scene.tasks) {
                const FrameTaskRecord& task = handle_at(engine.frame_tasks, handle);
                if (task.kind == FrameTaskKind::render) {
                    DawnRenderTask& render_task = handle_at(state.render_tasks, handle);
                    render_task.view_projection =
                        create_buffer(state, WGPUBufferUsage_Uniform, nullptr, 64);
                }
            }
            rebuild_task_draw_lists();
        };
        const auto rebuild_meshes = [&] {
            render_plan = upstream::build_render_plan(scene, engine);
            // Validate every item's kind and variant before uploading anything.
            validate_render_plan_items(render_plan);
            cpu_startup_mark("render-plan");
            state.meshes.reserve(render_plan.items.size());
            for (const upstream::RenderItem& item : render_plan.items) {
                state.meshes.push_back(upload_dawn_scene_mesh(state, engine, item));
            }
            for (std::size_t layer = 1; layer < engine.scenes().size(); ++layer) {
                Scene* overlay_scene = engine.scenes()[layer].get();
                if (!overlay_scene)
                    continue;
                upstream::RenderPlan overlay_plan =
                    upstream::build_render_plan(*overlay_scene, engine);
                validate_render_plan_items(overlay_plan);
                std::vector<DawnMesh> overlay_layer_meshes;
                overlay_layer_meshes.reserve(overlay_plan.items.size());
                for (const upstream::RenderItem& item : overlay_plan.items) {
                    overlay_layer_meshes.push_back(upload_dawn_scene_mesh(state, engine, item));
                }
                overlay_plans.push_back(std::move(overlay_plan));
                state.overlay_meshes.push_back(std::move(overlay_layer_meshes));
                overlay_topology_versions.push_back(overlay_scene->render_topology_version);
            }
#if BBLITE_PINNED_MATERIALS
            state.overlay_frames.resize(overlay_plans.size());
#endif
            cpu_startup_mark("mesh-uploads");
            initialize_render_tasks();
            cpu_startup_mark("draw-lists-ready");
        };
        rebuild_meshes();

#if BBLITE_PINNED_BACKGROUNDS
        state.background_draws = pal::select_pinned_backgrounds(frame_options, scene.environment);
        initialize_dawn_backgrounds(state, scene);
#endif
        // The composed variant modules load lazily in the loop, so this phase
        // covers only the background/skybox/ground half SDL_GPU builds here too.
        cpu_startup_mark("shaders-pipelines");
#if BBLITE_HAS_TEXT
        state.text = std::make_unique<DawnTextRenderer>(
            state.device, state.queue, !environment_variable("BBLITE_RENDER_CAPTURE").empty());
        state.text->device->color_format = state.frame_color_format;
        state.text->device->depth_format = WGPUTextureFormat_Depth24PlusStencil8;
        const std::string text_color_format =
            state.frame_color_format == WGPUTextureFormat_BGRA8Unorm ? "bgra8unorm"
            : state.frame_color_format == WGPUTextureFormat_RGBA8Unorm
                ? "rgba8unorm"
                : throw std::runtime_error("Unrepresented default text color target.");
        const auto& text_surface = bbl::text_surface(engine);
        text_surface->device = state.text->device;
        state.text->scene.bind(
            scene, text_surface,
            TextTargetSignature{.color_format = text_color_format,
                                .depth_format = "depth24plus-stencil8",
                                .depth_compare = std::nullopt,
                                .sample_count = static_cast<double>(state.sample_count)});
#endif

#if BBLITE_HAS_UI && !BBLITE_WORKERS

#endif

        if (benchmark) {
            benchmark_samples.reserve(static_cast<std::size_t>(benchmark_frames));
        }

#if BBLITE_HAS_PICKING
        // The pick pass. Installed before the loop, because the continuation
        // that calls it arrives on the deferred queue at the first frame
        // boundary; a pick taken before this point reports a miss, exactly as
        // the pin's `pickAsync` does for a scene with no camera. The guard
        // clears the hook when this scope ends, however it ends: the hook
        // holds `state`, the scene and the render plan by reference, all of
        // which die with the scope.
        data_.pick_hook_guard.emplace(engine);
#if BBLITE_HAS_BILLBOARDS
        // The contributor's own GPU state, scoped to the hook it serves:
        // upstream it lives in the closure the picker cached and frees in
        // `disposePicker`, which is this scope.

#endif
        engine.pick_hook = [&state, &engine, &root_plan = render_plan, &overlay_plans,
                            &active_registered_scenes
#if BBLITE_HAS_BILLBOARDS
                            ,
                            &billboard_pick
#endif
        ]([[maybe_unused]] GpuPickerHandle picker, double x, double y,
                           const Engine::PickFilter* filter) -> PickingInfo {
            return pick_dawn_scene(state, engine, root_plan, overlay_plans,
                                   active_registered_scenes, picker, x, y, filter
#if BBLITE_HAS_BILLBOARDS
                                   ,
                                   billboard_pick
#endif
            );
        };
#endif

        // Caller-owned scratch for the custom-shader stage blocks: the packer
        // fills it in place, so the per-draw buffer writes reuse one
        // allocation across draws and frames.

#if BBLITE_GPU_INSTANCING && BBLITE_PBR_VARIANTS > 0

#endif
        // The shared drain owns the per-event contract; the scene loop only
        // adds its camera-controls dispatch, which rides the hook so every
        // event the scene receives also reaches the camera -- and none does
        // in a deterministic test pass.

#if BBLITE_OFFSCREEN_SURFACES
        offscreen = OffscreenRun::current();

        if (offscreen && !screenshot_path.empty()) {
            throw std::runtime_error("Capture offscreen output from its presentation host.");
        }
#endif
#if BBLITE_DEVICE_RECOVERY
        data_.draw_count_scope.emplace(engine);
#endif
    }

    FramePreparation prepare() {
        frame_.emplace();
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& input_replay = data_.input_replay;
        [[maybe_unused]] auto& running = data_.running;
        [[maybe_unused]] auto& frame = data_.frame;
        [[maybe_unused]] auto& active_registered_scenes = data_.active_registered_scenes;
        [[maybe_unused]] auto& scene = data_.scene;
        [[maybe_unused]] auto& state = data_.state;
        [[maybe_unused]] auto& width = data_.width;
        [[maybe_unused]] auto& height = data_.height;
        [[maybe_unused]] auto& pointer_state = data_.pointer_state;
        [[maybe_unused]] auto& surface_pointer_state = data_.surface_pointer_state;
        [[maybe_unused]] auto& hidden_test_pass = data_.frame_options.test_pass;
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        [[maybe_unused]] auto& ui_runtime = data_.ui_runtime;
#endif
#if BBLITE_OFFSCREEN_SURFACES
        [[maybe_unused]] auto& offscreen = data_.offscreen;
#endif
#if BBLITE_OFFSCREEN_SURFACES
        [[maybe_unused]] auto& offscreen_images = data_.offscreen_images;
#endif
#if BBLITE_OFFSCREEN_SURFACES
        [[maybe_unused]] auto& offscreen_image = current_frame().offscreen_image;
#endif
        const auto camera_pointer_hook = [&](const SDL_Event& event) {
            if (hidden_test_pass && !is_replayed_ui_event(event))
                return;
            dispatch_surface_camera_pointer(engine, event, active_camera(), pointer_state,
                                            surface_pointer_state);
        };

#if BBLITE_DEVICE_RECOVERY
        if (state.device_lost) {
            force_device_loss(engine);
            return FramePreparation::stop;
        }
        engine.draw_call_count = 0;
#endif
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
        state.node_capture.capture.begin_frame(static_cast<std::uint64_t>(frame));
#endif
        ++state.material_upload_frame;
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        poll_platform_events(
            engine, running, hidden_test_pass,
            [&](SDL_Event& event) { return handle_ui_rml_event(*ui_runtime, event); },
            camera_pointer_hook);
#else
        poll_platform_events(
            engine, running, hidden_test_pass, [](const SDL_Event&) { return true; },
            camera_pointer_hook);
#endif
#if BBLITE_OFFSCREEN_SURFACES
        if (offscreen && !running)
            return FramePreparation::stop;
#endif
        input_replay.dispatch(frame, state.window, engine);
        if (request_renderer_restart_if_scene_set_changed(engine, active_registered_scenes)) {
            return FramePreparation::restart;
        }
        sync_engine_canvas_size(state.window, engine);
        if (resize_dawn_surface(state, engine.options)) {
            width = state.surface_width;
            height = state.surface_height;
            recreate_dawn_scene_targets(state, scene, width, height);
        }
        if (state.window && !state.surface)
            return FramePreparation::skip;
#if BBLITE_OFFSCREEN_SURFACES
        offscreen_image = nullptr;
        if (offscreen) {
            offscreen_image =
                offscreen_images.acquire(width, height, *offscreen, [&](auto w, auto h) {
                    return std::make_shared<DawnOffscreenImage>(state.device, state.surface_format,
                                                                w, h);
                });
            if (!offscreen_image) {
                current_frame().yield_when_skipped = true;
                return FramePreparation::skip;
            }
        }
#endif
        // The benchmark bracket mirrors the SDL backend: frame CPU time
        // across the whole loop body -- scene callbacks and uploads, surface
        // acquire, submit and present -- under the immediate present mode
        // both backends configure. It starts here rather than at the
        // acquisition because SDL_GPU has to acquire before it may advance
        // the scene at all (a null swapchain must skip the frame entirely),
        // and a bracket that began at each backend's acquisition would then
        // cover a different span on each.

        return FramePreparation::ready;
    }

    FramePreparation update() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& frame_options = data_.frame_options;
        [[maybe_unused]] auto& frame_clock = data_.frame_clock;
        [[maybe_unused]] auto& cpu_profile = data_.cpu_profile;
        [[maybe_unused]] auto& active_registered_scenes = data_.active_registered_scenes;
        [[maybe_unused]] auto& scene = data_.scene;
        [[maybe_unused]] auto& width = data_.width;
        [[maybe_unused]] auto& height = data_.height;
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        [[maybe_unused]] auto& ui_runtime = data_.ui_runtime;
#endif
        [[maybe_unused]] auto& benchmark_start = current_frame().benchmark_start;
        [[maybe_unused]] auto& delta_ms = current_frame().delta_ms;
        [[maybe_unused]] auto& updated = current_frame().updated;
        benchmark_start = monotonic_milliseconds();
        // The frame trace, sprite passes and animated billboard passes
        // read the frame's own delta.
        delta_ms = advance_frame(engine, scene, frame_clock, frame_options.frame_delta_ms);
        // Scene callbacks may tear down this plan and register a replacement.
        // No surface or command encoder has been acquired yet, so restart
        // before syncing GPU resources or drawing from the disposed scene.
        if (request_renderer_restart_if_scene_set_changed(engine, active_registered_scenes)) {
            return FramePreparation::restart;
        }
#if BBLITE_GPU_TASK_TIMING
        begin_gpu_task_timing_frame(engine);
#endif
#if BBLITE_COMPUTE_FRAME_GRAPH
        begin_compute_frame_prefix(engine);
#endif
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        // Browser layout observes DOM changes made by this turn's RAF
        // callbacks before painting the frame.
        update_ui_rml_runtime(*ui_runtime, width, height);
#endif
        // The phase stamps below feed only the CPU profile, so with
        // profiling off they cost nothing; `benchmark_start` above stays
        // unconditional because the benchmark bracket reads it.
        updated = cpu_profile ? monotonic_milliseconds() : 0.0;

        return FramePreparation::ready;
    }

    /**
     * The GPU writes one plan row's refresh makes (`sync_plan_mesh_rows`),
     * as queue writes. WebGPU has no push constants, so a row also rewrites
     * the per-mesh vertex-stage blocks SDL_GPU pushes per draw.
     */
    struct MeshRowWrites {
        DawnState& state;
        Engine& engine;

#if BBLITE_GPU_INSTANCING
        void recreate_instances(DawnMesh& gpu, const MeshRecord& mesh) {
            // A submitted command buffer holds its own reference to the
            // released buffers, and this port records no bundles.
            const std::size_t rows = mesh.instance_matrices.size();
#if BBLITE_HAS_PICKING
            gpu.release_thin_pick_group();
#endif
            wgpuBufferRelease(gpu.instances);
            gpu.instances = create_buffer(state, WGPUBufferUsage_Vertex | WGPUBufferUsage_Storage,
                                          mesh.instance_matrices.data(),
                                          rows * sizeof(mesh.instance_matrices.front()));
#if BBLITE_GPU_INSTANCE_COLORS
            if (gpu.instance_colors) {
                // The colour mirror is the scene's own array and may still
                // be the shorter one; pad to the pool the way registration
                // does.
                std::vector<float> instance_colors = instance_colors_for_upload(mesh);
                instance_colors.resize(rows * 4, 1.0f);
                wgpuBufferRelease(gpu.instance_colors);
                gpu.instance_colors =
                    create_buffer(state, WGPUBufferUsage_Vertex, instance_colors.data(),
                                  instance_colors.size() * sizeof(float));
            }
#endif
        }

        void update_instances(DawnMesh& gpu, const MeshRecord& mesh, std::size_t active_count) {
            wgpuQueueWriteBuffer(state.queue, gpu.instances, 0, mesh.instance_matrices.data(),
                                 active_count * sizeof(mesh.instance_matrices.front()));
#if BBLITE_GPU_INSTANCE_COLORS
            if (gpu.instance_colors) {
                const auto colors = instance_colors_for_upload(mesh);
                if (colors.size() >= active_count * 4) {
                    wgpuQueueWriteBuffer(state.queue, gpu.instance_colors, 0, colors.data(),
                                         active_count * 4 * sizeof(float));
                }
            }
#endif
        }
#endif

        /**
         * The shared material stage's world and deformation blocks, for the
         * diagnostic and depth-only draws that read them; a shader-variant
         * stage owns its own. Neither carries a version, so both writes are
         * unconditional, as SDL_GPU's per-draw pushes are -- and so they are
         * asked the predicate the draw lists ask: the plan keeps a hidden
         * mesh for the pick pass, and visibility reaches the draw lists only
         * through a version bump whose rebuild runs earlier this frame.
         */
        void write_mesh_blocks(const Scene& scene, const upstream::RenderItem& item,
                               const MeshRecord& mesh, DawnMesh& gpu) {
            if (!upstream::mesh_draws(mesh) ||
                item.material_kind == upstream::RenderMaterialKind::shader) {
                return;
            }
            write_mesh_stage_blocks(state, scene, engine, mesh, gpu);
        }

#if BBLITE_MESH_POSITION_UPDATE
        void upload_vertices(DawnMesh& gpu, const std::vector<GpuVertex>& vertices) {
            wgpuQueueWriteBuffer(state.queue, gpu.vertices, 0, vertices.data(),
                                 vertices.size() * sizeof(GpuVertex));
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
            state.node_capture.update(gpu.vertices, vertices.data(),
                                      vertices.size() * sizeof(GpuVertex));
#endif
        }
#endif

#if BBLITE_GPU_MORPH_STORAGE
        void upload_morph_weights(DawnMesh& gpu, const ModelGeometry& geometry,
                                  const MeshRecord& mesh) {
            sync_morph_weights(state, gpu, geometry, mesh);
        }
#endif
    };

    /** The Dawn operations `synchronize_scene` orders. */
    struct SceneSync {
        DawnSceneRun& run;
        MeshRowWrites rows;

        void update_sprites([[maybe_unused]] double delta_ms) {
#if BBLITE_HAS_SPRITE_RENDERER
            auto& data = run.data_;
            DawnState& state = rows.state;
            // `_update` for every sprite context precedes every `_record`.
            // Scene callbacks may have changed layer membership or instance
            // data, so every sprite context synchronizes and uploads now.
            sync_dawn_scene_sprites(state, rows.engine);
            for (DawnSpritePass& sprite_pass : state.sprite_passes) {
                // `spriteRendererUpdate` runs the renderer's own hooks
                // before it reads its layers, so an overlay HUD's hook is
                // seen by this frame rather than the next.
                begin_sprite_renderer_update(rows.engine, sprite_pass.renderer, delta_ms);
                sync_dawn_sprite_pass_layers(state.device, state.queue, state.mips, rows.engine,
                                             sprite_pass, state.sprite_render_textures,
                                             state.sprite_render_texture_views);
                upload_dawn_sprite_pass(state.device, state.queue, rows.engine, sprite_pass,
                                        data.width, data.height, delta_ms);
            }
            if (state.has_scene_sprite_pass) {
                upload_dawn_scene_sprite_pass(state.device, state.queue, rows.engine,
                                              state.scene_sprite_pass, data.width, data.height,
                                              delta_ms);
            }
#endif
        }

        // Dawn command buffers retain submitted resources, so releasing a
        // removed row drops only this state's reference.
        void release_mesh(DawnMesh& mesh) { mesh.reset(); }

        DawnMesh upload_mesh(const upstream::RenderItem& item) {
            return upload_dawn_scene_mesh(rows.state, rows.engine, item);
        }

        void prune_shared_resources() {
            rows.state.prune_shared_shader_geometries();
            rows.state.prune_shared_shader_material_textures();
            rows.state.prune_shared_composed_material_textures();
        }

        // This backend loads its modules lazily, so the shared table guard
        // is its whole answer.
        void reject_unbuilt_family_growth(std::uint32_t) const {}

        std::size_t shared_shader_geometry_count() const {
            return rows.state.shared_shader_geometries.size();
        }
        std::size_t shared_shader_material_count() const {
            return rows.state.shared_shader_material_textures.size();
        }

        void rebuild_task_draw_lists() { run.rebuild_task_draw_lists(); }

        MeshRowWrites& mesh_rows() { return rows; }

        void publish_storage() { sync_shader_storage_buffers(rows.state, rows.engine); }

        // Queue writes land with the next submit; there is no batch to close.
        void submit_uploads() {}

        void mark_uploaded() {
            run.current_frame().uploaded = run.data_.cpu_profile ? monotonic_milliseconds() : 0.0;
        }

        void settle_pass(const SceneSyncOutcome& outcome) {
            Frame& frame = run.current_frame();
            frame.surface_extent = outcome.surface_extent;
            frame.frame_camera = outcome.pass.matrices;
            frame.frame_pass_matrices = frame.frame_camera.pass();
        }

        // A skinned draw's palette is written with its material blocks.
        void stream_bone_palettes() {}

        void mark_capture(bool topology_updated) {
            auto& data = run.data_;
            run.current_frame().capture_ready = data.frame >= data.frame_options.screenshot_frame &&
                                                !topology_updated &&
                                                data.captures.drains_resolved();
        }

        void update_clustered_lights([[maybe_unused]] const SceneSyncOutcome& outcome) {
#if BBLITE_HAS_CLUSTERED_LIGHTS
            // The cluster binning reads this frame's camera and the draws
            // read what it wrote. The pin's updater runs for every colour
            // pass over its camera and target, and its refresh returns
            // without a camera (render-task-base.ts, clustered.ts).
            const Scene& scene = run.data_.scene;
            if (ClusteredLightContainer* clustered =
                    upstream::clustered_container(rows.engine, scene.clustered_lights)) {
                upload_dawn_clustered(
                    rows.state.device, rows.state.queue, rows.engine, *clustered, scene.camera,
                    static_cast<double>(outcome.surface_extent.width),
                    static_cast<double>(outcome.surface_extent.height), rows.state.clustered);
            }
#endif
        }

        void update_text([[maybe_unused]] const SceneSyncOutcome& outcome) {
#if BBLITE_HAS_TEXT
            update_scene_text(*rows.state.text, run.data_.scene, run.data_.frame,
                              outcome.surface_extent, outcome.pass);
#endif
        }

        void upload_billboards([[maybe_unused]] const SceneSyncOutcome& outcome,
                               [[maybe_unused]] double delta_ms) {
#if BBLITE_HAS_BILLBOARDS
            DawnState& state = rows.state;
            const Scene& scene = run.data_.scene;
            // Lazily built, because the systems are known only once the
            // scene has run; the sort then follows the camera every frame.
            if (state.billboard_passes.empty()) {
                for (const BillboardSystemHandle system : scene.billboard_systems) {
                    state.billboard_passes.push_back(create_dawn_billboard_pass(
                        state.device, state.queue, rows.engine, system, state.frame_color_format,
                        WGPUTextureFormat_Depth24PlusStencil8, state.sample_count));
                    // The atlas reports the chain it allocated; the blit
                    // that fills it is this state's.
                    const DawnBillboardPass& built = state.billboard_passes.back();
                    generate_mipmaps(state, built.atlas, WGPUTextureFormat_RGBA8Unorm,
                                     built.atlas_mip_levels);
                }
            }
            // The scene block each program binds at its group 0: the pass's
            // own, over the matrices the frame draws billboards with.
            const upstream::SceneUniforms& billboard_block = write_billboard_scene_block(
                run.data_.pass_blocks.scene(scene), scene, rows.engine, outcome.pass.camera,
                outcome.pass.matrices.view_projection, outcome.pass.matrices.view);
            for (DawnBillboardPass& billboard : state.billboard_passes) {
                upload_dawn_billboard_pass(state.queue, scene, rows.engine, billboard,
                                           billboard_block, delta_ms);
            }
#endif
        }

        void upload_splats([[maybe_unused]] const SceneSyncOutcome& outcome) {
#if BBLITE_HAS_SPLATS
            Engine& engine = rows.engine;
            DawnState& state = rows.state;
            const Scene& scene = run.data_.scene;
            const CameraPassMatrices& matrices = outcome.pass.matrices;
            const std::uint32_t width = run.data_.width, height = run.data_.height;
            // Lazily built for the same reason the billboard passes are: the
            // clouds are known only once the scene has run. Each update
            // returns on the renderable's own test without a camera -- which
            // tests `scene.camera`, not the pass's -- and the sort then
            // follows the camera with the pin's own epsilon.
            if (state.splat_passes.empty()) {
                for (const SplatMeshHandle splat : scene.splat_meshes) {
                    state.splat_passes.push_back(create_dawn_splat_pass(
                        state.device, state.queue, state.frame_color_format,
                        WGPUTextureFormat_Depth24PlusStencil8, state.sample_count, engine, splat));
                }
            }
            const CameraRecord* const camera = scene_camera(engine, scene);
            for (DawnSplatPass& splat : state.splat_passes) {
                upload_dawn_splat_pass(state.queue, engine, splat, camera, matrices.view,
                                       matrices.projection, matrices.camera_position,
                                       static_cast<float>(width), static_cast<float>(height));
            }
#endif
        }

        void capture_render_state() {
#if !BBLITE_HAS_TAA && !BBLITE_HAS_TEXT
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
            if (!rows.state.node_capture.capture.enabled())
#endif
                run.capture_render_state();
#endif
        }

        void write_pass_blocks(const SceneSyncOutcome& outcome) { run.write_pass_blocks(outcome); }
    };

    /**
     * The frame's buffered pass blocks, before anything reads them: WebGPU
     * has no push constants, so every block a pass binds is a queue write
     * here. Each scene block is the one its pass retains
     * (`pal::write_pass_scene_block`), which a pass without a camera leaves
     * as the pin's `_writePassSceneUBO` leaves it.
     */
    void write_pass_blocks(const SceneSyncOutcome& outcome) {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& scene = data_.scene;
        [[maybe_unused]] auto& state = data_.state;
        [[maybe_unused]] auto& width = data_.width;
        [[maybe_unused]] auto& height = data_.height;
        [[maybe_unused]] auto& render_plan = data_.render_plan;
        [[maybe_unused]] auto& overlay_plans = data_.overlay_plans;
        [[maybe_unused]] const CameraRecord* const camera = outcome.pass.camera;
        [[maybe_unused]] const auto& matrix = outcome.pass.matrices.view_projection;
        [[maybe_unused]] auto& frame_pass_matrices = current_frame().frame_pass_matrices;
        [[maybe_unused]] auto& pass_scene = current_frame().pass_scene;
        [[maybe_unused]] auto& pass_meshes = current_frame().pass_meshes;
#if BBLITE_NODE_VARIANTS > 0
        [[maybe_unused]] auto& node_mesh_blocks = current_frame().node_mesh_blocks;
#endif
        wgpuQueueWriteBuffer(state.queue, state.view_projection, 0, matrix.data(), sizeof(matrix));
#if BBLITE_PINNED_MATERIALS
        // The pin's per-pass blocks, before anything reads them: the scene block
        // the variants' vertex and fragment stages share, and the lights array
        // their multi-light arm indexes.
        write_pinned_frame_blocks(
            state, scene, engine,
            write_pass_scene_block(data_.pass_blocks.scene(scene), scene, engine, camera, matrix));
        // Each overlay layer's own scene and lights blocks, written into
        // its own buffers. A queue write lands before the whole command
        // buffer runs, so the base scene's blocks cannot simply be
        // rewritten between the two passes.
        for (std::size_t layer = 0;
             layer < overlay_plans.size() && layer < state.overlay_frames.size(); ++layer) {
            Scene* overlay_scene = engine.scenes()[layer + 1u].get();
            if (!overlay_scene)
                continue;
            DawnState::OverlayFrame& overlay = state.overlay_frames[layer];
            overlay_frame_group(state, overlay);
            // The layer's own scene pass, projected at its own extent's
            // aspect: two scenes splitting one target by viewport project
            // at two ratios.
            const PixelViewport overlay_surface_extent =
                scene_surface_extent(engine, *overlay_scene, width, height);
            const PassCamera overlay_pass = build_kept_pass_camera(
                *overlay_scene, engine, scene_pass_camera(engine, *overlay_scene),
                overlay_surface_extent.width, overlay_surface_extent.height,
                data_.pass_blocks.scene(*overlay_scene));
            const upstream::SceneUniforms& overlay_scene_block = write_pass_scene_block(
                data_.pass_blocks.scene(*overlay_scene), *overlay_scene, engine, overlay_pass);
            wgpuQueueWriteBuffer(state.queue, overlay.scene_uniforms, 0, &overlay_scene_block,
                                 sizeof(overlay_scene_block));
            const std::vector<std::uint8_t> overlay_lights =
                pinned_lights_block(*overlay_scene, engine);
            wgpuQueueWriteBuffer(state.queue, overlay.lights_uniforms, 0, overlay_lights.data(),
                                 overlay_lights.size());
        }
#if BBLITE_SHADOW_RECEIVERS
        // The shadow generators' matrices and their receiver blocks, before
        // the caster pass reads the first and the receiving draws read the
        // second.
        for (const auto& registered_scene : engine.scenes()) {
            write_shadow_generators(state, *registered_scene, engine);
        }
#endif
#endif
        // Sampled render targets must exist before material bind groups are built.
        if (!engine.render_targets.empty()) {
#if BBLITE_HAS_TAA
            if (!engine.stopped)
                create_frame_graph_textures(state, engine, width, height);
#else
            create_frame_graph_textures(state, engine, width, height);
#endif
        }
        // CSM receiver subscriptions can update ShaderMaterial storage after
        // the frame's publication. Publish their latest bytes before any
        // caster or colour pass builds and binds the reflected groups.
        sync_shader_storage_buffers(state, engine);
        // The pass's own matrices travel with the list: a render task
        // renders through its own camera and target aspect, and a shadow
        // caster pass through the generator's light-space matrix, so a
        // shader material's system block reads what its pass renders with
        // rather than the frame's.
        //
        // `pass_dependent_only` is how a cascade after the first renders:
        // only the shader arm below reads `pass_matrices`, so the
        // rest would rewrite the same buffers with the same bytes once per
        // cascade -- 2,412 redundant queue writes per frame on scene 214,
        // whose 201 casters draw four times. SDL_GPU's palette sweep
        // already dedupes its own half this way.
        // Which scene the pass being written and recorded belongs to, and
        // the meshes uploaded for it. The base scene goes first; a
        // swapchain overlay layer repoints these before its own write and
        // its own pass, because the walk is the same one and only the
        // scene it reads its light selection and its uploaded meshes from
        // changes.
        // Every reader is a material-variant draw, so a build that
        // composes no variants at all -- a splat-only scene, say -- sets
        // this and never reads it.
        pass_scene = &scene;
        pass_meshes = &state.meshes;

#if !BBLITE_HAS_TAA
        write_material_uniforms(render_plan.draw_lists.opaque, frame_pass_matrices);
        write_material_uniforms(render_plan.draw_lists.transparent, frame_pass_matrices);
        // The same write phase for each swapchain overlay layer, over the
        // layer's own draw lists and its own uploaded meshes.
        for (std::size_t layer = 0;
             layer < overlay_plans.size() && layer < state.overlay_meshes.size(); ++layer) {
            Scene* overlay_scene = engine.scenes()[layer + 1u].get();
            if (!overlay_scene)
                continue;
            // The layer's own effective aspect: a viewport is the camera's,
            // not the target's.
            const PixelViewport overlay_surface_extent =
                scene_surface_extent(engine, *overlay_scene, width, height);
            const PassCamera overlay_pass = build_kept_pass_camera(
                *overlay_scene, engine, scene_pass_camera(engine, *overlay_scene),
                overlay_surface_extent.width, overlay_surface_extent.height,
                data_.pass_blocks.scene(*overlay_scene));
            const ShaderPassMatrices overlay_pass_matrices = overlay_pass.pass();
            pass_scene = overlay_scene;
            pass_meshes = &state.overlay_meshes[layer];
            write_material_uniforms(overlay_plans[layer].draw_lists.opaque, overlay_pass_matrices);
            write_material_uniforms(overlay_plans[layer].draw_lists.transparent,
                                    overlay_pass_matrices);
            pass_scene = &scene;
            pass_meshes = &state.meshes;
        }
#endif
        if (!scene.tasks.empty()) {
#if !BBLITE_HAS_TAA
#if BBLITE_SHADOW_RECEIVERS
            // Which generators have had their casters' pass-independent
            // blocks written this frame. A cascaded generator renders one
            // task per cascade and every one of them carries the SAME
            // casters -- `refresh_shadow_task_meshes` adds each caster to
            // every task through the same view -- so the first cascade
            // writes the blocks and the rest name only their own matrices.
            std::vector<bool> wrote_caster_blocks(engine.shadow_generators.size(), false);
#endif
            for (std::size_t graph_layer = 0; graph_layer < engine.scenes().size(); ++graph_layer) {
                const Scene& graph_scene = *engine.scenes()[graph_layer];
                const auto graph_extent = scene_surface_extent(engine, graph_scene, width, height);
                // A geometry task renders through its scene's camera.
                const PassCamera geometry_pass = build_pass_camera(
                    graph_scene, engine, geometry_pass_camera(engine, graph_scene),
                    graph_extent.width, graph_extent.height);
                pass_scene = &graph_scene;
                pass_meshes =
                    graph_layer == 0 ? &state.meshes : &state.overlay_meshes[graph_layer - 1];
                [[maybe_unused]] WGPUBuffer graph_lights = nullptr;
#if BBLITE_PINNED_MATERIALS
                if (graph_layer > 0)
                    graph_lights = state.overlay_frames[graph_layer - 1].lights_uniforms;
#endif
                for (const TaskHandle handle : graph_scene.tasks) {
                    const FrameTaskRecord& task = handle_at(engine.frame_tasks, handle);
                    if (task.kind == FrameTaskKind::geometry) {
                        // Without a camera the task does not execute.
                        if (upstream::geometry_task_skips(geometry_pass.camera))
                            continue;
                        upstream::sort_transparent_draws(
                            handle_at(state.render_tasks, handle).draw_lists.transparent, engine,
                            geometry_pass.camera);
#if BBLITE_GEOMETRY_TASK_FAMILIES
                        // The task's own frame state, written once and before
                        // any family: its scene block, its gpUniforms buffer and
                        // the previous-view-projection it tracks are properties
                        // of the TASK, so which families the scene composed
                        // decides only whether it is written at all.
                        if (pinned_lists_have_pinned_draws(
                                handle_at(state.render_tasks, handle).draw_lists)) {
                            write_pinned_geometry_prologue(state, graph_scene, engine,
                                                           *geometry_pass.camera,
                                                           handle_at(state.geometry_tasks, handle),
                                                           geometry_pass.matrices.view_projection);
                        }
#endif
#if BBLITE_PBR_VARIANTS > 0
                        // A task whose draws are PBR writes its blocks here:
                        // each draw's mesh and material blocks against the MRT
                        // variant the selector table keys on this task.
                        write_pinned_geometry_task(
                            state, graph_scene, engine, task,
                            handle_at(state.geometry_tasks, handle),
                            handle_at(state.render_tasks, handle).draw_lists);
#endif
#if BBLITE_STANDARD_VARIANTS > 0
                        update_pinned_velocity_frame(
                            handle_at(state.geometry_tasks, handle).velocity, graph_scene, engine,
                            (graph_layer == 0 ? render_plan : overlay_plans[graph_layer - 1])
                                .items);
                        write_standard_geometry_task(
                            state, graph_scene, engine, task,
                            handle_at(state.geometry_tasks, handle),
                            handle_at(state.render_tasks, handle).draw_lists);
#endif
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
                        // The node family's own MRT arm, third and last: the
                        // view composed for this task, its mesh block and the
                        // group carrying the task's gpUniforms.
                        write_node_geometry_task(state, node_mesh_blocks, graph_scene, engine, task,
                                                 handle_at(state.geometry_tasks, handle),
                                                 handle_at(state.render_tasks, handle).draw_lists);
#endif
                        continue;
                    }
                    if (task.kind != FrameTaskKind::render)
                        continue;
                    DawnRenderTask& render_task = handle_at(state.render_tasks, handle);
                    const RenderTargetRecord& target_record =
                        handle_at(engine.render_targets, task.render.target);
                    const DawnRenderTarget& target =
                        handle_at(state.render_targets, task.render.target);
                    CameraRecord* const task_camera = task_pass_camera(engine, task);
                    // `_writePassSceneUBO` folds the camera's own viewport into
                    // whichever extent the task was configured for -- the
                    // canvas or the target.
                    const bool canvas_extent = task.render.canvas_size;
                    CameraPassMatrices task_camera_pass = camera_pass_matrices(
                        graph_scene, engine, task_camera,
                        canvas_extent ? graph_extent.width : static_cast<double>(target.width),
                        canvas_extent ? graph_extent.height : static_cast<double>(target.height));
                    keep_view_projection(task_camera_pass, task_camera,
                                         data_.pass_blocks.task(handle));
                    // A shadow task renders from the light, not from a
                    // camera: the generator's own matrices replace the product
                    // below, which stays the zero matrix and is never uploaded.
                    const bool shadow_task = task.render.shadow_generator.value != invalid_handle;
                    if (shadow_task)
                        task_camera_pass.view_projection = {};
                    const std::array<float, 16>& task_matrix = task_camera_pass.view_projection;
                    const ShaderPassMatrices task_pass_matrices = task_camera_pass.pass();
                    // The port's own view-projection lane carries the pass's
                    // matrix, as the frame's and the SDL_GPU push do.
                    if (!shadow_task) {
                        wgpuQueueWriteBuffer(state.queue, render_task.view_projection, 0,
                                             task_matrix.data(), 64);
                    }
#if BBLITE_SHADOW_RECEIVERS
                    // A shadow caster pass renders from the light. The pin gives
                    // it a camera facade whose view and view-projection caches it
                    // pins to the light-space matrices; there is no facade here,
                    // so the pass block is written from the generator directly --
                    // the BIASED view-projection, which is the one
                    // `updateShadowCameraBase` receives.
                    if (task.render.shadow_generator.value < engine.shadow_generators.size() &&
                        // A gated frame runs no caster pass, so nothing reads
                        // these blocks — and the generator's matrices they are
                        // written from are unchanged anyway. The pin's skipped
                        // `render*ShadowMap` writes nothing either.
                        state.shadow_refresh.gates[task.render.shadow_generator.value].due) {
                        const pal::ShadowCasterMatrices caster =
                            pal::shadow_caster_matrices(engine, task);
                        const std::array<float, 16>& caster_view_projection =
                            caster.view_projection;
                        const std::array<float, 16>& caster_view = caster.view;
                        if (!task_camera) {
                            throw std::runtime_error(
                                "A shadow caster pass fills its scene block's camera lanes from "
                                "the scene's active camera; a scene without one is not reached.");
                        }
                        upstream::SceneUniforms shadow_block = pinned_scene_block(
                            graph_scene, engine, *task_camera, caster_view_projection);
                        shadow_block.view = caster_view;
                        task_pinned_frame_group(state, render_task, graph_lights);
                        wgpuQueueWriteBuffer(state.queue, render_task.pinned_scene_uniforms, 0,
                                             &shadow_block, sizeof(shadow_block));
                        wgpuQueueWriteBuffer(state.queue, render_task.view_projection, 0,
                                             caster_view_projection.data(), 64);
                        ShaderPassMatrices caster_pass_matrices{caster_view_projection.data(),
                                                                &caster_view, nullptr};
                        caster_pass_matrices.camera_position = &task_camera_pass.camera_position;
                        const std::size_t generator_index = task.render.shadow_generator.value;
                        const bool later_cascade = generator_index < wrote_caster_blocks.size() &&
                                                   wrote_caster_blocks[generator_index];
                        if (generator_index < wrote_caster_blocks.size()) {
                            wrote_caster_blocks[generator_index] = true;
                        }
                        write_material_uniforms(render_task.draw_lists.opaque, caster_pass_matrices,
                                                later_cascade);
                        write_material_uniforms(render_task.draw_lists.transparent,
                                                caster_pass_matrices, later_cascade);
                    }
#endif
#if BBLITE_HAS_BILLBOARDS
                    // The billboards a scene-stage task draws bind the task's own
                    // pass block, as the pin binds each task's scene group: the
                    // task's camera and matrices, as the SDL_GPU twin pushes.
                    if (task.render.scene_stages && target_record.has_color && !shadow_task) {
                        const upstream::SceneUniforms& billboard_block =
                            write_billboard_scene_block(data_.pass_blocks.task(handle), graph_scene,
                                                        engine, task_camera, task_matrix,
                                                        task_camera_pass.view);
                        for (DawnBillboardPass& billboard : state.billboard_passes) {
                            write_dawn_billboard_task_scene(state.device, state.queue, billboard,
                                                            handle.value, billboard_block);
                        }
                    }
#endif
#if BBLITE_PINNED_MATERIALS
                    // A colour task that is not a caster pass reads its OWN
                    // pass block, which is the rule the SDL_GPU backend states
                    // as `if (!shadow_task)` around its own push. The matrix
                    // is built from the task's aspect, which comes from the
                    // task's target (scene 187 renders into half the canvas
                    // width). A caster pass writes none: its `task_matrix` is
                    // the zero matrix, and a written block would hand every
                    // receiver zeros.
                    if (target_record.has_color && !shadow_task) {
                        // The task's own pass block, in the pin's own shape: the
                        // frame's writer over the task's camera and matrix, kept
                        // as it was by a camera-less task.
                        const upstream::SceneUniforms& task_scene_block =
                            write_pass_scene_block(data_.pass_blocks.task(handle), graph_scene,
                                                   engine, task_camera, task_matrix);
                        task_pinned_frame_group(state, render_task, graph_lights);
                        wgpuQueueWriteBuffer(state.queue, render_task.pinned_scene_uniforms, 0,
                                             &task_scene_block, sizeof(task_scene_block));
                    }
#endif
                    // A colour task's own draws, prepared under its own
                    // camera. Both halves are skipped for a depth-only task
                    // and each for its own reason, so neither is riding the
                    // other's test: it encodes through
                    // `depth_only_pipeline_for`, which reads none of the
                    // blocks or groups these writes build; and its draws write
                    // depth without blending, so back-to-front order changes
                    // nothing to sort for. The SDL backend sorts in exactly
                    // its colour and geometry task arms for the same reasons.
                    if (target_record.has_color) {
                        upstream::sort_transparent_draws(render_task.draw_lists.transparent, engine,
                                                         task_camera);
                        write_material_uniforms(render_task.draw_lists.opaque, task_pass_matrices);
                        write_material_uniforms(render_task.draw_lists.transparent,
                                                task_pass_matrices);
                    }
                }
            }
            pass_scene = &scene;
            pass_meshes = &state.meshes;
#endif
        }
    }

    void synchronize() {
        State& data = data_;
        Frame& frame = current_frame();
        SceneSync hooks{*this, MeshRowWrites{data.state, data.engine}};
        SceneSyncState<DawnMesh> sync{data.engine,
                                      data.scene,
                                      data.frame,
                                      frame.delta_ms,
                                      data.width,
                                      data.height,
                                      data.render_plan,
                                      data.overlay_plans,
                                      data.overlay_topology_versions,
                                      data.state.meshes,
                                      data.state.overlay_meshes,
                                      data.synced_render_topology_version,
                                      data.synced_draw_list_epoch,
                                      data.synced_material_family_mask,
                                      data.camera_trace_state,
                                      data.pass_blocks};
        static_cast<void>(synchronize_scene(sync, hooks));
        frame.written = data.cpu_profile ? monotonic_milliseconds() : 0.0;
    }

    bool acquire() {
        [[maybe_unused]] auto& cpu_profile = data_.cpu_profile;
        [[maybe_unused]] auto& state = data_.state;
        [[maybe_unused]] auto& acquired = current_frame().acquired;
        [[maybe_unused]] auto& surface_texture = current_frame().surface_texture;
        [[maybe_unused]] auto& surface = current_frame().surface;
        [[maybe_unused]] auto& surface_view = current_frame().surface_view;
#if BBLITE_OFFSCREEN_SURFACES
        [[maybe_unused]] auto& offscreen_image = current_frame().offscreen_image;
#endif
#if BBLITE_OFFSCREEN_SURFACES
        if (offscreen_image) {
            surface_texture = WGPU_SURFACE_TEXTURE_INIT;
            surface_texture.texture = offscreen_image->texture;
            wgpuTextureAddRef(surface_texture.texture);
            surface = surface_texture.texture;
        } else {
#endif
            if (!acquire_dawn_surface_texture(state, surface_texture))
                return false;
            surface = surface_texture.texture;
#if BBLITE_OFFSCREEN_SURFACES
        }
#endif
        surface_view = create_dawn_texture_view(surface_texture.texture, nullptr);
        acquired = cpu_profile ? monotonic_milliseconds() : 0.0;

        return true;
    }

    void encode() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& frame_options = data_.frame_options;
        [[maybe_unused]] auto& scene = data_.scene;
        [[maybe_unused]] auto& state = data_.state;
        [[maybe_unused]] auto& width = data_.width;
        [[maybe_unused]] auto& height = data_.height;
        [[maybe_unused]] auto& render_plan = data_.render_plan;
        [[maybe_unused]] auto& overlay_plans = data_.overlay_plans;
        [[maybe_unused]] auto& overlay_topology_versions = data_.overlay_topology_versions;
        // The scene's own pass camera, the one the frame's matrices were
        // settled from.
        const CameraRecord* const camera = scene_pass_camera(engine, scene);
        [[maybe_unused]] auto& pass_scene = current_frame().pass_scene;
        [[maybe_unused]] auto& pass_meshes = current_frame().pass_meshes;
        [[maybe_unused]] auto& surface_texture = current_frame().surface_texture;
        [[maybe_unused]] auto& surface_view = current_frame().surface_view;
        [[maybe_unused]] auto& encoder = current_frame().encoder;
        [[maybe_unused]] auto& capture_source = current_frame().capture_source;
        [[maybe_unused]] auto& frame_graph_presented = current_frame().frame_graph_presented;
        encoder = wgpuDeviceCreateCommandEncoder(state.device, nullptr);
#if BBLITE_COMPUTE_FRAME_GRAPH
        DawnCommandEncoder surface_encoder;
        if (compute_frame_prefix_deferred(engine)) {
            surface_encoder = std::move(encoder);
            encoder = wgpuDeviceCreateCommandEncoder(state.device, nullptr);
        }
#endif
        capture_source = surface_texture.texture;
        // Meaningful only under the frame-graph arm, where the default
        // above is a never-rendered surface: set by the same two arms
        // that name the SDL backend's capture source -- the
        // copy-to-swapchain blit and the post-process present -- so a
        // graph that presents through neither refuses capture below
        // instead of reading the raw surface back.
        frame_graph_presented = false;
        const auto draw_list_into = [&](WGPURenderPassEncoder list_pass,
                                        const upstream::RenderDrawList& list, std::uint32_t samples,
                                        WGPURenderPipeline& bound_pipeline,
                                        bool pass_has_depth = true,
                                        // Which per-pass block the composed
                                        // stages read: the frame's, or a
                                        // task's own when it draws through
                                        // its own camera.
                                        WGPUBindGroup frame_group = nullptr,
                                        // A shadow caster pass renders
                                        // standard-Z into the generator's
                                        // own depth32float map, which is
                                        // the pin's one exception to this
                                        // port's depth convention.
                                        bool shadow_pass = false,
                                        // Which ESM generator's map it
                                        // writes, when it writes one.
                                        std::uint32_t esm_shadow_index = invalid_handle,
                                        // ShaderMaterial's group-1 pass
                                        // block. Tasks own one so cascades
                                        // do not all read the frame camera.
                                        WGPUBuffer shader_pass_uniforms = nullptr,
                                        std::optional<DawnTaskTarget> target = {}) {
            (void)frame_group;
            (void)shadow_pass;
            (void)esm_shadow_index;
            for (const upstream::RenderDrawCommand& draw : list.commands) {
                if (!upstream::render_item_draws_now(draw.item, engine))
                    continue;
                if (draw.item_index >= (*pass_meshes).size())
                    continue;
                DawnMesh& mesh = (*pass_meshes)[draw.item_index];
#if BBLITE_PBR_VARIANTS > 0
                // Babylon's own composed stages for this draw. Everything
                // else -- the Standard path, the shader materials, the node
                // graphs -- takes the transcribed pipeline below. Tested by
                // KIND, not by whether a group happens to exist: a mesh
                // drawn once through a PBR material would otherwise keep
                // taking this arm after moving to another family.
                if (draw.item.material_kind == upstream::RenderMaterialKind::pbr) {
                    // The write phase resolves and binds every PBR draw or
                    // errors, so a missing state here means its pinned
                    // bindings were never built for this frame.
                    const auto pinned_entry = mesh.pinned_states.find(draw.item.material.value);
                    if (pinned_entry == mesh.pinned_states.end() || !pinned_entry->second.group) {
                        dawn_error(("PBR draw for mesh " + std::to_string(draw.item.mesh.value) +
                                    ", material " + std::to_string(draw.item.material.value) +
                                    ", pipeline kind " +
                                    std::to_string(static_cast<int>(draw.pipeline)) +
                                    " reached the encode with no pinned "
                                    "bindings.")
                                       .c_str());
                    }
                    const DawnDrawState& pinned_state = pinned_entry->second;
                    const std::size_t variant = pinned_state.group_key;
                    // The thin-instance streams; a non-instanced variant
                    // binds none of them and draws once.
                    const InstanceStreams pinned_streams =
                        instance_streams_for(handle_at(engine.meshes, draw.item.mesh), mesh);
                    encode_variant_draw(
                        list_pass,
                        pinned_variant_pipeline(state, variant, draw.pipeline, samples,
                                                pass_has_depth, nullptr, shadow_pass,
                                                esm_shadow_index, target),
                        bound_pipeline, frame_group ? frame_group : pinned_frame_group(state),
                        pinned_state.group, mesh.vertices, pinned_streams, mesh.indices,
                        mesh.index_count,
                        // The receiver's group 2, under the pin's own test:
                        // `meshShadowLights.length > 0 && bindings._shadowBGL`
                        // -- which is exactly "this variant composed the
                        // shadow fragment".
                        pal::pbr_variant_receives_shadows(variant)
                            ? shadow_group_for(state, *pass_scene, engine,
                                               DawnLayoutFamily::pbr_shadow, variant)
                            : nullptr);
                    continue;
                }
#endif
#if BBLITE_STANDARD_VARIANTS > 0
                if (draw.item.material_kind == upstream::RenderMaterialKind::standard) {
                    // Looked up inside the kind test: every other family's
                    // draws would otherwise pay this descent per frame for
                    // an answer their branch cannot use.
                    const auto standard_entry = mesh.standard_states.find(draw.item.material.value);
                    if (standard_entry == mesh.standard_states.end() ||
                        standard_entry->second.group_key == npos) {
                        dawn_error(("Standard draw for mesh " +
                                    std::to_string(draw.item.mesh.value) +
                                    " reached the encode with no resolved "
                                    "variant.")
                                       .c_str());
                    }
                    DawnDrawState& standard_state = standard_entry->second;
                    const std::size_t variant = standard_state.group_key / 2;
                    if (!standard_state.group) {
                        const MaterialRecord* standard_material =
                            handle_find(engine.materials, draw.item.material);
                        standard_state.group = build_standard_draw_group(
                            state, mesh, standard_material, variant, standard_state.mesh_uniforms,
                            standard_state.material_uniforms, standard_state.uv_uniforms,
                            standard_state.uv_transform_uniforms, nullptr,
                            standard_render_views(state, engine, standard_material));
                    }
                    const InstanceStreams standard_streams =
                        instance_streams_for(handle_at(engine.meshes, draw.item.mesh), mesh);
                    // Only a draw whose composed fragment declares the
                    // shadow group binds it, which is the pin's own test.
                    const bool receives = pal::standard_variant_receives_shadows(variant);
                    encode_variant_draw(
                        list_pass,
                        standard_variant_pipeline(state, variant, draw.pipeline, samples,
                                                  pass_has_depth,
                                                  (standard_state.group_key & 1) != 0, nullptr,
                                                  shadow_pass, esm_shadow_index, target),
                        bound_pipeline, frame_group ? frame_group : pinned_frame_group(state),
                        standard_state.group,
                        // The Standard families carry no glTF X-mirror: the
                        // baked buffer is the pin's own convention already.
                        mesh.vertices, standard_streams, mesh.indices, mesh.index_count,
                        receives ? shadow_group_for(state, *pass_scene, engine,
                                                    DawnLayoutFamily::standard_shadow, variant)
                                 : nullptr);
                    continue;
                }
#endif
#if BBLITE_NODE_VARIANTS > 0
                if (draw.item.material_kind == upstream::RenderMaterialKind::node) {
                    const auto node_entry = mesh.node_states.find(draw.item.material.value);
                    if (node_entry == mesh.node_states.end()) {
                        dawn_error(("node draw for mesh " + std::to_string(draw.item.mesh.value) +
                                    " reached the encode with no draw state.")
                                       .c_str());
                    }
                    const MaterialRecord* node_material =
                        handle_find(engine.materials, draw.item.material);
                    // Which of the graph's two compiled views: an ESM caster
                    // view carries the bit its own factory set.
                    const bool node_caster =
                        node_material && (node_material->esm_shadow || node_material->no_color);
                    DawnDrawState& node_state = node_entry->second;
                    const std::size_t node_slot =
                        pal::node_variant_slot(draw.item.shader_variant, node_caster);
                    // Built here rather than beside the buffers: a receiving
                    // graph names the generators' maps, and those exist only
                    // once the frame graph has been created. A material that
                    // moved to another graph -- or to the other view of its
                    // own -- rebuilds rather than keeping the first one's.
                    if (node_state.group_key != node_slot) {
                        if (node_state.group) {
                            wgpuBindGroupRelease(node_state.group);
                        }
                        node_state.group = build_node_draw_group(
                            state, *pass_scene, engine, mesh, node_state, draw.item.shader_variant,
                            node_caster, node_material);
                        node_state.group_key = node_slot;
                    }
                    encode_node_variant_draw(
                        state, draw, list_pass,
                        node_variant_pipeline(state, draw.item.shader_variant, draw.pipeline,
                                              samples, pass_has_depth, shadow_pass, node_caster,
                                              esm_shadow_index, nullptr,
                                              pal::no_node_geometry_variant, target),
                        bound_pipeline, frame_group ? frame_group : pinned_frame_group(state),
                        node_state.group,
                        // A node graph reads the geometry's local lanes;
                        // its mesh block carries the world.
                        mesh.vertices, InstanceStreams{}, mesh.indices, mesh.index_count);
                    continue;
                }
#endif
                DawnPipeline& pipeline =
                    pipeline_for(state, draw.pipeline, draw.item.shader_variant, samples,
                                 pass_has_depth, shadow_pass, target);
                if (pipeline.pipeline != bound_pipeline) {
                    wgpuRenderPassEncoderSetPipeline(list_pass, pipeline.pipeline);
                    bound_pipeline = pipeline.pipeline;
                }
                // `pipeline_for` builds ShaderMaterial pipelines alone, so
                // the draw binds that family's reflected groups.
                DawnShaderBindings& bindings = shader_bindings_for(
                    state, *pass_scene, engine, mesh, draw.item.material, draw.item.shader_variant,
                    shader_pass_uniforms ? shader_pass_uniforms : state.view_projection);
                if (bindings.storage) {
                    wgpuRenderPassEncoderSetBindGroup(list_pass, 0, bindings.storage, 0, nullptr);
                }
                if (bindings.scene) {
                    wgpuRenderPassEncoderSetBindGroup(list_pass, 1, bindings.scene, 0, nullptr);
                }
                if (bindings.resources) {
                    wgpuRenderPassEncoderSetBindGroup(list_pass, 2, bindings.resources, 0, nullptr);
                }
                if (bindings.material) {
                    wgpuRenderPassEncoderSetBindGroup(list_pass, 3, bindings.material, 0, nullptr);
                }
                wgpuRenderPassEncoderSetVertexBuffer(list_pass, 0, mesh.vertices, 0,
                                                     WGPU_WHOLE_SIZE);
#if BBLITE_GPU_INSTANCING
                wgpuRenderPassEncoderSetVertexBuffer(list_pass, 1, mesh.instances, 0,
                                                     WGPU_WHOLE_SIZE);
#endif
#if BBLITE_GPU_INSTANCE_COLORS
                wgpuRenderPassEncoderSetVertexBuffer(list_pass, 2, mesh.instance_colors, 0,
                                                     WGPU_WHOLE_SIZE);
#endif
                wgpuRenderPassEncoderSetIndexBuffer(list_pass, mesh.indices, WGPUIndexFormat_Uint32,
                                                    0, WGPU_WHOLE_SIZE);
                count_gpu_draw(wgpuRenderPassEncoderDrawIndexed, list_pass, mesh.index_count,
#if BBLITE_GPU_INSTANCING
                               mesh.instance_count,
#else
                               1,
#endif
                               0, 0, 0);
            }
        };
        if (scene.tasks.empty()) {
            const bool transmission = scene.transmission_enabled;
            // The scene's own pass configures no clear colour.
            const Color4 clear_color = scene_pass_clear_color(scene);
            WGPURenderPassColorAttachment color_attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
            color_attachment.view = state.msaa_color_view;
            if (transmission) {
                // The linear frame keeps its multisampled texture for the
                // grab and the per-sample image processing; the clear
                // color inverts the image processing exactly like the
                // SDL backend and the pinned engine. The pin's inverse runs
                // in f64 and WGPUColor carries doubles, so the value reaches
                // Dawn at the width the browser hands its own clear value.
                color_attachment.storeOp = WGPUStoreOp_Store;
                color_attachment.clearValue = WGPUColor{
                    upstream::inverse_image_processed_channel(
                        clear_color.r, scene.environment.exposure, scene.environment.contrast,
                        scene.environment.tone_mapping_enabled),
                    upstream::inverse_image_processed_channel(
                        clear_color.g, scene.environment.exposure, scene.environment.contrast,
                        scene.environment.tone_mapping_enabled),
                    upstream::inverse_image_processed_channel(
                        clear_color.b, scene.environment.exposure, scene.environment.contrast,
                        scene.environment.tone_mapping_enabled),
                    clear_color.a,
                };
            } else if (state.multisampled()) {
                color_attachment.resolveTarget = surface_view;
                // An overlay layer composites onto this pass's multisample
                // texture, so it has to survive the pass -- the pin's own
                // overlay rule: "both scenes must use the base task's MSAA
                // colour texture before the overlay can load its pixels and
                // resolve the composited result" (swapchain-overlay.ts).
                color_attachment.storeOp =
                    overlay_plans.empty() ? WGPUStoreOp_Discard : WGPUStoreOp_Store;
                color_attachment.clearValue = WGPUColor{
                    clear_color.r,
                    clear_color.g,
                    clear_color.b,
                    clear_color.a,
                };
            } else {
                // One sample has nothing to average, so the pass draws
                // into the surface instead of resolving into it.
                color_attachment.view = surface_view;
                color_attachment.storeOp = WGPUStoreOp_Store;
                color_attachment.clearValue = WGPUColor{
                    clear_color.r,
                    clear_color.g,
                    clear_color.b,
                    clear_color.a,
                };
            }
            color_attachment.loadOp = WGPULoadOp_Clear;
            WGPURenderPassDepthStencilAttachment depth_attachment{};
            depth_attachment.view = state.depth_view;
            depth_attachment.depthLoadOp = WGPULoadOp_Clear;
            depth_attachment.depthStoreOp = transmission ? WGPUStoreOp_Store : WGPUStoreOp_Discard;
            depth_attachment.depthClearValue = upstream::pinned_depth_clear;
            depth_attachment.stencilLoadOp = WGPULoadOp_Clear;
            depth_attachment.stencilStoreOp = WGPUStoreOp_Discard;
            WGPURenderPassDescriptor pass_descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
            pass_descriptor.colorAttachmentCount = 1;
            pass_descriptor.colorAttachments = &color_attachment;
            pass_descriptor.depthStencilAttachment = &depth_attachment;
            DawnRenderPass pass{wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor)};
            set_pass_camera_viewport(pass, scene, engine, camera, width, height);
            WGPURenderPipeline bound_pipeline = nullptr;
            bool transmission_copied = false;
            const auto draw_render_list = [&](const upstream::RenderDrawList& list) {
                if (!transmission) {
                    draw_list_into(pass, list, state.sample_count, bound_pipeline);
                    return;
                }
                for (const upstream::RenderDrawCommand& draw : list.commands) {
                    if (!upstream::render_item_draws_now(draw.item, engine))
                        continue;
                    if (draw.item_index >= state.meshes.size()) {
                        continue;
                    }
                    const MaterialRecord* material =
                        handle_find(engine.materials, draw.item.material);
                    if (!transmission_copied && transmissive_draw_material(material)) {
                        // The pinned mid-pass break: grab the scene
                        // color from the preserved multisampled
                        // attachment, then resume loading color and
                        // depth for the transmissive draws.
                        wgpuRenderPassEncoderEnd(pass);
                        pass.reset();
                        encode_transmission_grab(state, encoder);
                        color_attachment.loadOp = WGPULoadOp_Load;
                        depth_attachment.depthLoadOp = WGPULoadOp_Load;
                        pass = wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor);
                        // A restarted pass starts at the whole target
                        // again, so the camera's rectangle is set once
                        // per PASS rather than once per frame.
                        set_pass_camera_viewport(pass, scene, engine, camera, width, height);
                        bound_pipeline = nullptr;
                        transmission_copied = true;
                    }
                    upstream::RenderDrawList single;
                    single.commands.push_back(draw);
                    draw_list_into(pass, single, state.sample_count, bound_pipeline);
                }
            };
#if BBLITE_PINNED_BACKGROUNDS
            // One background arm over the frame's scene group.
            const auto draw_background =
                [&](std::optional<upstream::PinnedBackgroundArmKind> kind) {
                    if (!kind)
                        return;
                    const DawnBackgroundArm& arm = state.background_arm(*kind);
                    draw_dawn_background_arm(pass, arm, pinned_frame_group(state));
                    bound_pipeline = arm.pipeline;
                };
#endif
#if BBLITE_HAS_BILLBOARDS
            // A billboard system draws in the slot its depth mode gives it: 100
            // among the opaque meshes, because a cutout system writes depth and
            // everything after has to see it, and 200 after the scene stages for
            // the transparent modes.
            const auto draw_billboards = [&](BillboardDepthMode mode) {
                for (const DawnBillboardPass& billboard : state.billboard_passes) {
                    if (handle_at(engine.billboard_systems, billboard.system).depth_mode != mode) {
                        continue;
                    }
                    record_dawn_billboard_pass(pass, engine, billboard, billboard.frame_scene);
                }
            };
#endif
            for (const upstream::RenderStage stage : render_plan.stages) {
                switch (stage) {
                case upstream::RenderStage::skybox:
                    // The sub-order comes from the shared
                    // `skybox_stage_order`.
#if BBLITE_PINNED_BACKGROUNDS
                    for (const SkyboxLayer layer : skybox_stage_order)
                        draw_background(state.background_draws.skybox(layer));
#endif
                    break;
                case upstream::RenderStage::opaque:
                    draw_render_list(render_plan.draw_lists.opaque);
#if BBLITE_HAS_SPRITE_RENDERER
                    if (state.has_scene_sprite_pass) {
                        record_dawn_scene_sprite_pass(pass, engine, state.scene_sprite_pass,
                                                      Sprite2DDepthMode::test_write);
                    }
#endif
#if BBLITE_HAS_BILLBOARDS
                    draw_billboards(BillboardDepthMode::cutout);
#endif
                    break;
                case upstream::RenderStage::transparent:
                    draw_render_list(render_plan.draw_lists.transparent);
#if BBLITE_HAS_TEXT
                    state.text->scene.draw(state.text->borrow_pass(pass),
                                           bbl::text_surface(engine));
#endif
#if BBLITE_HAS_SPRITE_RENDERER
                    if (state.has_scene_sprite_pass) {
                        record_dawn_scene_sprite_pass(pass, engine, state.scene_sprite_pass,
                                                      Sprite2DDepthMode::test);
                    }
#endif
#if BBLITE_HAS_SPLATS
                    // `isTransparent: true` on the pinned renderable, so a
                    // cloud belongs to this bucket rather than after it.
                    // `27-render-pipeline.md` states the bucket's rule:
                    // "Transparent bindings must remain camera-space-depth
                    // sorted and are not pipeline-sorted." A cloud carries
                    // no single depth to sort by -- it sorts its own splats
                    // -- and no reached scene puts another transparent
                    // renderable beside one, so it draws at the end of the
                    // bucket and a scene that mixed the two would need the
                    // pin's own `_sortDistance` before this is right.
                    for (const DawnSplatPass& splat : state.splat_passes) {
                        record_dawn_splat_pass(pass, splat);
                    }
#endif
                    break;
                case upstream::RenderStage::ground:
#if BBLITE_PINNED_BACKGROUNDS
                    draw_background(state.background_draws.ground);
#endif
                    break;
                }
            }
#if BBLITE_HAS_BILLBOARDS
            // The transparent systems close the scene's pass: they blend over
            // every stage above and test against the depth they wrote.
            draw_billboards(BillboardDepthMode::transparent);
#endif
            wgpuRenderPassEncoderEnd(pass);
            pass.reset();
            // The swapchain overlay layers: one pass each on the same colour
            // attachment with a FRESH depth buffer. `createUtilityLayer`
            // states the contract -- the overlay keeps NORMAL depth testing
            // among its own meshes and never tests against the base scene's,
            // so a gizmo body still occludes its own back faces while sitting
            // in front of everything below it.
            for (std::size_t layer = 0;
                 layer < overlay_plans.size() && layer < state.overlay_meshes.size(); ++layer) {
                Scene* overlay_scene = engine.scenes()[layer + 1u].get();
                if (!overlay_scene)
                    continue;
                if (layer < overlay_topology_versions.size() &&
                    overlay_scene->render_topology_version != overlay_topology_versions[layer]) {
                    dawn_error(
                        "A swapchain overlay changed its renderables after resource synchronization.");
                }
                WGPURenderPassColorAttachment overlay_color =
                    WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
                overlay_color.view = color_attachment.view;
                overlay_color.resolveTarget = color_attachment.resolveTarget;
                overlay_color.loadOp = WGPULoadOp_Load;
                overlay_color.storeOp = color_attachment.storeOp;
                WGPURenderPassDepthStencilAttachment overlay_depth{};
                overlay_depth.view = state.depth_view;
                overlay_depth.depthLoadOp = WGPULoadOp_Clear;
                overlay_depth.depthStoreOp = WGPUStoreOp_Discard;
                overlay_depth.depthClearValue = upstream::pinned_depth_clear;
                overlay_depth.stencilLoadOp = WGPULoadOp_Clear;
                overlay_depth.stencilStoreOp = WGPUStoreOp_Discard;
                WGPURenderPassDescriptor overlay_descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
                overlay_descriptor.colorAttachmentCount = 1;
                overlay_descriptor.colorAttachments = &overlay_color;
                overlay_descriptor.depthStencilAttachment = &overlay_depth;
                DawnRenderPass overlay_pass{
                    wgpuCommandEncoderBeginRenderPass(encoder, &overlay_descriptor)};
                // The layer's own scene pass camera, with no fallback to the
                // base scene's.
                set_pass_camera_viewport(overlay_pass, *overlay_scene, engine,
                                         scene_pass_camera(engine, *overlay_scene), width, height);
                WGPURenderPipeline overlay_bound_pipeline = nullptr;
                pass_scene = overlay_scene;
                pass_meshes = &state.overlay_meshes[layer];
                WGPUBindGroup overlay_group = nullptr;
                WGPUBuffer overlay_shader_uniforms = state.view_projection;
#if BBLITE_PINNED_MATERIALS
                if (layer < state.overlay_frames.size()) {
                    overlay_group = overlay_frame_group(state, state.overlay_frames[layer]);
                    overlay_shader_uniforms = state.overlay_frames[layer].scene_uniforms;
                }
#endif
                for (const upstream::RenderStage stage : overlay_plans[layer].stages) {
                    switch (stage) {
                    case upstream::RenderStage::opaque:
                        draw_list_into(overlay_pass, overlay_plans[layer].draw_lists.opaque,
                                       state.sample_count, overlay_bound_pipeline, true,
                                       overlay_group, false, invalid_handle,
                                       overlay_shader_uniforms);
                        break;
                    case upstream::RenderStage::transparent:
                        draw_list_into(overlay_pass, overlay_plans[layer].draw_lists.transparent,
                                       state.sample_count, overlay_bound_pipeline, true,
                                       overlay_group, false, invalid_handle,
                                       overlay_shader_uniforms);
                        break;
                    default:
                        // A utility layer carries no environment, so its
                        // plan reaches no background stage.
                        break;
                    }
                }
                wgpuRenderPassEncoderEnd(overlay_pass);
                overlay_pass.reset();
                pass_scene = &scene;
                pass_meshes = &state.meshes;
            }
            if (transmission) {
                encode_image_processing(state, encoder, surface_view, scene);
            }
        } else {
            // Frame-graph execution replaces the main pass entirely,
            // mirroring the SDL task loop.
            const auto render_target_texture = [&](RenderTargetHandle target_handle) {
                return dawn_render_target_texture(state, engine, target_handle);
            };
            /** The depth view a reference names, or null when it names none. */
            const auto task_depth_view = [&](const RenderTextureRef& reference) -> WGPUTextureView {
                if (reference.source != RenderTextureSource::geometry_depth ||
                    reference.task.value >= engine.frame_tasks.size() ||
                    reference.task.value >= state.geometry_tasks.size()) {
                    throw std::runtime_error("Render task depth must name a geometry task.");
                }
                WGPUTextureView view = handle_at(state.geometry_tasks, reference.task).depth_view;
                if (!view) {
                    throw std::runtime_error("Geometry task has no depth attachment to share.");
                }
                return view;
            };
            const auto source_texture_view =
                [&](const RenderTextureRef& reference) -> std::pair<WGPUTexture, WGPUTextureView> {
                if (reference.source == RenderTextureSource::render_target) {
                    return dawn_render_target_texture(state, engine, reference.target,
                                                      reference.depth_only);
                }
                const FrameTaskRecord& source_task = handle_at(engine.frame_tasks, reference.task);
                if (source_task.kind != FrameTaskKind::geometry) {
                    throw std::runtime_error("Frame graph source task is not geometry.");
                }
                if (reference.source == RenderTextureSource::geometry_output) {
                    return render_target_texture(source_task.geometry.target);
                }
                const auto found =
                    std::find_if(source_task.geometry.attachments.begin(),
                                 source_task.geometry.attachments.end(),
                                 [&](const GeometryTextureDescription& description) {
                                     return description.type == reference.geometry_type;
                                 });
                if (found == source_task.geometry.attachments.end()) {
                    throw std::runtime_error("Geometry source attachment was not requested.");
                }
                const std::size_t attachment_index = static_cast<std::size_t>(
                    std::distance(source_task.geometry.attachments.begin(), found));
                DawnGeometryTask& geometry = handle_at(state.geometry_tasks, reference.task);
                return {
                    geometry.sampled_colors[attachment_index],
                    geometry.sampled_views[attachment_index],
                };
            };
#if BBLITE_HAS_TAA
            if (!engine.stopped) {
                for (const auto& registered : engine.scenes()) {
                    for (const TaskHandle handle : registered->tasks) {
                        auto& task = handle_at(engine.frame_tasks, handle);
                        if (!task.post_process.taa)
                            continue;
                        auto& first = state.post_process_tasks.at(handle.value).at(0);
                        if (first.temporal_recorded)
                            continue;
                        upstream::record_taa_post_process(*task.post_process.taa, [&] {
                            for (std::size_t child = 0; child < task.post_process.passes.size();
                                 ++child) {
                                (void)prepare_dawn_post_process_pass(state, engine, handle, width,
                                                                     height, child,
                                                                     source_texture_view);
                            }
                        });
                        first.temporal_recorded = true;
                    }
                }
#endif
                for (std::size_t graph_layer = 0; graph_layer < engine.scenes().size();
                     ++graph_layer) {
                    const Scene& graph_scene = *engine.scenes()[graph_layer];
                    const auto& graph_plan =
                        graph_layer == 0 ? render_plan : overlay_plans[graph_layer - 1];
                    auto& graph_meshes =
                        graph_layer == 0 ? state.meshes : state.overlay_meshes[graph_layer - 1];
                    pass_scene = &graph_scene;
                    pass_meshes = &graph_meshes;
#if BBLITE_GPU_TASK_TIMING
                    GpuTaskTimingSequence timing_sequence(
                        engine,
                        [&](const auto& write) { encode_dawn_gpu_timestamp(encoder, write); },
                        &graph_scene);
#endif
                    for (const TaskHandle handle : graph_scene.tasks) {
                        FrameTaskRecord& task = handle_at(engine.frame_tasks, handle);
                        if (task.execution_enabled == false)
                            continue;
#if BBLITE_GPU_TASK_TIMING
                        const auto timing_scope = timing_sequence.scoped_task(engine, handle);
#endif
#if BBLITE_COMPUTE_FRAME_GRAPH
                        if (task.kind == FrameTaskKind::compute) {
                            if (surface_encoder) {
                                DawnCommandBuffer shadows{
                                    wgpuCommandEncoderFinish(encoder, nullptr)};
                                submit_dawn_command(state.queue, shadows);
                                encoder = std::exchange(surface_encoder, {});
                                begin_compute_frame_prefix(engine, true);
                            }
                            continue;
                        }
#endif
#if BBLITE_HAS_TAA
                        if (task.kind != FrameTaskKind::render &&
                            task.kind != FrameTaskKind::post_process) {
                            throw std::runtime_error(
                                "Temporal submission requires an admitted frame-task execution adapter.");
                        }
#endif
                        if (task.kind == FrameTaskKind::render) {
                            const RenderTargetRecord& target_record =
                                handle_at(engine.render_targets, task.render.target);
                            DawnRenderTarget& target =
                                handle_at(state.render_targets, task.render.target);
                            DawnRenderTask& render_task = handle_at(state.render_tasks, handle);
                            const std::uint32_t samples =
                                target_record.swapchain
                                    ? 1u
                                    : task_sample_count(state, target_record.samples);
                            // The camera the task's pass renders through: its
                            // viewport narrows the pass (`executePassBody`).
                            CameraRecord* const pass_camera = task_pass_camera(engine, task);
#if BBLITE_HAS_TAA
                            if (task.source_scene != graph_scene.state ||
                                task.render.scene_stages ||
                                task.render.shadow_generator.value != invalid_handle ||
                                !target.color || target.color_format != state.surface_format) {
                                throw std::runtime_error(
                                    "Temporal source requires an admitted Standard color pass in its owning scene.");
                            }
                            // `validate_temporal_source` refuses a task
                            // without a camera.
                            CameraRecord* const source_camera = pass_camera;
                            validate_temporal_source(engine, task, source_camera,
                                                     render_task.draw_lists);
                            const CameraRecord& task_camera = *source_camera;
                            const auto graph_extent =
                                scene_surface_extent(engine, graph_scene, width, height);
                            restore_temporal_source_buffer(state, task, render_task);
                            WGPUBuffer lights =
                                graph_layer == 0
                                    ? nullptr
                                    : state.overlay_frames[graph_layer - 1].lights_uniforms;
                            task_pinned_frame_group(state, render_task, lights);
                            prepare_temporal_scene_uniforms(
                                task, source_camera, target.width, target.height,
                                graph_extent.width, graph_extent.height,
                                [&](const float* data, std::size_t bytes) {
                                    wgpuQueueWriteBuffer(state.queue,
                                                         render_task.pinned_scene_uniforms, 0, data,
                                                         bytes);
                                });
                            const bool canvas_extent = task.render.canvas_size;
                            const CameraPassMatrices task_camera_pass = camera_pass_matrices(
                                graph_scene, engine, &task_camera,
                                canvas_extent ? graph_extent.width
                                              : static_cast<double>(target.width),
                                canvas_extent ? graph_extent.height
                                              : static_cast<double>(target.height));
                            const ShaderPassMatrices matrices = task_camera_pass.pass();
                            wgpuQueueWriteBuffer(state.queue, render_task.view_projection, 0,
                                                 task_camera_pass.view_projection.data(),
                                                 sizeof(task_camera_pass.view_projection));
                            write_material_uniforms(render_task.draw_lists.opaque, matrices);
                            write_material_uniforms(render_task.draw_lists.transparent, matrices);
                            upstream::sort_transparent_draws(render_task.draw_lists.transparent,
                                                             engine, source_camera);
#endif
#if BBLITE_SHADOW_RECEIVERS
                            if (task.render.shadow_generator.value <
                                engine.shadow_generators.size()) {
                                // The pin's render gate: `renderEsmShadowMap` /
                                // `renderPcfShadowMap` return before the caster pass
                                // and both blur passes when nothing moved since the
                                // last render, and the map textures persist — the
                                // receiver keeps sampling last render's bit-identical
                                // content. The verdict was written onto the gate by
                                // `refresh_shadow_generators` earlier this frame.
                                if (!state.shadow_refresh.gates[task.render.shadow_generator.value]
                                         .due) {
                                    continue;
                                }
                                if (!target_record.has_depth || !target.depth) {
                                    throw std::runtime_error(
                                        "Shadow render task has no depth attachment.");
                                }
                                WGPURenderPassDepthStencilAttachment shadow_attachment{};
                                // Its own cascade layer, which for every generator but
                                // a cascaded one is the single layer 0.
                                shadow_attachment.view =
                                    target.depth_layer_views[task.render.depth_layer];
                                shadow_attachment.depthLoadOp = WGPULoadOp_Clear;
                                // The pin's own shadow target clears to ITS far value,
                                // which standard-Z puts at 1 where this port's reverse-Z
                                // puts it at 0.
                                shadow_attachment.depthClearValue = pass_depth_clear(true);
                                shadow_attachment.depthStoreOp = WGPUStoreOp_Store;
                                shadow_attachment.stencilLoadOp = WGPULoadOp_Undefined;
                                shadow_attachment.stencilStoreOp = WGPUStoreOp_Undefined;
                                // An ESM caster pass STORES a colour: the exponential
                                // depth its material view writes. A PCF one has no
                                // colour attachment at all, which is the difference
                                // between the two pinned targets.
                                WGPURenderPassColorAttachment shadow_color =
                                    WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
                                if (target_record.has_color) {
                                    if (!target.color_view) {
                                        throw std::runtime_error("ESM shadow task has no colour "
                                                                 "attachment.");
                                    }
                                    shadow_color.view = target.color_view;
                                    shadow_color.loadOp = WGPULoadOp_Clear;
                                    shadow_color.storeOp = WGPUStoreOp_Store;
                                    // `createRenderTask({ clrColor: {0,0,0,0} })`.
                                    shadow_color.clearValue = {0.0, 0.0, 0.0, 0.0};
                                }
                                WGPURenderPassDescriptor shadow_descriptor =
                                    WGPU_RENDER_PASS_DESCRIPTOR_INIT;
                                shadow_descriptor.colorAttachmentCount =
                                    target_record.has_color ? 1u : 0u;
                                shadow_descriptor.colorAttachments =
                                    target_record.has_color ? &shadow_color : nullptr;
                                shadow_descriptor.depthStencilAttachment = &shadow_attachment;
                                DawnRenderPass shadow_pass_encoder{
                                    wgpuCommandEncoderBeginRenderPass(encoder, &shadow_descriptor)};
                                const ShadowGeneratorRecord& shadow_generator = handle_at(
                                    engine.shadow_generators, task.render.shadow_generator);
                                const std::uint32_t esm_shadow_index =
                                    shadow_generator.filter == ShadowFilter::esm_directional
                                        ? shadow_generator.esm_index
                                        : invalid_handle;
                                WGPURenderPipeline shadow_bound = nullptr;
                                draw_list_into(shadow_pass_encoder, render_task.draw_lists.opaque,
                                               1u, shadow_bound, true,
                                               render_task.pinned_frame_group, true,
                                               esm_shadow_index, render_task.view_projection);
                                draw_list_into(shadow_pass_encoder,
                                               render_task.draw_lists.transparent, 1u, shadow_bound,
                                               true, render_task.pinned_frame_group, true,
                                               esm_shadow_index, render_task.view_projection);
                                wgpuRenderPassEncoderEnd(shadow_pass_encoder);
                                shadow_pass_encoder.reset();
#if BBLITE_SHADOWS_ESM
                                // `renderEsmShadowMap` blurs the map it just drew, in
                                // two passes, before anything samples it.
                                if (esm_shadow_index != invalid_handle) {
                                    run_esm_blur(state, encoder, target.sampled_color_view,
                                                 esm_shadow_index);
                                }
#endif
                                continue;
                            }
#endif
                            if (!target_record.has_color) {
                                if (!target_record.has_depth || !target.depth) {
                                    throw std::runtime_error("Depth-only render task has no depth "
                                                             "attachment.");
                                }
                                if (task.render_meshes.empty()) {
                                    throw std::runtime_error(
                                        "Depth-only render task requires explicit "
                                        "meshes.");
                                }
                                WGPURenderPassDepthStencilAttachment depth_attachment{};
                                depth_attachment.view =
                                    target.depth_layer_views[task.render.depth_layer];
                                depth_attachment.depthLoadOp =
                                    upstream::render_task_loads_depth(false, false,
                                                                      task.render.depth_clear)
                                        ? WGPULoadOp_Load
                                        : WGPULoadOp_Clear;
                                depth_attachment.depthClearValue = upstream::pinned_depth_clear;
                                depth_attachment.depthStoreOp = WGPUStoreOp_Store;
                                if (target.depth_format == WGPUTextureFormat_Depth24PlusStencil8) {
                                    depth_attachment.stencilLoadOp = depth_attachment.depthLoadOp;
                                    depth_attachment.stencilStoreOp = WGPUStoreOp_Store;
                                }
                                WGPURenderPassDescriptor pass_descriptor =
                                    WGPU_RENDER_PASS_DESCRIPTOR_INIT;
                                pass_descriptor.colorAttachmentCount = 0;
                                pass_descriptor.depthStencilAttachment = &depth_attachment;
                                DawnRenderPass task_pass{
                                    wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor)};
                                set_task_camera_viewport(task_pass, pass_camera, target.width,
                                                         target.height);
                                // Group 1 is the shared stage's: the task's
                                // view-projection beside the mesh's own
                                // deformation and world blocks.
                                const auto depth_only_group =
                                    [&](const MeshHandle handle,
                                        const DawnMesh& mesh) -> const DawnDepthOnlyGroup& {
                                    DawnDepthOnlyGroup& cached =
                                        render_task.depth_only_groups[handle.value];
                                    if (cached.group &&
                                        cached.mesh_world == mesh.mesh_world_uniform)
                                        return cached;
                                    DawnBindGroupLayout layout{wgpuRenderPipelineGetBindGroupLayout(
                                        depth_only_pipeline_for(state, false, samples,
                                                                target.depth_format),
                                        1)};
                                    std::array<WGPUBindGroupEntry, mesh_world_uniform_binding + 1>
                                        entries{};
                                    for (std::uint32_t binding = 0; binding < entries.size();
                                         ++binding) {
                                        entries[binding] = WGPU_BIND_GROUP_ENTRY_INIT;
                                        entries[binding].binding = binding;
                                        if (!serve_mesh_stage_binding(entries[binding],
                                                                      render_task.view_projection,
                                                                      mesh)) {
                                            dawn_error("the depth-only stage's group 1 has no "
                                                       "binding " +
                                                       std::to_string(binding) + ".");
                                        }
                                    }
                                    WGPUBindGroupDescriptor descriptor =
                                        WGPU_BIND_GROUP_DESCRIPTOR_INIT;
                                    descriptor.layout = layout;
                                    descriptor.entryCount = entries.size();
                                    descriptor.entries = entries.data();
                                    cached.group = DawnBindGroup{require_dawn_resource(
                                        wgpuDeviceCreateBindGroup(state.device, &descriptor),
                                        "depth-only bind group")};
#if BBLITE_GPU_MORPH_STORAGE
                                    DawnBindGroupLayout morph_layout{
                                        wgpuRenderPipelineGetBindGroupLayout(
                                            depth_only_pipeline_for(state, false, samples,
                                                                    target.depth_format),
                                            0)};
                                    std::array<WGPUBindGroupEntry, 2> morph_entries{};
                                    for (std::uint32_t binding = 0; binding < morph_entries.size();
                                         ++binding) {
                                        morph_entries[binding] = WGPU_BIND_GROUP_ENTRY_INIT;
                                        morph_entries[binding].binding = binding;
                                        morph_entries[binding].buffer =
                                            binding == 0 ? mesh.morph_deltas : mesh.morph_weights;
                                        morph_entries[binding].size = WGPU_WHOLE_SIZE;
                                    }
                                    descriptor.layout = morph_layout;
                                    descriptor.entryCount = morph_entries.size();
                                    descriptor.entries = morph_entries.data();
                                    cached.morph = DawnBindGroup{require_dawn_resource(
                                        wgpuDeviceCreateBindGroup(state.device, &descriptor),
                                        "depth-only morph bind group")};
#endif
                                    cached.mesh_world = mesh.mesh_world_uniform;
                                    return cached;
                                };
                                for (int sided_mode = 0; sided_mode < 2; ++sided_mode) {
                                    wgpuRenderPassEncoderSetPipeline(
                                        task_pass,
                                        depth_only_pipeline_for(state, sided_mode == 1, samples,
                                                                target.depth_format));
                                    for (const RenderTaskMesh& entry : task.render_meshes) {
                                        const auto material_handle =
                                            render_task_mesh_material(engine, entry);
                                        const MaterialRecord& material =
                                            handle_at(engine.materials, material_handle);
                                        if (!material.no_color) {
                                            throw std::runtime_error(
                                                "Depth-only render task requires "
                                                "a no-color material view.");
                                        }
                                        if (material.double_sided != (sided_mode == 1)) {
                                            continue;
                                        }
                                        // geometry-renderer-task.ts skips a hidden mesh at the draw
                                        // itself. This path consumes no draw list -- it walks the task's
                                        // own meshes and resolves each against the plan -- so it cannot
                                        // inherit append_draw's answer and asks the same predicate.
                                        if (!upstream::mesh_draws(
                                                handle_at(engine.meshes, entry.mesh))) {
                                            continue;
                                        }
                                        std::size_t mesh_index = graph_meshes.size();
                                        for (std::size_t index = 0; index < graph_plan.items.size();
                                             ++index) {
                                            if (graph_plan.items[index].mesh.value ==
                                                entry.mesh.value) {
                                                mesh_index = index;
                                                break;
                                            }
                                        }
                                        if (mesh_index >= graph_meshes.size()) {
                                            throw std::runtime_error(
                                                "Depth task mesh is not in the "
                                                "scene.");
                                        }
                                        DawnMesh& mesh = graph_meshes[mesh_index];
                                        // The row refresh keeps every other
                                        // item's blocks current; a
                                        // ShaderMaterial item's stage owns its
                                        // own, so this draw writes them.
                                        if (graph_plan.items[mesh_index].material_kind ==
                                            upstream::RenderMaterialKind::shader) {
                                            write_mesh_stage_blocks(
                                                state, graph_scene, engine,
                                                handle_at(engine.meshes, entry.mesh), mesh);
                                        }
                                        const DawnDepthOnlyGroup& bindings =
                                            depth_only_group(entry.mesh, mesh);
#if BBLITE_GPU_MORPH_STORAGE
                                        wgpuRenderPassEncoderSetBindGroup(
                                            task_pass, 0, bindings.morph, 0, nullptr);
#endif
                                        wgpuRenderPassEncoderSetBindGroup(
                                            task_pass, 1, bindings.group, 0, nullptr);
                                        wgpuRenderPassEncoderSetVertexBuffer(
                                            task_pass, 0, mesh.vertices, 0, WGPU_WHOLE_SIZE);
#if BBLITE_GPU_INSTANCING
                                        wgpuRenderPassEncoderSetVertexBuffer(
                                            task_pass, 1, mesh.instances, 0, WGPU_WHOLE_SIZE);
#endif
                                        wgpuRenderPassEncoderSetIndexBuffer(task_pass, mesh.indices,
                                                                            WGPUIndexFormat_Uint32,
                                                                            0, WGPU_WHOLE_SIZE);
                                        count_gpu_draw(wgpuRenderPassEncoderDrawIndexed, task_pass,
                                                       mesh.index_count,
#if BBLITE_GPU_INSTANCING
                                                       mesh.instance_count,
#else
                                                   1,
#endif
                                                       0, 0, 0);
                                    }
                                }
                                wgpuRenderPassEncoderEnd(task_pass);
                                task_pass.reset();
                                // Only a colour-less sampled-depth target has the copy
                                // to refresh; see `create_frame_graph_textures`.
                                if (target_record.sampled_depth && target.depth_copy) {
                                    encode_depth_copy(state, encoder, target);
                                }
                                continue;
                            }
                            WGPURenderPassColorAttachment color_attachment =
                                WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
                            color_attachment.view =
                                target_record.swapchain ? surface_view : target.color_view;
                            color_attachment.loadOp =
                                task.render.clear ? WGPULoadOp_Clear : WGPULoadOp_Load;
                            color_attachment.storeOp = WGPUStoreOp_Store;
                            const Color4 task_clear_color = task_pass_clear_color(task);
                            color_attachment.clearValue = WGPUColor{
                                task_clear_color.r,
                                task_clear_color.g,
                                task_clear_color.b,
                                task_clear_color.a,
                            };
                            // The pin resolves into `rst` at end-of-pass, and ignores it
                            // outright when the task's own target is single-sample. That
                            // is the count the target was *allocated* at, not the one it
                            // asked for: a run forced to one sample resolves nothing.
                            const std::uint32_t resolve = task.render.resolve_target.value;
                            if (resolve < state.render_targets.size() &&
                                task_sample_count(state, target_record.samples) > 1) {
                                color_attachment.resolveTarget =
                                    engine.render_targets[resolve].swapchain
                                        ? surface_view
                                        : state.render_targets[resolve].color_view;
                            }
                            WGPURenderPassDepthStencilAttachment depth_attachment{};
                            WGPURenderPassDescriptor pass_descriptor =
                                WGPU_RENDER_PASS_DESCRIPTOR_INIT;
                            pass_descriptor.colorAttachmentCount = 1;
                            pass_descriptor.colorAttachments = &color_attachment;
                            // The pin's external-depth arm: a task handed another task's
                            // depth binds that view and LOADS it, because a geometry
                            // output is eager and its owner already cleared and wrote it.
                            WGPUTextureView borrowed_depth_view = nullptr;
                            if (task.render.depth.source == RenderTextureSource::geometry_depth) {
                                borrowed_depth_view = task_depth_view(task.render.depth);
                            }
                            if (borrowed_depth_view) {
                                depth_attachment.view = borrowed_depth_view;
                                depth_attachment.depthLoadOp = WGPULoadOp_Load;
                                depth_attachment.depthStoreOp = WGPUStoreOp_Store;
                                depth_attachment.stencilLoadOp = WGPULoadOp_Load;
                                depth_attachment.stencilStoreOp = WGPUStoreOp_Store;
                                pass_descriptor.depthStencilAttachment = &depth_attachment;
                            } else if (target_record.has_depth && target.depth) {
                                // Its own layer, as the shadow and depth-only passes
                                // above take theirs; for every target but a cascaded
                                // shadow map that is the single layer 0.
                                depth_attachment.view =
                                    target.depth_layer_views[task.render.depth_layer];
                                depth_attachment.depthLoadOp =
                                    upstream::render_task_loads_depth(false, false,
                                                                      task.render.depth_clear)
                                        ? WGPULoadOp_Load
                                        : WGPULoadOp_Clear;
                                depth_attachment.depthClearValue = upstream::pinned_depth_clear;
                                depth_attachment.depthStoreOp = WGPUStoreOp_Store;
                                if (target.depth_format == WGPUTextureFormat_Depth24PlusStencil8) {
                                    depth_attachment.stencilLoadOp = depth_attachment.depthLoadOp;
                                    depth_attachment.stencilStoreOp = WGPUStoreOp_Store;
                                }
                                pass_descriptor.depthStencilAttachment = &depth_attachment;
                            }
                            DawnRenderPass task_pass{
                                wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor)};
                            set_task_camera_viewport(task_pass, pass_camera, target.width,
                                                     target.height);
                            WGPURenderPipeline bound_pipeline = nullptr;
#if BBLITE_HAS_BILLBOARDS
                            const auto draw_task_billboards = [&](BillboardDepthMode mode) {
                                for (const DawnBillboardPass& billboard : state.billboard_passes) {
                                    if (handle_at(engine.billboard_systems, billboard.system)
                                            .depth_mode != mode) {
                                        continue;
                                    }
                                    record_dawn_billboard_pass(
                                        task_pass, engine, billboard,
                                        dawn_billboard_task_scene(billboard, handle.value));
                                }
                                // The billboard pass has its own pipeline; a following
                                // mesh list must not mistake the previously cached mesh
                                // pipeline for the one currently bound on the encoder.
                                bound_pipeline = nullptr;
                            };
#endif
                            const bool pass_has_depth =
                                borrowed_depth_view || (target_record.has_depth && target.depth);
                            if (task.render.scene_stages) {
                                if (task.render.has_camera || samples != state.sample_count ||
                                    !pass_has_depth ||
                                    target.color_format != state.frame_color_format ||
                                    (!borrowed_depth_view &&
                                     target.depth_format !=
                                         WGPUTextureFormat_Depth24PlusStencil8)) {
                                    throw std::runtime_error(
                                        "Compiler-owned scene stages require the "
                                        "default camera, sample count, and depth target.");
                                }
                                // A materialized default task replaces the ordinary
                                // scene pass. Its draw lists contain meshes only, so
                                // replay the scene renderer's skybox sub-order before
                                // those lists rather than silently degrading to clear.
#if BBLITE_PINNED_BACKGROUNDS
                                for (const SkyboxLayer layer : skybox_stage_order) {
                                    const auto kind = state.background_draws.skybox(layer);
                                    if (!kind)
                                        continue;
                                    const DawnBackgroundArm& arm = state.background_arm(*kind);
                                    draw_dawn_background_arm(task_pass, arm,
                                                             render_task.pinned_frame_group);
                                    bound_pipeline = arm.pipeline;
                                }
#endif
                            }
                            draw_list_into(
                                task_pass, render_task.draw_lists.opaque, samples, bound_pipeline,
                                pass_has_depth, render_task.pinned_frame_group, false,
                                invalid_handle, render_task.view_projection,
                                DawnTaskTarget{target.color_format,
                                               borrowed_depth_view
                                                   ? WGPUTextureFormat_Depth24PlusStencil8
                                                   : target.depth_format});
#if BBLITE_HAS_BILLBOARDS
                            if (task.render.scene_stages) {
                                draw_task_billboards(BillboardDepthMode::cutout);
                            }
#endif
                            draw_list_into(
                                task_pass, render_task.draw_lists.transparent, samples,
                                bound_pipeline, pass_has_depth, render_task.pinned_frame_group,
                                false, invalid_handle, render_task.view_projection,
                                DawnTaskTarget{target.color_format,
                                               borrowed_depth_view
                                                   ? WGPUTextureFormat_Depth24PlusStencil8
                                                   : target.depth_format});
#if BBLITE_PINNED_BACKGROUNDS
                            // Ground is the final scene stage, after transparent
                            // meshes, exactly as in the non-frame-graph pass.
                            if (task.render.scene_stages && state.background_draws.ground) {
                                const DawnBackgroundArm& arm =
                                    state.background_arm(*state.background_draws.ground);
                                draw_dawn_background_arm(task_pass, arm,
                                                         render_task.pinned_frame_group);
                            }
#endif
#if BBLITE_HAS_BILLBOARDS
                            if (task.render.scene_stages) {
                                // Transparent systems close the compiler-owned scene
                                // task just as they close the ordinary scene pass.
                                draw_task_billboards(BillboardDepthMode::transparent);
                            }
#endif
                            wgpuRenderPassEncoderEnd(task_pass);
                            task_pass.reset();
                            if (graph_layer == 0 && task.render.scene_stages) {
                                for (std::size_t layer = 0; layer < overlay_plans.size(); ++layer) {
                                    const Scene& utility = *engine.scenes()[layer + 1];
                                    if (utility.surface_canvas || !utility.tasks.empty())
                                        continue;
                                    color_attachment.loadOp = WGPULoadOp_Load;
                                    depth_attachment.depthLoadOp = WGPULoadOp_Clear;
                                    DawnRenderPass utility_pass{wgpuCommandEncoderBeginRenderPass(
                                        encoder, &pass_descriptor)};
                                    // The layer's own scene pass camera, with
                                    // no fallback to the base scene's.
                                    const CameraRecord* const utility_camera =
                                        scene_pass_camera(engine, utility);
                                    set_pass_camera_viewport(utility_pass, utility, engine,
                                                             utility_camera, target.width,
                                                             target.height);
                                    pass_scene = &utility;
                                    pass_meshes = &state.overlay_meshes[layer];
#if BBLITE_PINNED_MATERIALS
                                    const WGPUBindGroup utility_group =
                                        overlay_frame_group(state, state.overlay_frames[layer]);
                                    const WGPUBuffer utility_uniforms =
                                        state.overlay_frames[layer].scene_uniforms;
#else
                                const WGPUBindGroup utility_group = nullptr;
                                const WGPUBuffer utility_uniforms = state.view_projection;
#endif
                                    WGPURenderPipeline utility_pipeline = nullptr;
                                    upstream::sort_transparent_draws(
                                        overlay_plans[layer].draw_lists.transparent, engine,
                                        utility_camera);
                                    draw_list_into(utility_pass,
                                                   overlay_plans[layer].draw_lists.opaque, samples,
                                                   utility_pipeline, pass_has_depth, utility_group,
                                                   false, invalid_handle, utility_uniforms);
                                    draw_list_into(
                                        utility_pass, overlay_plans[layer].draw_lists.transparent,
                                        samples, utility_pipeline, pass_has_depth, utility_group,
                                        false, invalid_handle, utility_uniforms);
                                    wgpuRenderPassEncoderEnd(utility_pass);
                                    utility_pass.reset();
                                }
                                pass_scene = &graph_scene;
                                pass_meshes = &graph_meshes;
                            }
                            continue;
                        }
                        if (task.kind == FrameTaskKind::geometry) {
                            // Without a camera the task does not execute, not
                            // even its clears.
                            if (upstream::geometry_task_skips(
                                    geometry_pass_camera(engine, graph_scene)))
                                continue;
                            DawnGeometryTask& geometry = handle_at(state.geometry_tasks, handle);
                            DawnRenderTask& render_task = handle_at(state.render_tasks, handle);
                            const std::uint32_t samples =
                                task_sample_count(state, task.geometry.samples);
                            std::vector<WGPURenderPassColorAttachment> color_attachments;
                            color_attachments.reserve(task.geometry.attachments.size() + 1);
                            for (std::size_t index = 0; index < task.geometry.attachments.size();
                                 ++index) {
                                WGPURenderPassColorAttachment attachment =
                                    WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
                                attachment.view = geometry.color_views[index];
                                attachment.loadOp = WGPULoadOp_Clear;
                                attachment.clearValue =
                                    geometry_clear_color(task.geometry.attachments[index].type);
                                if (samples == 1) {
                                    attachment.storeOp = WGPUStoreOp_Store;
                                } else {
                                    attachment.storeOp = WGPUStoreOp_Discard;
                                    attachment.resolveTarget = geometry.sampled_views[index];
                                }
                                color_attachments.push_back(attachment);
                            }
                            if (task.geometry.target.value != invalid_handle) {
                                DawnRenderTarget& output_target =
                                    handle_at(state.render_targets, task.geometry.target);
                                WGPURenderPassColorAttachment attachment =
                                    WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
                                attachment.view = output_target.color_view;
                                attachment.loadOp =
                                    task.geometry.clear_target ? WGPULoadOp_Clear : WGPULoadOp_Load;
                                attachment.clearValue = WGPUColor{
                                    task.geometry.target_clear_color.r,
                                    task.geometry.target_clear_color.g,
                                    task.geometry.target_clear_color.b,
                                    task.geometry.target_clear_color.a,
                                };
                                if (samples == 1) {
                                    attachment.storeOp = WGPUStoreOp_Store;
                                } else {
                                    attachment.storeOp = WGPUStoreOp_Discard;
                                    attachment.resolveTarget = output_target.sampled_color_view;
                                }
                                color_attachments.push_back(attachment);
                            }
                            WGPURenderPassDepthStencilAttachment depth_attachment{};
                            depth_attachment.view = geometry.depth_view;
                            depth_attachment.depthLoadOp = WGPULoadOp_Clear;
                            depth_attachment.depthClearValue = upstream::pinned_depth_clear;
                            depth_attachment.depthStoreOp =
                                geometry.depth_borrowed ? WGPUStoreOp_Store : WGPUStoreOp_Discard;
                            depth_attachment.stencilLoadOp = WGPULoadOp_Clear;
                            depth_attachment.stencilStoreOp = WGPUStoreOp_Discard;
                            WGPURenderPassDescriptor pass_descriptor =
                                WGPU_RENDER_PASS_DESCRIPTOR_INIT;
                            pass_descriptor.colorAttachmentCount = color_attachments.size();
                            pass_descriptor.colorAttachments = color_attachments.data();
                            pass_descriptor.depthStencilAttachment = &depth_attachment;
                            DawnRenderPass task_pass{
                                wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor)};
                            // Over the task's own attachments, which the frame
                            // graph allocates at the frame's extent.
                            set_task_camera_viewport(task_pass,
                                                     geometry_pass_camera(engine, graph_scene),
                                                     width, height);
                            // Both are read only by the composed families' arms below,
                            // so a scene reaching neither leaves them untouched.
                            [[maybe_unused]] WGPURenderPipeline bound_pipeline = nullptr;
                            const auto draw_geometry_list = [&](const upstream::RenderDrawList&
                                                                    list) {
                                for (const upstream::RenderDrawCommand& draw : list.commands) {
                                    if (!upstream::render_item_draws_now(draw.item, engine))
                                        continue;
                                    if (draw.item_index >= graph_meshes.size()) {
                                        continue;
                                    }
                                    [[maybe_unused]] DawnMesh& mesh = graph_meshes[draw.item_index];
#if BBLITE_PBR_VARIANTS > 0
                                    // The pin's own MRT arm for a PBR draw: the
                                    // variant the selector table keys on this
                                    // task, its bindings built in the write phase.
                                    if (draw.item.material_kind ==
                                        upstream::RenderMaterialKind::pbr) {
                                        pal::PinnedVariantKey geometry_key;
                                        const std::size_t variant = pinned_variant_for_draw(
                                            graph_scene, engine, draw,
                                            static_cast<std::size_t>(task.geometry.shader_index),
                                            &geometry_key);
                                        if (variant == npos) {
                                            dawn_error(
                                                ("PBR draw for mesh " +
                                                 std::to_string(draw.item.mesh.value) +
                                                 " resolves no pinned variant in "
                                                 "a geometry task: " +
                                                 pal::pinned_variant_request(
                                                     geometry_key, static_cast<std::size_t>(
                                                                       task.geometry.shader_index)))
                                                    .c_str());
                                        }
                                        const auto draw_state_it =
                                            mesh.pinned_geometry_states.find(variant);
                                        if (draw_state_it == mesh.pinned_geometry_states.end()) {
                                            dawn_error("pinned geometry draw reached the "
                                                       "encoder with no bindings.");
                                        }
                                        const InstanceStreams pinned_streams = instance_streams_for(
                                            handle_at(engine.meshes, draw.item.mesh), mesh);
                                        encode_variant_draw(
                                            task_pass,
                                            pinned_variant_pipeline(state, variant, draw.pipeline,
                                                                    samples, true, &task),
                                            bound_pipeline, pinned_geometry_frame_group(state),
                                            draw_state_it->second.group, mesh.vertices,
                                            pinned_streams, mesh.indices, mesh.index_count);
                                        continue;
                                    }
#endif
#if BBLITE_STANDARD_VARIANTS > 0
                                    // The composed Standard MRT arm: variant and
                                    // bindings resolved in the write phase, the
                                    // task's own gp buffer inside the group.
                                    if (draw.item.material_kind ==
                                        upstream::RenderMaterialKind::standard) {
                                        const std::size_t variant = standard_variant_for_draw(
                                            graph_scene, engine, draw,
                                            static_cast<std::size_t>(task.geometry.shader_index));
                                        if (variant == npos) {
                                            dawn_error(("Standard draw for mesh " +
                                                        std::to_string(draw.item.mesh.value) +
                                                        " resolves no composed variant "
                                                        "in a geometry task: " +
                                                        standard_variant_request(graph_scene,
                                                                                 engine, draw))
                                                           .c_str());
                                        }
                                        const auto draw_state_it =
                                            mesh.standard_geometry_states.find(variant);
                                        if (draw_state_it == mesh.standard_geometry_states.end() ||
                                            !draw_state_it->second.group) {
                                            dawn_error("standard geometry draw reached "
                                                       "the encoder with no bindings.");
                                        }
                                        const InstanceStreams standard_streams =
                                            instance_streams_for(
                                                handle_at(engine.meshes, draw.item.mesh), mesh);
                                        encode_variant_draw(
                                            task_pass,
                                            standard_variant_pipeline(state, variant, draw.pipeline,
                                                                      samples, true, false, &task),
                                            bound_pipeline, pinned_geometry_frame_group(state),
                                            draw_state_it->second.group, mesh.vertices,
                                            standard_streams, mesh.indices, mesh.index_count);
                                        continue;
                                    }
#endif
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
                                    // The node family's own MRT arm: the view
                                    // composed for this task, with the group the
                                    // write phase built around the task's
                                    // gpUniforms.
                                    if (draw.item.material_kind ==
                                        upstream::RenderMaterialKind::node) {
                                        const std::size_t geometry_variant =
                                            pal::require_node_geometry_variant(
                                                draw.item.shader_variant,
                                                static_cast<std::size_t>(
                                                    task.geometry.shader_index));
                                        const auto draw_state_it =
                                            mesh.node_geometry_states.find(geometry_variant);
                                        if (draw_state_it == mesh.node_geometry_states.end() ||
                                            !draw_state_it->second.group) {
                                            dawn_error("node geometry draw reached the "
                                                       "encoder with no bindings.");
                                        }
                                        encode_node_variant_draw(
                                            state, draw, task_pass,
                                            node_variant_pipeline(state, draw.item.shader_variant,
                                                                  draw.pipeline, samples, true,
                                                                  false, false, invalid_handle,
                                                                  &task, geometry_variant),
                                            bound_pipeline, pinned_geometry_frame_group(state),
                                            draw_state_it->second.group,
                                            // A node graph reads the baked
                                            // vertices under the identity world,
                                            // like the Standard family.
                                            mesh.vertices, InstanceStreams{}, mesh.indices,
                                            mesh.index_count);
                                        continue;
                                    }
#endif
                                    // Every mesh-family draw resolved a
                                    // composed variant above; nothing else is
                                    // eligible for a geometry task.
                                    dawn_error("geometry task draw resolved no composed "
                                               "variant.");
                                }
                            };
                            draw_geometry_list(render_task.draw_lists.opaque);
                            draw_geometry_list(render_task.draw_lists.transparent);
                            wgpuRenderPassEncoderEnd(task_pass);
                            task_pass.reset();
                            continue;
                        }
#if BBLITE_HAS_EFFECT_TASK
                        if (task.kind == FrameTaskKind::effect) {
                            // The same two halves the swapchain renderer draws through,
                            // recorded into the frame graph's encoder instead: the pin
                            // ships two entry points over one pass, not two passes.
                            if (state.effect_tasks.size() < engine.frame_tasks.size()) {
                                state.effect_tasks.resize(engine.frame_tasks.size());
                            }
                            DawnEffectPass& pass = handle_at(state.effect_tasks, handle);
                            const RenderTargetRecord& target_record =
                                handle_at(engine.render_targets, task.effect.target);
                            DawnRenderTarget& target =
                                handle_at(state.render_targets, task.effect.target);
                            if (!pass.pipeline) {
                                pass = create_dawn_effect_pass(
                                    state, engine, task.effect.effect, target.color_format,
                                    target_record.swapchain
                                        ? 1u
                                        : task_sample_count(state, target_record.samples));
                            }
                            upload_dawn_effect_pass(state.queue, engine, pass, task.effect.effect);
                            WGPURenderPassColorAttachment attachment =
                                WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
                            attachment.view =
                                target_record.swapchain ? surface_view : target.color_view;
                            attachment.loadOp =
                                task.effect.clear ? WGPULoadOp_Clear : WGPULoadOp_Load;
                            attachment.storeOp = WGPUStoreOp_Store;
                            attachment.clearValue =
                                WGPUColor{task.effect.clear_color.r, task.effect.clear_color.g,
                                          task.effect.clear_color.b, task.effect.clear_color.a};
                            WGPURenderPassDescriptor descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
                            descriptor.colorAttachmentCount = 1;
                            descriptor.colorAttachments = &attachment;
                            DawnRenderPass effect_pass{
                                wgpuCommandEncoderBeginRenderPass(encoder, &descriptor)};
                            record_dawn_effect_pass(effect_pass, pass);
                            wgpuRenderPassEncoderEnd(effect_pass);
                            effect_pass.reset();
                            continue;
                        }
#endif
#if BBLITE_HAS_POST_PROCESS
                        if (task.kind == FrameTaskKind::post_process) {
#if BBLITE_HAS_TAA
                            const auto execute_pass = [&](std::size_t child, bool write_uniforms) {
                                auto prepared = prepare_dawn_post_process_pass(
                                    state, engine, handle, width, height, child,
                                    source_texture_view, write_uniforms);
                                encode_dawn_post_process_pass(encoder, surface_view, prepared);
                                if (prepared.presents) {
                                    frame_graph_presented = true;
                                }
                                return upstream::post_process_leaf_draw_count();
                            };
                            if (task.post_process.taa) {
                                auto& taa = *task.post_process.taa;
                                const auto source_handle = task.post_process.source_tasks.at(0);
                                auto& source = handle_at(engine.frame_tasks, source_handle);
                                auto& gpu_source = state.render_tasks.at(source_handle.value);
                                if (!source.source_scene)
                                    throw std::runtime_error(
                                        "Temporal source has no retained scene.");
                                restore_temporal_source_buffer(state, source, gpu_source);
                                CameraRecord* source_camera =
                                    handle_find(engine.cameras, source.source_scene->camera);
                                [[maybe_unused]] const double draws =
                                    upstream::execute_taa_post_process(
                                        taa, task.post_process.passes.at(0).params[0],
                                        source_camera,
                                        [](CameraRecord* value) {
                                            return upstream::scene_camera_change_key(*value);
                                        },
                                        [&](std::size_t child) {
                                            write_dawn_post_process_uniforms(
                                                state, engine, handle, child, width, height, true);
                                        },
                                        [&](std::size_t child) -> std::optional<double> {
                                            return execute_pass(child, false);
                                        },
                                        [&](TaaPostProcessState& value) {
                                            const auto& blend = task.post_process.passes.at(0);
                                            const auto extent = resolve_post_process_extent(
                                                handle_at(engine.render_targets,
                                                          blend.output_target),
                                                state.render_targets, blend, width, height);
                                            advance_temporal_jitter(
                                                value, *source.scene_uniforms, extent.source_width,
                                                extent.source_height,
                                                [&](std::size_t offset, const float* data,
                                                    std::size_t bytes) {
                                                    wgpuQueueWriteBuffer(
                                                        state.queue,
                                                        gpu_source.pinned_scene_uniforms, offset,
                                                        data, bytes);
                                                });
                                        });
                                ++taa.execution_count;
                            } else {
                                for (std::size_t child = 0; child < task.post_process.passes.size();
                                     ++child)
                                    execute_pass(child, true);
                            }
                            continue;
#endif
                            // A composite records the chain its own factory built; a
                            // plain effect is the same loop over one.
                            for (std::size_t index = 0; index < task.post_process.passes.size();
                                 ++index) {
                                record_post_process_pass(state, engine, handle, encoder,
                                                         surface_view, width, height, index,
                                                         source_texture_view);
                                const RenderTargetRecord& output_record =
                                    engine.render_targets[task.post_process.passes[index]
                                                              .output_target.value];
                                if (output_record.swapchain) {
                                    frame_graph_presented = true;
                                }
                            }
                            continue;
                        }
#endif
#if BBLITE_HAS_SCREEN_SPACE
                        if (task.kind == FrameTaskKind::screen_space) {
                            record_screen_space_task(state, engine, handle, encoder, surface_view,
                                                     width, height, source_texture_view,
                                                     frame_graph_presented);
                            continue;
                        }
#endif
                        const CopyTaskOptions& copy = task.copy;
                        if (frame_options.skip_copy_task(copy))
                            continue;
                        const bool force_full_viewport = frame_options.full_copy_viewport(copy);
                        if (copy.resolve_target.value != invalid_handle &&
                            copy.target.value == invalid_handle) {
                            if (copy.source.source != RenderTextureSource::render_target) {
                                throw std::runtime_error("Resolve source must be a render target.");
                            }
                            DawnRenderTarget& resolve_source =
                                handle_at(state.render_targets, copy.source.target);
                            DawnRenderTarget& resolve_target =
                                handle_at(state.render_targets, copy.resolve_target);
                            if (!state.multisampled()) {
                                // Nothing to average: the pinned resolve of a
                                // single-sample source is the source, so the frame
                                // graph's resolve step is a texture copy.
                                WGPUTexelCopyTextureInfo copy_source{};
                                copy_source.texture = resolve_source.color;
                                WGPUTexelCopyTextureInfo copy_destination{};
                                copy_destination.texture = resolve_target.color;
                                const WGPUExtent3D extent{resolve_source.width,
                                                          resolve_source.height, 1};
                                wgpuCommandEncoderCopyTextureToTexture(encoder, &copy_source,
                                                                       &copy_destination, &extent);
                                continue;
                            }
                            WGPURenderPassColorAttachment resolve_attachment =
                                WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
                            resolve_attachment.view = resolve_source.color_view;
                            resolve_attachment.resolveTarget = resolve_target.color_view;
                            resolve_attachment.loadOp = WGPULoadOp_Load;
                            resolve_attachment.storeOp = WGPUStoreOp_Discard;
                            WGPURenderPassDescriptor pass_descriptor =
                                WGPU_RENDER_PASS_DESCRIPTOR_INIT;
                            pass_descriptor.colorAttachmentCount = 1;
                            pass_descriptor.colorAttachments = &resolve_attachment;
                            DawnRenderPass resolve_pass{
                                wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor)};
                            wgpuRenderPassEncoderEnd(resolve_pass);
                            resolve_pass.reset();
                            continue;
                        }
                        const RenderTargetRecord& target_record =
                            handle_at(engine.render_targets, copy.target);
                        DawnRenderTarget& target = handle_at(state.render_targets, copy.target);
                        const auto [source_texture, source_view] = source_texture_view(copy.source);
                        std::optional<PixelViewport> surface_pane;
                        if (target_record.swapchain && !force_full_viewport) {
                            surface_pane = scene_surface_pane(engine, graph_scene, width, height);
                        }
                        WGPURenderPassColorAttachment blit_attachment =
                            WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
                        blit_attachment.view =
                            target_record.swapchain ? surface_view : target.color_view;
                        blit_attachment.loadOp =
                            copy.has_viewport || (surface_pane && graph_layer > 0)
                                ? WGPULoadOp_Load
                                : WGPULoadOp_Clear;
                        blit_attachment.storeOp = WGPUStoreOp_Store;
                        WGPURenderPassDescriptor pass_descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
                        pass_descriptor.colorAttachmentCount = 1;
                        pass_descriptor.colorAttachments = &blit_attachment;
                        DawnRenderPass blit_pass{
                            wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor)};
                        const std::uint32_t blit_samples =
                            target_record.swapchain
                                ? 1u
                                : task_sample_count(state, target_record.samples);
                        WGPURenderPipeline blit_pipeline =
                            blit_pipeline_for(state, state.surface_format, blit_samples);
                        wgpuRenderPassEncoderSetPipeline(blit_pass, blit_pipeline);
                        if (surface_pane) {
                            wgpuRenderPassEncoderSetViewport(
                                blit_pass, static_cast<float>(surface_pane->x),
                                static_cast<float>(surface_pane->y),
                                static_cast<float>(surface_pane->width),
                                static_cast<float>(surface_pane->height), 0.0f, 1.0f);
                            wgpuRenderPassEncoderSetScissorRect(
                                blit_pass, surface_pane->x, surface_pane->y, surface_pane->width,
                                surface_pane->height);
                        } else if (copy.has_viewport && !force_full_viewport) {
#if BBLITE_HAS_GEOMETRY_OUTPUT
                            const PixelViewport pixel_viewport = upstream::resolve_copy_viewport(
                                copy.viewport, target.width, target.height);
                            wgpuRenderPassEncoderSetViewport(
                                blit_pass, static_cast<float>(pixel_viewport.x),
                                static_cast<float>(pixel_viewport.y),
                                static_cast<float>(pixel_viewport.width),
                                static_cast<float>(pixel_viewport.height), 0.0f, 1.0f);
                            wgpuRenderPassEncoderSetScissorRect(
                                blit_pass, static_cast<std::uint32_t>(pixel_viewport.x),
                                static_cast<std::uint32_t>(pixel_viewport.y),
                                static_cast<std::uint32_t>(pixel_viewport.width),
                                static_cast<std::uint32_t>(pixel_viewport.height));
#else
                        throw std::runtime_error("Viewport copy requires geometry-output support.");
#endif
                        }
                        {
                            WGPUBindGroup blit_group =
                                blit_group_for(state, blit_pipeline, source_view);
                            wgpuRenderPassEncoderSetBindGroup(blit_pass, 2, blit_group, 0, nullptr);
                            count_gpu_draw(wgpuRenderPassEncoderDraw, blit_pass, 3, 1, 0, 0);
                            wgpuRenderPassEncoderEnd(blit_pass);
                            blit_pass.reset();
                            wgpuBindGroupRelease(blit_group);
                        }
                        if (target_record.swapchain) {
                            // A copy covering the whole swapchain IS its source, so
                            // the capture reads that source and skips a surface
                            // readback. One writing a VIEWPORT is only part of the
                            // frame -- scene 187 presents SMAA beside the raw image,
                            // each into half -- so the composed image is the surface,
                            // and the source is both the wrong size and the wrong
                            // content. The surface is configured CopySrc, which is
                            // what the standalone frame-graph driver already captures.
                            if (!copy.has_viewport && !surface_pane) {
                                capture_source = source_texture;
                            }
                            frame_graph_presented = true;
                        }
                    }
                }
#if BBLITE_HAS_TAA
                if (frame_graph_presented)
                    retain_temporal_presentation(state, encoder, surface_texture.texture, width,
                                                 height);
            } else if (state.temporal_presented) {
                present_stopped_temporal_frame(state, encoder, surface_view);
                frame_graph_presented = true;
            }
#endif
            pass_scene = &scene;
            pass_meshes = &state.meshes;
        }

#if BBLITE_HAS_TAA || BBLITE_HAS_TEXT || BBLITE_NODE_GEOMETRY_VARIANTS > 0
        capture_render_state();
#endif
#if BBLITE_HAS_SPRITE_RENDERER
        // The scene context records first. Registered sprite contexts then
        // load and blend over the final surface in registration order, after
        // any transmission image processing or frame-graph copy. Capture and
        // presentation therefore observe the same composed frame.
        if (!engine.sprite_renderer_contexts().empty()) {
            for (const SpriteRendererHandle handle : engine.sprite_renderer_contexts()) {
                if (handle.value >= state.sprite_passes.size()) {
                    throw std::runtime_error("A SpriteRenderer created after the scene frame "
                                             "started has no Dawn pass yet.");
                }
                const SpriteRendererRecord& renderer = handle_at(engine.sprite_renderers, handle);
                WGPURenderPassColorAttachment sprite_attachment =
                    WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
                sprite_attachment.view =
                    renderer.has_target ? state.sprite_render_texture_views[renderer.target.value]
                                        : surface_view;
                sprite_attachment.loadOp = renderer.clear ? WGPULoadOp_Clear : WGPULoadOp_Load;
                sprite_attachment.storeOp = WGPUStoreOp_Store;
                sprite_attachment.clearValue =
                    WGPUColor{renderer.clear_value.r, renderer.clear_value.g,
                              renderer.clear_value.b, renderer.clear_value.a};
                WGPURenderPassDescriptor sprite_descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
                sprite_descriptor.colorAttachmentCount = 1;
                sprite_descriptor.colorAttachments = &sprite_attachment;
                DawnRenderPass sprite_encoder{
                    wgpuCommandEncoderBeginRenderPass(encoder, &sprite_descriptor)};
                record_dawn_sprite_pass(sprite_encoder, engine,
                                        handle_at(state.sprite_passes, handle));
                wgpuRenderPassEncoderEnd(sprite_encoder);
                sprite_encoder.reset();
            }
            capture_source = surface_texture.texture;
        }
#endif
    }

    FramePreparation present() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& captures = data_.captures;
        [[maybe_unused]] auto& frame = data_.frame;
        [[maybe_unused]] auto& scene = data_.scene;
        [[maybe_unused]] auto& state = data_.state;
        [[maybe_unused]] auto& width = data_.width;
        [[maybe_unused]] auto& height = data_.height;
        [[maybe_unused]] auto& render_plan = data_.render_plan;
        [[maybe_unused]] auto& benchmark_samples = data_.samples_ms;
        [[maybe_unused]] auto& screenshot_path = data_.frame_options.screenshot_path;
        [[maybe_unused]] auto& id_buffer_path = data_.frame_options.id_buffer_path;
        [[maybe_unused]] auto& cluster_buffer_path = data_.frame_options.cluster_buffer_path;
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        [[maybe_unused]] auto& capture_ui = data_.frame_options.capture_ui;
#endif
        [[maybe_unused]] const auto benchmark = data_.frame_options.benchmarking();
        [[maybe_unused]] const auto benchmark_warmup = data_.frame_options.benchmark_warmup();
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        [[maybe_unused]] auto& ui_runtime = data_.ui_runtime;
#endif
#if BBLITE_OFFSCREEN_SURFACES
        [[maybe_unused]] auto& offscreen = data_.offscreen;
#endif
#if BBLITE_OFFSCREEN_SURFACES
        [[maybe_unused]] auto& offscreen_images = data_.offscreen_images;
#endif
        [[maybe_unused]] const auto& benchmark_start = current_frame().benchmark_start;
        [[maybe_unused]] const auto& capture_ready = current_frame().capture_ready;
        [[maybe_unused]] auto& surface_texture = current_frame().surface_texture;
        [[maybe_unused]] auto& surface = current_frame().surface;
        [[maybe_unused]] auto& surface_view = current_frame().surface_view;
        [[maybe_unused]] auto& encoder = current_frame().encoder;
        [[maybe_unused]] auto& capture_source = current_frame().capture_source;
        [[maybe_unused]] auto& frame_graph_presented = current_frame().frame_graph_presented;
        const bool capture_frame =
            capture_ready && !captures.screenshot_saved && !screenshot_path.empty();
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        const UiRenderFrame& ui_frame = record_ui_rml_frame(*ui_runtime, width, height);
        const bool ui_after_capture_copy = capture_frame && !capture_ui;
        if (!ui_after_capture_copy) {
            render_sprite_ui_dawn_frame(state, encoder, surface_texture.texture, surface_view,
                                        state.ui, ui_frame, nullptr, state.sample_count);
            if (capture_frame && capture_ui) {
                capture_source = surface_texture.texture;
            }
        }
#endif
        DawnSurfaceCapture capture;
        if (capture_frame) {
            if (!scene.tasks.empty() && !frame_graph_presented) {
                throw std::runtime_error("Frame graph did not present a capture source.");
            }
            capture =
                begin_dawn_surface_capture(state.device, encoder, capture_source, width, height);
        }
        DawnCommandBuffer command{wgpuCommandEncoderFinish(encoder, nullptr)};
        submit_dawn_command(state.queue, command);
        command.reset();
        encoder.reset();
#if BBLITE_GPU_TASK_TIMING
        finish_gpu_task_timing_frame(engine);
#endif
#if BBLITE_COMPUTE_FRAME_GRAPH
        finish_compute_frame_prefix(engine);
#endif

        if (capture_frame) {
            finish_dawn_surface_capture(state, capture, width, height, screenshot_path);
            captures.screenshot_saved = true;
        }
        capture.readback.reset();
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        if (ui_after_capture_copy) {
            // Complete the canvas-only readback before transitioning the
            // surface back to a render attachment for host UI. Encoding both
            // uses in one submission can leave Dawn's map future unresolved.
            DawnCommandEncoder ui_encoder{wgpuDeviceCreateCommandEncoder(state.device, nullptr)};
            render_sprite_ui_dawn_frame(state, ui_encoder, surface_texture.texture, surface_view,
                                        state.ui, ui_frame, nullptr, state.sample_count);
            DawnCommandBuffer ui_command{wgpuCommandEncoderFinish(ui_encoder, nullptr)};
            submit_dawn_command(state.queue, ui_command);
            ui_command.reset();
            ui_encoder.reset();
        }
#endif

        if (capture_ready && !captures.id_buffer_saved && !id_buffer_path.empty()) {
            save_dawn_geometry_id_buffer(state, width, height, render_plan.items, engine,
                                         id_buffer_path, false);
            captures.id_buffer_saved = true;
        }
        if (capture_ready && !captures.cluster_buffer_saved && !cluster_buffer_path.empty()) {
            save_dawn_geometry_id_buffer(state, width, height, render_plan.items, engine,
                                         cluster_buffer_path, true);
            captures.cluster_buffer_saved = true;
        }

#if BBLITE_OFFSCREEN_SURFACES
        if (offscreen)
            offscreen_images.publish(*offscreen);
        else
#endif
            wgpuSurfacePresent(state.surface);
        if (benchmark && frame >= benchmark_warmup) {
            benchmark_samples.push_back(monotonic_milliseconds() - benchmark_start);
        }
        surface_view.reset();
        surface.reset();
        wgpuInstanceProcessEvents(state.instance);
#if BBLITE_DEVICE_RECOVERY
        if (state.device_lost) {
            force_device_loss(engine);
            return FramePreparation::stop;
        }
#endif
        if (!state.uncaptured_error.empty()) {
            dawn_error("uncaptured error: " + state.uncaptured_error);
        }
#if BBLITE_DEVICE_RECOVERY
        if (engine.device_recovery) {
            auto& recovery = *engine.device_recovery;
            GpuTextureIdentity& environment = recovery.environments[scene.state.get()];
            if (environment.object == 0 || environment.generation != engine.device_generation ||
                state.published_environment_cube != state.environment_cube) {
                state.published_environment_cube = state.environment_cube;
                environment = publish_gpu_texture_identity(engine);
            }
            if (recovery.fallback.object == 0 ||
                recovery.fallback.generation != engine.device_generation ||
                state.published_white_texture != state.white_texture) {
                state.published_white_texture = state.white_texture;
                recovery.fallback = publish_gpu_texture_identity(engine);
            }
            auto& renderable_count = recovery.renderable_counts[scene.state.get()];
            renderable_count = state.meshes.size();
#if BBLITE_PINNED_BACKGROUNDS
            renderable_count += state.background_arms.size();
#endif
#if BBLITE_SHADOW_RECEIVERS
            recovery.shadows.resize(engine.shadow_generators.size());
            for (std::size_t i = 0; i < engine.shadow_generators.size(); ++i) {
                const auto& generator = engine.shadow_generators[i];
                if (generator.map_target.value >= state.render_targets.size())
                    continue;
                WGPUTexture texture =
                    handle_at(state.render_targets, generator.map_target).depth.get();
#if BBLITE_SHADOWS_ESM
                if (generator.filter == ShadowFilter::esm_directional &&
                    generator.esm_index < state.esm_blurs.size())
                    texture = state.esm_blurs[generator.esm_index].blur_v;
#endif
                recovery.shadows[i] = {engine.device_generation,
                                       reinterpret_cast<std::uintptr_t>(texture)};
            }
#endif
            recovery.resources_ready = true;
        }
#endif

        return FramePreparation::ready;
    }

    void complete() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& frame = data_.frame;
        [[maybe_unused]] auto& cpu_profile = data_.cpu_profile;
        [[maybe_unused]] auto& mem_profile = data_.mem_profile;
        [[maybe_unused]] auto& scene = data_.scene;
        [[maybe_unused]] auto& state = data_.state;
        [[maybe_unused]] auto& render_plan = data_.render_plan;
        [[maybe_unused]] const auto& benchmark_start = current_frame().benchmark_start;
        [[maybe_unused]] const auto& updated = current_frame().updated;
        [[maybe_unused]] const auto& uploaded = current_frame().uploaded;
        [[maybe_unused]] const auto& written = current_frame().written;
        [[maybe_unused]] const auto& acquired = current_frame().acquired;
        finish_frame(engine);
        ++frame;
        // Profile-only too: this backend's benchmark sample above reads its
        // own `monotonic_milliseconds()` inline.
        const double end = cpu_profile ? monotonic_milliseconds() : 0.0;
        const long completed_frame = frame - 1;
        data_.frame_rate_profile.complete(completed_frame);
        if (mem_profile.due(completed_frame)) {
            mem_profile.print(completed_frame, engine, scene, state.meshes,
                              state.shared_shader_geometries);
        }
        if (cpu_profile && frame_profile_due(completed_frame, end - benchmark_start)) {
            std::size_t draw_commands = render_plan.draw_lists.opaque.commands.size() +
                                        render_plan.draw_lists.transparent.commands.size();
            for (const DawnRenderTask& profiled : state.render_tasks) {
                draw_commands += profiled.draw_lists.opaque.commands.size() +
                                 profiled.draw_lists.transparent.commands.size();
            }
            // The SDL backend's labels where the phase is the same concept.
            // The acquire sits late here rather than at the loop head, and
            // `write_ms` is this backend's own phase: the per-draw block
            // writes WebGPU's no-push-constants model forces.
            print_cpu_frame_profile(completed_frame, end - benchmark_start, acquired - written,
                                    updated - benchmark_start, uploaded - updated,
                                    written - uploaded, end - acquired, render_plan.items.size(),
                                    draw_commands);
        }
    }

    void finish_run() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& state = data_.state;
        [[maybe_unused]] auto& benchmark_samples = data_.samples_ms;
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        [[maybe_unused]] auto& ui_runtime = data_.ui_runtime;
#endif
        report_benchmark(benchmark_samples, "Dawn", "D3D12");
#if BBLITE_DEVICE_RECOVERY
        if (engine.device_recovery &&
            (engine.device_recovery->requested || engine.device_recovery->disposed))
            state.destroy_device();
#endif
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        ui_runtime.reset();
#endif
        // No catch arm: everything `~DawnState` and the unique_ptr UI runtime
        // own unwinds on its own, and `pick_hook_guard` clears the hook on
        // either exit.
    }
};

SceneRun run_dawn_engine(Engine& engine) {
    if (engine.scenes().empty() || !engine.scenes().front())
        throw std::runtime_error("Dawn renderer requires a registered scene.");
    DawnSceneRun renderer(engine);
    renderer.setup();
    for (;;) {
        renderer.discard_frame();
        const FrameOutcome outcome = conduct_frame(renderer);
        if (outcome == FrameOutcome::stopped || outcome == FrameOutcome::restart)
            break;
        if (outcome == FrameOutcome::rendered || renderer.yield_when_skipped())
            BBLITE_FRAME_YIELD(outcome == FrameOutcome::rendered);
    }
    renderer.discard_frame();
    renderer.finish_run();
    BBLITE_RUN_RETURN(true);
}

} // namespace bbl::pal

#endif

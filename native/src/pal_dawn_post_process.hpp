#pragma once
#include <bblite/features/has_post_process.hpp>
#include "pal_dawn_shared.hpp"

#if BBLITE_HAS_POST_PROCESS && BBLITE_HAS_DAWN
#include <bblite/upstream/frame_graph_post_process.hpp>
#include <bblite/upstream/post_process_shaders.hpp>

namespace bbl::pal {

struct DawnPostProcessProgram {
    std::uint32_t module_index = 0;
    WGPUTextureFormat format = WGPUTextureFormat_Undefined;
    std::uint32_t samples = 1;
    std::uint32_t alpha_mode = 0;
    std::size_t extra_textures = 0;
    std::uint32_t uniform_binding = 0;
    std::uint32_t uniform_size = 0;
    DawnShaderModule module{};
    DawnBindGroupLayout group_layout{};
    DawnPipelineLayout pipeline_layout{};
    DawnRenderPipeline pipeline{};
};

inline DawnPostProcessProgram
build_dawn_post_process_program(WGPUDevice device, const upstream::PostProcessShaderInfo& info,
                                WGPUTextureFormat format, std::uint32_t samples,
                                std::uint32_t alpha_mode, std::size_t extra_textures,
                                std::uint32_t uniform_size) {
    DawnPostProcessProgram program;
    program.module_index = info.module_index;
    program.format = format;
    program.samples = samples;
    program.alpha_mode = alpha_mode;
    program.extra_textures = extra_textures;
    program.uniform_binding = info.uniform_binding;
    program.uniform_size = uniform_size;
    // Both stages live in one composed module, deployed once under the
    // fragment stem (the vertex stem is an alsoStages declaration carrying
    // only compiled artifacts), so the fragment file is the module.
    const std::string stem = "postprocess-" + std::to_string(info.module_index);
    const std::string vertex_stem = stem + ".vert", fragment_stem = stem + ".frag";
    program.module = load_wgsl_module(device, fragment_stem);
    // Group 0 as the module declares it: the source sampler and texture,
    // the program's extra textures, and its uniform block when it has one.
    const std::array<DawnLayoutStage, 2> stages{{
        {vertex_stem, WGPUShaderStage_Vertex},
        {fragment_stem, WGPUShaderStage_Fragment},
    }};
    program.group_layout = create_dawn_reflected_layout(device, stages, 0);
    WGPUPipelineLayoutDescriptor pipeline_layout = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    pipeline_layout.bindGroupLayoutCount = 1;
    const auto group_layout = program.group_layout.get();
    pipeline_layout.bindGroupLayouts = &group_layout;
    program.pipeline_layout = require_dawn_resource(
        wgpuDeviceCreatePipelineLayout(device, &pipeline_layout), "pass pipeline layout");
    // The generated table names the pin's factors; turning them into this
    // API's enums is the backend's own `blend_state_from`.
    const upstream::PostProcessBlend blend = upstream::post_process_blend(alpha_mode);
    const WGPUBlendState blend_state = blend_state_from(blend.factors);
    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = format;
    if (blend.enabled)
        color_target.blend = &blend_state;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = program.module;
    fragment.entryPoint = string_view("postProcessFragment");
    fragment.targetCount = 1;
    fragment.targets = &color_target;
    WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = program.pipeline_layout;
    descriptor.vertex.module = program.module;
    descriptor.vertex.entryPoint = string_view("postProcessVertex");
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.cullMode = WGPUCullMode_None;
    // The pin builds the pipeline against its output target's own sample
    // count and resolves nothing; what it refuses is a multisampled *source*.
    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    descriptor.fragment = &fragment;
    program.pipeline = wgpuDeviceCreateRenderPipeline(device, &descriptor);
    if (!program.pipeline) {
        dawn_error("post-process pipeline creation failed.");
    }
    return program;
}

} // namespace bbl::pal
#endif

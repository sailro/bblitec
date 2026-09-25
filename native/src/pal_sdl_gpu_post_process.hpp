#pragma once
#include <bblite/features/has_post_process.hpp>
#include "pal_sdl_gpu_shared.hpp"

#if BBLITE_HAS_POST_PROCESS
#include <bblite/upstream/frame_graph_post_process.hpp>
#include <bblite/upstream/post_process_shaders.hpp>

namespace bbl::pal {

struct GpuPostProcessProgram {
    std::uint32_t module_index = 0;
    SDL_GPUTextureFormat format = SDL_GPU_TEXTUREFORMAT_INVALID;
    SDL_GPUSampleCount samples = SDL_GPU_SAMPLECOUNT_1;
    std::uint32_t alpha_mode = 0;
    OwnedSdlPipeline pipeline;
    PinnedStageSlots vertex_slots;
    PinnedStageSlots fragment_slots;
};

inline GpuPostProcessProgram build_sdl_gpu_post_process_program(SDL_GPUDevice* device,
                                                                std::uint32_t module_index,
                                                                SDL_GPUTextureFormat format,
                                                                SDL_GPUSampleCount samples,
                                                                std::uint32_t alpha_mode) {
    GpuPostProcessProgram program;
    program.module_index = module_index;
    program.format = format;
    program.samples = samples;
    program.alpha_mode = alpha_mode;
    const std::string stem = "postprocess-" + std::to_string(module_index);
    const std::string vertex_name = stem + ".vert";
    const std::string fragment_name = stem + ".frag";
    program.vertex_slots = read_pinned_stage_slots(vertex_name);
    program.fragment_slots = read_pinned_stage_slots(fragment_name);
    auto vertex_shader =
        load_shader(device, vertex_name, SDL_GPU_SHADERSTAGE_VERTEX, program.vertex_slots);
    auto fragment_shader =
        load_shader(device, fragment_name, SDL_GPU_SHADERSTAGE_FRAGMENT, program.fragment_slots);
    // The generated table names the pin's factors; turning them into this
    // API's enums is the backend's own `blend_state_from`.
    const upstream::PostProcessBlend blend = upstream::post_process_blend(alpha_mode);
    SDL_GPUColorTargetDescription target{};
    target.format = format;
    if (blend.enabled) {
        target.blend_state = blend_state_from(blend.factors);
    }
    SDL_GPUGraphicsPipelineCreateInfo info{};
    info.vertex_shader = vertex_shader.get();
    info.fragment_shader = fragment_shader.get();
    info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
    info.multisample_state.sample_count = samples;
    info.target_info.color_target_descriptions = &target;
    info.target_info.num_color_targets = 1;
    program.pipeline = OwnedSdlPipeline{create_sdl_gpu_graphics_pipeline(device, &info), {device}};
    if (!program.pipeline) {
        gpu_error("SDL_CreateGPUGraphicsPipeline post-process");
    }
    return program;
}

} // namespace bbl::pal
#endif

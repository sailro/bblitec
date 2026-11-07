#pragma once
// A pinned GPU program's full-screen SDL_GPU pipeline. The screen-space
// stages and the SSAO render programs build theirs here; Dawn's twin is
// pal_dawn_pinned_program.hpp.

#include "pal_sdl_gpu_error.hpp"
#include "pal_sdl_gpu_resources.hpp"

#include <span>
#include <vector>

namespace bbl::pal {

/**
 * A full-screen pass's pipeline over two compiled stages: a triangle list,
 * no cull, one sample, unblended targets of `formats`.
 */
inline OwnedSdlPipeline
create_sdl_fullscreen_pipeline(SDL_GPUDevice* device, const OwnedSdlShader& vertex,
                               const OwnedSdlShader& fragment,
                               std::span<const SDL_GPUTextureFormat> formats, const char* what) {
    std::vector<SDL_GPUColorTargetDescription> targets;
    targets.reserve(formats.size());
    for (const SDL_GPUTextureFormat format : formats) {
        SDL_GPUColorTargetDescription target{};
        target.format = format;
        targets.push_back(target);
    }
    SDL_GPUGraphicsPipelineCreateInfo pipeline{};
    pipeline.vertex_shader = vertex.get();
    pipeline.fragment_shader = fragment.get();
    pipeline.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    pipeline.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    pipeline.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
    pipeline.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
    pipeline.target_info.color_target_descriptions = targets.data();
    pipeline.target_info.num_color_targets = static_cast<Uint32>(targets.size());
    OwnedSdlPipeline created{create_sdl_gpu_graphics_pipeline(device, vertex, &pipeline), {device}};
    if (!created)
        gpu_error(what);
    return created;
}

} // namespace bbl::pal

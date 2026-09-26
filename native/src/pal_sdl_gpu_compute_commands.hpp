#pragma once
#include <bblite/features/compute_mipmaps.hpp>
#include <bblite/features/compute_shaders.hpp>
#include <bblite/features/gpu_task_timing.hpp>

#include <bblite/pal_offscreen.hpp>
#include "pal_sdl_gpu_shared.hpp"
#if BBLITE_GPU_TASK_TIMING
#include "pal_sdl_gpu_timestamp.hpp"
#endif
#if BBLITE_COMPUTE_SHADERS
#include "pal_sdl_gpu_compute_pipeline.hpp"
#endif
#if BBLITE_COMPUTE_MIPMAPS
#include "pal_sdl_gpu_compute_mipmaps.hpp"
#endif

namespace bbl::pal {
/** Separate dependent passes retain SDL resource transitions within one submission. */
inline void submit_sdl_gpu_compute_commands(SDL_GPUDevice* device,
                                            std::span<const ComputeCommand> commands) {
    if (commands.empty())
        return;
    SdlGpuCommand encoder{SDL_AcquireGPUCommandBuffer(device)};
    if (!encoder)
        gpu_error("SDL_AcquireGPUCommandBuffer compute command list");
#if BBLITE_COMPUTE_SHADERS
    SdlComputeBindingScratch scratch;
#endif
    for (const auto& command : commands) {
        if (const auto* dispatch = std::get_if<ComputeDispatch>(&command)) {
#if BBLITE_COMPUTE_SHADERS
            encode_sdl_gpu_compute(encoder, *dispatch, scratch);
#else
            (void)dispatch;
            throw std::runtime_error("This build does not provide compute dispatch.");
#endif
        } else if (const auto* timestamp = std::get_if<GpuTimestampWrite>(&command)) {
#if BBLITE_GPU_TASK_TIMING
            encode_sdl_gpu_timestamp(encoder, *timestamp);
#else
            (void)timestamp;
            throw std::runtime_error("This build does not provide GPU timestamps.");
#endif
        } else {
#if BBLITE_COMPUTE_MIPMAPS
            const auto& mip = std::get<ComputeMipmapDraw>(command);
            const auto* level = dynamic_cast<const SdlComputeMipmapLevel*>(mip.level.get());
            if (!level || level->device != device)
                throw std::runtime_error("Mipmap level belongs to a different GPU device.");
            level->encode(encoder, mip.vertices);
#else
            throw std::runtime_error("This build does not provide compute texture mipmaps.");
#endif
        }
    }
    if (!encoder.submit())
        gpu_error("SDL_SubmitGPUCommandBuffer compute command list");
}
} // namespace bbl::pal

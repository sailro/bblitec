#pragma once
#include <bblite/features/compute_mipmaps.hpp>
#include <bblite/features/compute_shaders.hpp>
#include <bblite/features/gpu_task_timing.hpp>

#include <bblite/pal_offscreen.hpp>
#include "pal_dawn_resources.hpp"
#if BBLITE_GPU_TASK_TIMING
#include "pal_dawn_gpu_timestamp.hpp"
#endif
#if BBLITE_COMPUTE_SHADERS
#include "pal_dawn_compute_pipeline.hpp"
#endif
#if BBLITE_COMPUTE_MIPMAPS
#include "pal_dawn_compute_mipmaps.hpp"
#endif

namespace bbl::pal {
/** Preserve pass boundaries while submitting the source command list once. */
inline void submit_dawn_compute_commands(WGPUDevice device, WGPUQueue queue,
                                         std::span<const ComputeCommand> commands) {
    if (commands.empty())
        return;
    DawnCommandEncoder encoder{require_dawn_resource(
        wgpuDeviceCreateCommandEncoder(device, nullptr), "compute command list encoder")};
    for (const auto& command : commands) {
        if (const auto* dispatch = std::get_if<ComputeDispatch>(&command)) {
#if BBLITE_COMPUTE_SHADERS
            encode_dawn_compute(encoder, *dispatch);
#else
            (void)dispatch;
            throw std::runtime_error("This build does not provide compute dispatch.");
#endif
        } else if (const auto* mip = std::get_if<ComputeMipmapDraw>(&command)) {
#if BBLITE_COMPUTE_MIPMAPS
            const auto* level = dynamic_cast<const DawnComputeMipmapLevel*>(mip->level.get());
            if (!level || level->device != device)
                throw std::runtime_error("Mipmap level belongs to a different GPU device.");
            level->encode(encoder, mip->vertices);
#else
            (void)mip;
            throw std::runtime_error("This build does not provide compute texture mipmaps.");
#endif
        } else {
#if BBLITE_GPU_TASK_TIMING
            encode_dawn_gpu_timestamp(encoder, std::get<GpuTimestampWrite>(command));
#else
            throw std::runtime_error("This build does not provide GPU timestamps.");
#endif
        }
    }
    DawnCommandBuffer submitted{
        require_dawn_resource(wgpuCommandEncoderFinish(encoder, nullptr), "compute command list")};
    submit_dawn_command(queue, submitted);
}
} // namespace bbl::pal

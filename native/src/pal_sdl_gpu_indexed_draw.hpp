#pragma once

#include "pal_gpu_common.hpp"
#include <SDL3/SDL_gpu.h>

namespace bbl::pal {

static_assert(sizeof(SDL_GPUIndexedIndirectDrawCommand) == 5 * sizeof(std::uint32_t));
static_assert(offsetof(SDL_GPUIndexedIndirectDrawCommand, vertex_offset) ==
              3 * sizeof(std::uint32_t));

inline void encode_sdl_gpu_indexed_draw(SDL_GPURenderPass* pass, Uint32 index_count,
                                        Uint32 instance_count, SDL_GPUBuffer* indirect_args) {
    if (indirect_args) {
        count_gpu_draw(SDL_DrawGPUIndexedPrimitivesIndirect, pass, indirect_args, 0, 1);
    } else if (index_count != 0 && instance_count != 0) {
        // Empty direct draws do no work; Metal requires both counts to be nonzero.
        count_gpu_draw(SDL_DrawGPUIndexedPrimitives, pass, index_count, instance_count, 0, 0, 0);
    }
}

} // namespace bbl::pal

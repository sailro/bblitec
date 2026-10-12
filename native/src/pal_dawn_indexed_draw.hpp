#pragma once

#include "pal_gpu_common.hpp"
#include <webgpu/webgpu.h>

namespace bbl::pal {

inline void encode_dawn_indexed_draw(WGPURenderPassEncoder pass, std::uint32_t index_count,
                                     std::uint32_t instance_count, WGPUBuffer indirect_args) {
    if (indirect_args) {
        count_gpu_draw(wgpuRenderPassEncoderDrawIndexedIndirect, pass, indirect_args, 0);
    } else {
        count_gpu_draw(wgpuRenderPassEncoderDrawIndexed, pass, index_count, instance_count, 0, 0,
                       0);
    }
}

} // namespace bbl::pal

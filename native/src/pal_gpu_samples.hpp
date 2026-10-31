// The engine surface's sample count, one rule for every renderer.
#pragma once

#include <bblite/upstream/pinned_surface.hpp>

#include "pal_gpu_frame.hpp"

#include <cstdint>

namespace bbl::pal {
/**
 * The engine surface's sample count: the pin's (`msaaSamples === 1 ? 1 : 4`), or 1 for a
 * BBLITE_MSAA=1 diagnostic run.
 */
inline std::uint32_t surface_sample_count(const FrameOptions& options, std::uint32_t msaa_samples) {
    return options.single_sample ? 1u : upstream::preferred_sample_count(msaa_samples);
}
} // namespace bbl::pal

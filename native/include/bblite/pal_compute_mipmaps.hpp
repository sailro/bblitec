#pragma once
#include <bblite/pal_compute_texture.hpp>

namespace bbl::pal {
struct ComputeMipmapPipeline {
    virtual ~ComputeMipmapPipeline() = default;
};
/** A reusable sampled view, target view and native draw binding. */
struct ComputeMipmapLevel {
    virtual ~ComputeMipmapLevel() = default;
    virtual void submit(std::uint32_t vertices) = 0;
};
struct ComputeMipmapDraw {
    std::shared_ptr<ComputeMipmapLevel> level;
    std::uint32_t vertices = 0;
};
} // namespace bbl::pal

#pragma once
#include <bblite/text.hpp>
#include <bblite/upstream_text_pipeline.hpp>

namespace bbl::pal {

inline const upstream::TextPipelineInfo& text_pipeline_info(
    std::uint32_t samples, bool has_depth, bool depth_write, bool alpha_to_coverage) {
    for (const auto& row : upstream::text_pipeline_rows) {
        if (row.sample_count == samples && row.has_depth == has_depth && row.depth_write == depth_write &&
            row.alpha_to_coverage == alpha_to_coverage) return row;
    }
    throw std::runtime_error("Text target signature has no composed pipeline.");
}

} // namespace bbl::pal

#pragma once
#include <bblite/text.hpp>
#include <bblite/upstream_text_pipeline.hpp>
#include "pal_text_capture.hpp"

namespace bbl::pal {

inline const char* text_blend_factor_name(BlendFactor factor) {
    switch (factor) {
        case BlendFactor::one: return "one";
        case BlendFactor::src_alpha: return "src-alpha";
        case BlendFactor::one_minus_src_alpha: return "one-minus-src-alpha";
    }
    throw std::runtime_error("Unmapped text blend factor.");
}

inline TextGpuDrawCapture text_pipeline_capture(const upstream::TextPipelineInfo& info,
    std::string color, std::string depth) {
    TextGpuDrawCapture result;
    result.color_format = std::move(color); result.depth_format = std::move(depth);
    result.samples = info.sample_count; result.depth_write = info.depth_write;
    if (info.depth_compare != DepthCompare::greater_equal) throw std::runtime_error("Unmapped text depth compare.");
    result.depth_compare = info.has_depth ? "greater-equal" : "";
    result.blend_enabled = info.blend_enabled; result.alpha_to_coverage = info.alpha_to_coverage;
    result.topology = info.topology; result.cull_mode = info.cull_mode; result.front_face = info.front_face;
    result.sample_mask = 0xffffffffu;
    if (info.blend_enabled) {
        result.color_src_factor = text_blend_factor_name(info.blend.src_color);
        result.color_dst_factor = text_blend_factor_name(info.blend.dst_color);
        result.alpha_src_factor = text_blend_factor_name(info.blend.src_alpha);
        result.alpha_dst_factor = text_blend_factor_name(info.blend.dst_alpha);
        result.color_operation = result.alpha_operation = "add";
    }
    for (const auto& row : info.vertex_constants) result.vertex_constants.push_back({row.id, row.value});
    for (const auto& row : info.fragment_constants) result.fragment_constants.push_back({row.id, row.value});
    return result;
}

inline const upstream::TextPipelineInfo& text_pipeline_info(
    std::uint32_t samples, bool has_depth, bool depth_write, bool alpha_to_coverage, bool weighted = false) {
    for (const auto& row : upstream::text_pipeline_rows) {
        if (row.sample_count == samples && row.has_depth == has_depth && row.depth_write == depth_write &&
            row.alpha_to_coverage == alpha_to_coverage && row.weighted == weighted) return row;
    }
    throw std::runtime_error("Text target signature has no composed pipeline.");
}

} // namespace bbl::pal

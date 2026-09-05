#pragma once

#include <bblite/pal_ui.hpp>
#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

namespace bbl::pal {

using UiClipPoint = std::array<float, 2>;
using UiClipTriangle = std::array<UiClipPoint, 3>;

inline float ui_clip_side(UiClipPoint a, UiClipPoint b, UiClipPoint p) {
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

/** Intersect triangulated masks without assuming a particular DOM box shape. */
inline std::vector<UiClipTriangle> intersect_ui_masks(
    const std::vector<UiClipTriangle>& left,
    const std::vector<UiClipTriangle>& right) {
    std::vector<UiClipTriangle> result;
    result.reserve(left.size() * right.size() * 4);
    for (const auto& a : left) for (const auto& b : right) {
        const float orientation = ui_clip_side(b[0], b[1], b[2]);
        if (std::abs(orientation) < 1e-6f) continue;
        const float sign = orientation > 0 ? 1.0f : -1.0f;
        std::array<UiClipPoint, 6> polygon{};
        std::copy(a.begin(), a.end(), polygon.begin());
        std::size_t polygon_size = a.size();
        for (std::size_t edge = 0; edge < 3 && polygon_size > 0; ++edge) {
            std::array<UiClipPoint, 6> clipped{};
            std::size_t clipped_size = 0;
            UiClipPoint previous = polygon[polygon_size - 1];
            float previous_side = sign * ui_clip_side(b[edge], b[(edge + 1) % 3], previous);
            for (std::size_t index = 0; index < polygon_size; ++index) {
                const UiClipPoint point = polygon[index];
                const float side = sign * ui_clip_side(b[edge], b[(edge + 1) % 3], point);
                if ((side >= 0) != (previous_side >= 0)) {
                    const float amount = previous_side / (previous_side - side);
                    clipped[clipped_size++] = {
                        previous[0] + amount * (point[0] - previous[0]),
                        previous[1] + amount * (point[1] - previous[1])};
                }
                if (side >= 0) clipped[clipped_size++] = point;
                previous = point;
                previous_side = side;
            }
            polygon = clipped;
            polygon_size = clipped_size;
        }
        for (std::size_t i = 2; i < polygon_size; ++i) {
            if (std::abs(ui_clip_side(polygon[0], polygon[i - 1], polygon[i])) > 1e-6f)
                result.push_back({polygon[0], polygon[i - 1], polygon[i]});
        }
    }
    return result;
}

inline std::vector<UiClipTriangle> ui_rect_mask(float left, float top, float right, float bottom) {
    return {{{{left, top}, {right, top}, {right, bottom}}},
            {{{left, top}, {right, bottom}, {left, bottom}}}};
}

struct UiBlurKernel {
    float sigma = 0;
    float reduction = 1;
    int radius = 0;
    std::array<int, 19> taps{};
};

inline UiBlurKernel make_ui_blur_kernel(float sigma) {
    UiBlurKernel kernel;
    kernel.sigma = sigma;
    kernel.reduction = std::max(1.0f, std::floor(sigma / 3.0f));
    const float reduced_sigma = sigma / kernel.reduction;
    kernel.radius = std::max(1, static_cast<int>(std::ceil(3.0f * reduced_sigma)));
    std::array<double, 19> weights{};
    double sum = 0;
    for (int i = 0; i <= kernel.radius; ++i) {
        weights[i] = std::exp(-double(i * i) / (2.0 * reduced_sigma * reduced_sigma));
        sum += weights[i] * (i == 0 ? 1 : 2);
    }
    int side_weight = 0;
    for (int i = 1; i <= kernel.radius; ++i) {
        kernel.taps[i] = static_cast<int>(std::lround(255.0 * weights[i] / sum));
        side_weight += kernel.taps[i];
    }
    kernel.taps[0] = 255 - 2 * side_weight;
    return kernel;
}

/**
 * Gaussian convolution through stock textured UI geometry: overlapping tap
 * quads add into an FP16 target. Q8 tap weights sum to exactly one, preserving
 * constant colors and avoiding a separate shader dialect in either backend.
 * Like RmlUi's GL3 renderer, reduce the working resolution for large sigma.
 */
inline void append_ui_backdrop_geometry(
    UiRenderFrame& frame, UiBackdrop& backdrop, const UiBlurKernel& kernel,
    const std::vector<UiClipTriangle>& mask) {
    backdrop.blur_width = std::max(1u, static_cast<std::uint32_t>(
        std::ceil(backdrop.width / kernel.reduction)));
    backdrop.blur_height = std::max(1u, static_cast<std::uint32_t>(
        std::ceil(backdrop.height / kernel.reduction)));
    const auto quad = [&](float u0, float v0, float u1, float v1, std::uint8_t weight) {
        const auto first = frame.vertices.size();
        append_ui_quad(frame, 0, 0, static_cast<float>(frame.width), static_cast<float>(frame.height), weight);
        const std::array<std::array<float, 2>, 4> uv{{{u0, v0}, {u1, v0}, {u1, v1}, {u0, v1}}};
        for (std::size_t i = 0; i < 4; ++i) {
            auto& vertex = frame.vertices[first + i];
            vertex.alpha = weight;
            vertex.u = uv[i][0];
            vertex.v = uv[i][1];
        }
    };
    backdrop.sample_index = static_cast<std::uint32_t>(frame.indices.size());
    quad(0, 0, 1, 1, 255);
    for (int axis = 0; axis < 2; ++axis) {
        const auto first = static_cast<std::uint32_t>(frame.indices.size());
        for (int i = -kernel.radius; i <= kernel.radius; ++i) {
            const int weight = kernel.taps[std::abs(i)];
            if (weight <= 0) continue;
            const float u = axis == 0 ? float(i) / backdrop.blur_width : 0;
            const float v = axis == 1 ? float(i) / backdrop.blur_height : 0;
            quad(u, v, 1 + u, 1 + v, static_cast<std::uint8_t>(weight));
        }
        if (axis == 0) {
            backdrop.kernel_index_count =
                static_cast<std::uint32_t>(frame.indices.size()) - first;
        }
    }
    const auto composite_index =
        static_cast<std::uint32_t>(frame.indices.size());
    for (const auto& triangle : mask) for (const auto& point : triangle) {
        frame.indices.push_back(static_cast<std::uint32_t>(frame.vertices.size()));
        frame.vertices.push_back(UiRenderVertex{point[0], point[1], 255, 255, 255, 255,
            (point[0] - backdrop.left) / backdrop.width, (point[1] - backdrop.top) / backdrop.height});
    }
    backdrop.composite_index_count =
        static_cast<std::uint32_t>(frame.indices.size()) - composite_index;
}

} // namespace bbl::pal

#pragma once

#include <bblite/pal_ui.hpp>
#include <algorithm>
#include <array>
#include <cmath>
#include <span>
#include <vector>

namespace bbl::pal {

template <class Pair, class Snapshot, class Blur>
void sync_ui_backdrop_targets(Pair& pair, const UiBackdrop& backdrop, bool has_snapshot,
                              bool has_blur, Snapshot&& snapshot, Blur&& blur) {
    if (!has_snapshot || pair.source_width != backdrop.width ||
        pair.source_height != backdrop.height) {
        snapshot(backdrop.width, backdrop.height);
        pair.source_width = backdrop.width;
        pair.source_height = backdrop.height;
    }
    if (!has_blur || pair.blur_width != backdrop.blur_width ||
        pair.blur_height != backdrop.blur_height) {
        blur(backdrop.blur_width, backdrop.blur_height);
        pair.blur_width = backdrop.blur_width;
        pair.blur_height = backdrop.blur_height;
    }
}

enum class UiBackdropSurface : std::size_t { target, snapshot, first, second };
struct UiBackdropDraw {
    UiBackdropSurface output, input;
    std::uint32_t first, count;
};
inline std::array<UiBackdropDraw, 4> ui_backdrop_draw_plan(const UiBackdrop& backdrop) {
    using Surface = UiBackdropSurface;
    return {
        {{Surface::first, Surface::snapshot, backdrop.sample_index, UiBackdrop::sample_index_count},
         {Surface::second, Surface::first, backdrop.horizontal_index(),
          backdrop.kernel_index_count},
         {Surface::first, Surface::second, backdrop.vertical_index(), backdrop.kernel_index_count},
         {Surface::target, Surface::first, backdrop.composite_index(),
          backdrop.composite_index_count}}};
}

using UiClipPoint = std::array<float, 2>;
using UiClipTriangle = std::array<UiClipPoint, 3>;

inline float ui_clip_side(UiClipPoint a, UiClipPoint b, UiClipPoint p) {
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

/** Clip one convex polygon against an oriented half-plane. */
inline void clip_ui_polygon(const std::vector<UiClipPoint>& polygon, UiClipPoint a, UiClipPoint b,
                            float sign, std::vector<UiClipPoint>& result) {
    result.clear();
    if (polygon.empty())
        return;
    auto previous = polygon.back();
    float previous_side = sign * ui_clip_side(a, b, previous);
    for (const auto point : polygon) {
        const float side = sign * ui_clip_side(a, b, point);
        if ((side >= 0) != (previous_side >= 0)) {
            const float amount = previous_side / (previous_side - side);
            result.push_back({previous[0] + amount * (point[0] - previous[0]),
                              previous[1] + amount * (point[1] - previous[1])});
        }
        if (side >= 0)
            result.push_back(point);
        previous = point;
        previous_side = side;
    }
}

inline void triangulate_ui_polygon(std::vector<UiClipTriangle>& result,
                                   const std::vector<UiClipPoint>& polygon) {
    for (std::size_t i = 2; i < polygon.size(); ++i) {
        const auto a = polygon[0], b = polygon[i - 1], c = polygon[i];
        const float longest =
            std::max({std::hypot(a[0] - b[0], a[1] - b[1]), std::hypot(a[0] - c[0], a[1] - c[1]),
                      std::hypot(b[0] - c[0], b[1] - c[1])});
        // Subtracting adjacent mask triangles can leave a roundoff sliver on
        // their shared edge. It has no pixel coverage but may hit an exact
        // sample location unless rejected by a distance-based tolerance.
        if (std::abs(ui_clip_side(a, b, c)) > longest * .0001f)
            result.push_back({a, b, c});
    }
}

struct UiClipScratch {
    std::vector<UiClipPoint> polygon, clipped;

    UiClipScratch() {
        polygon.reserve(8);
        clipped.reserve(8);
    }
};

inline bool ui_clip_triangles_overlap(const UiClipTriangle& a, const UiClipTriangle& b) {
    for (std::size_t axis = 0; axis < 2; ++axis) {
        const auto minimum_a = std::min({a[0][axis], a[1][axis], a[2][axis]});
        const auto maximum_a = std::max({a[0][axis], a[1][axis], a[2][axis]});
        const auto minimum_b = std::min({b[0][axis], b[1][axis], b[2][axis]});
        const auto maximum_b = std::max({b[0][axis], b[1][axis], b[2][axis]});
        // Touching bounds still pass through the existing clipping tolerances.
        if (maximum_a < minimum_b || maximum_b < minimum_a)
            return false;
    }
    return true;
}

inline void append_ui_mask_intersection(std::vector<UiClipTriangle>& result,
                                        std::span<const UiClipTriangle> left,
                                        std::span<const UiClipTriangle> right,
                                        UiClipScratch& scratch) {
    for (const auto& a : left)
        for (const auto& b : right) {
            if (!ui_clip_triangles_overlap(a, b))
                continue;
            const float orientation = ui_clip_side(b[0], b[1], b[2]);
            if (std::abs(orientation) < 1e-6f)
                continue;
            const float sign = orientation > 0 ? 1.f : -1.f;
            scratch.polygon.assign(a.begin(), a.end());
            for (std::size_t edge = 0; edge < 3 && !scratch.polygon.empty(); ++edge) {
                clip_ui_polygon(scratch.polygon, b[edge], b[(edge + 1) % 3], sign, scratch.clipped);
                scratch.polygon.swap(scratch.clipped);
            }
            triangulate_ui_polygon(result, scratch.polygon);
        }
}

/** Intersect triangulated masks without assuming a particular DOM box shape. */
inline std::vector<UiClipTriangle> intersect_ui_masks(const std::vector<UiClipTriangle>& left,
                                                      const std::vector<UiClipTriangle>& right) {
    std::vector<UiClipTriangle> result;
    UiClipScratch scratch;
    append_ui_mask_intersection(result, left, right, scratch);
    return result;
}

/** Subtract each mask triangle, retaining disjoint outside pieces at each edge. */
inline std::vector<UiClipTriangle> subtract_ui_masks(std::vector<UiClipTriangle> left,
                                                     const std::vector<UiClipTriangle>& right) {
    UiClipScratch scratch;
    for (const auto& b : right) {
        const float orientation = ui_clip_side(b[0], b[1], b[2]);
        if (std::abs(orientation) < 1e-6f)
            continue;
        const float sign = orientation > 0 ? 1.f : -1.f;
        std::vector<UiClipTriangle> remaining;
        for (const auto& a : left) {
            scratch.polygon.assign(a.begin(), a.end());
            for (std::size_t edge = 0; edge < 3 && !scratch.polygon.empty(); ++edge) {
                clip_ui_polygon(scratch.polygon, b[edge], b[(edge + 1) % 3], -sign,
                                scratch.clipped);
                triangulate_ui_polygon(remaining, scratch.clipped);
                clip_ui_polygon(scratch.polygon, b[edge], b[(edge + 1) % 3], sign, scratch.clipped);
                scratch.polygon.swap(scratch.clipped);
            }
        }
        left = std::move(remaining);
    }
    return left;
}

/** Preserve attributes when a recorded draw is clipped to the same mask as composites. */
inline void clip_ui_geometry(UiRenderFrame& frame, std::uint32_t first_vertex,
                             std::uint32_t first_index, const std::vector<UiClipTriangle>& mask) {
    std::vector<UiRenderVertex> vertices;
    std::vector<UiClipTriangle> clipped_triangles;
    UiClipScratch scratch;
    for (std::size_t i = first_index; i + 2 < frame.indices.size(); i += 3) {
        const std::array source{frame.vertices.at(frame.indices[i]),
                                frame.vertices.at(frame.indices[i + 1]),
                                frame.vertices.at(frame.indices[i + 2])};
        const UiClipTriangle triangle{
            {{source[0].x, source[0].y}, {source[1].x, source[1].y}, {source[2].x, source[2].y}}};
        const float area = ui_clip_side(triangle[0], triangle[1], triangle[2]);
        if (std::abs(area) < 1e-6f)
            continue;
        clipped_triangles.clear();
        append_ui_mask_intersection(clipped_triangles, std::span(&triangle, 1), mask, scratch);
        for (const auto& clipped : clipped_triangles)
            for (const auto point : clipped) {
                const float a = ui_clip_side(triangle[1], triangle[2], point) / area;
                const float b = ui_clip_side(triangle[2], triangle[0], point) / area;
                const float c = 1 - a - b;
                const auto number = [&](auto field) {
                    return a * (source[0].*field) + b * (source[1].*field) + c * (source[2].*field);
                };
                const auto color = [&](auto field) {
                    return static_cast<std::uint8_t>(
                        std::clamp(std::lround(number(field)), 0l, 255l));
                };
                vertices.push_back({point[0], point[1], color(&UiRenderVertex::red),
                                    color(&UiRenderVertex::green), color(&UiRenderVertex::blue),
                                    color(&UiRenderVertex::alpha), number(&UiRenderVertex::u),
                                    number(&UiRenderVertex::v)});
            }
    }
    frame.vertices.resize(first_vertex);
    frame.indices.resize(first_index);
    for (const auto& vertex : vertices) {
        frame.indices.push_back(static_cast<std::uint32_t>(frame.vertices.size()));
        frame.vertices.push_back(vertex);
    }
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
inline void append_ui_backdrop_geometry(UiRenderFrame& frame, UiBackdrop& backdrop,
                                        const UiBlurKernel& kernel,
                                        const std::vector<UiClipTriangle>& mask) {
    backdrop.blur_width =
        std::max(1u, static_cast<std::uint32_t>(std::ceil(backdrop.width / kernel.reduction)));
    backdrop.blur_height =
        std::max(1u, static_cast<std::uint32_t>(std::ceil(backdrop.height / kernel.reduction)));
    const auto quad = [&](float u0, float v0, float u1, float v1, std::uint8_t weight) {
        const auto first = frame.vertices.size();
        append_ui_quad(frame, 0, 0, static_cast<float>(frame.width),
                       static_cast<float>(frame.height), weight);
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
            if (weight <= 0)
                continue;
            const float u = axis == 0 ? float(i) / backdrop.blur_width : 0;
            const float v = axis == 1 ? float(i) / backdrop.blur_height : 0;
            quad(u, v, 1 + u, 1 + v, static_cast<std::uint8_t>(weight));
        }
        if (axis == 0) {
            backdrop.kernel_index_count = static_cast<std::uint32_t>(frame.indices.size()) - first;
        }
    }
    const auto composite_index = static_cast<std::uint32_t>(frame.indices.size());
    for (const auto& triangle : mask)
        for (const auto& point : triangle) {
            frame.indices.push_back(static_cast<std::uint32_t>(frame.vertices.size()));
            frame.vertices.push_back(UiRenderVertex{point[0], point[1], 255, 255, 255, 255,
                                                    (point[0] - backdrop.left) / backdrop.width,
                                                    (point[1] - backdrop.top) / backdrop.height});
        }
    backdrop.composite_index_count =
        static_cast<std::uint32_t>(frame.indices.size()) - composite_index;
}

} // namespace bbl::pal

#pragma once

#include "pal_gpu_ui.hpp"
#include "pal_ui_filter.hpp"

namespace bbl::pal {

/** Only an alpha multiplier can move from a group composite into its geometry. */
inline std::optional<float> ui_group_alpha(std::span<const UiFilter> filters) {
    float alpha = 1;
    for (const auto& filter : filters) {
        if (filter.kind != UiFilterKind::Color || filter.offset != std::array<float, 4>{})
            return std::nullopt;
        const auto expected = color_ui_filter("opacity", filter.matrix[15]);
        if (filter.matrix != expected.matrix)
            return std::nullopt;
        alpha *= filter.matrix[15];
    }
    return alpha < 1 ? std::optional(alpha) : std::nullopt;
}

/** Apply a group's final clipping before distributing its alpha across direct draws. */
inline void clip_ui_group(UiRenderFrame& frame, std::size_t first_draw, std::size_t first_vertex,
                          std::size_t first_index, const std::vector<UiClipTriangle>& mask) {
    std::vector<UiRenderVertex> vertices;
    std::vector<UiClipTriangle> pieces;
    UiClipScratch scratch;
    for (std::size_t d = first_draw; d < frame.draws.size(); ++d) {
        auto& draw = frame.draws[d];
        const auto begin = vertices.size();
        for (std::size_t i = draw.first_index; i + 2 < draw.first_index + draw.index_count; i += 3)
            append_clipped_ui_triangle(vertices, recorded_ui_triangle(frame, i), mask, pieces,
                                       scratch);
        draw.first_index = static_cast<std::uint32_t>(first_index + begin);
        draw.index_count = static_cast<std::uint32_t>(vertices.size() - begin);
    }
    frame.vertices.resize(first_vertex);
    frame.indices.resize(first_index);
    for (const auto& vertex : vertices) {
        frame.indices.push_back(static_cast<std::uint32_t>(frame.vertices.size()));
        frame.vertices.push_back(vertex);
    }
}

/**
 * Test painted triangles, not DOM boxes: touching edges do not overlap, while overlapping
 * glyphs or triangles inside a single draw still require group composition. The sweep keeps
 * separated geometry out of the polygon intersection test.
 */
inline bool ui_paint_overlaps(const UiRenderFrame& frame, std::size_t first_draw) {
    struct Triangle {
        UiClipTriangle points;
        float left, top, right, bottom;
    };
    std::vector<Triangle> triangles;
    for (std::size_t d = first_draw; d < frame.draws.size(); ++d) {
        const auto& draw = frame.draws[d];
        const auto scissor = clamped_ui_scissor(draw, frame.width, frame.height);
        if (!scissor)
            continue;
        for (std::size_t i = draw.first_index; i + 2 < draw.first_index + draw.index_count;
             i += 3) {
            const auto vertices = recorded_ui_triangle(frame, i);
            if (!vertices[0].alpha && !vertices[1].alpha && !vertices[2].alpha)
                continue;
            Triangle triangle{{{{vertices[0].x, vertices[0].y},
                                {vertices[1].x, vertices[1].y},
                                {vertices[2].x, vertices[2].y}}},
                              std::max(float(scissor->left),
                                       std::min({vertices[0].x, vertices[1].x, vertices[2].x})),
                              std::max(float(scissor->top),
                                       std::min({vertices[0].y, vertices[1].y, vertices[2].y})),
                              std::min(float(scissor->left + scissor->width),
                                       std::max({vertices[0].x, vertices[1].x, vertices[2].x})),
                              std::min(float(scissor->top + scissor->height),
                                       std::max({vertices[0].y, vertices[1].y, vertices[2].y}))};
            if (triangle.right > triangle.left && triangle.bottom > triangle.top)
                triangles.push_back(triangle);
        }
    }
    std::sort(triangles.begin(), triangles.end(),
              [](const Triangle& a, const Triangle& b) { return a.left < b.left; });
    std::vector<const Triangle*> active;
    UiClipScratch scratch;
    std::vector<UiClipTriangle> intersection;
    for (const auto& triangle : triangles) {
        std::erase_if(active, [&](const Triangle* other) { return other->right <= triangle.left; });
        for (const auto* other : active) {
            if (other->bottom <= triangle.top || triangle.bottom <= other->top)
                continue;
            intersection.clear();
            append_ui_mask_intersection(intersection, std::span(&triangle.points, 1),
                                        std::span(&other->points, 1), scratch);
            if (!intersection.empty())
                return true;
        }
        active.push_back(&triangle);
    }
    return false;
}

/** Localize bounded layer geometry once, after CPU snapshots have finished recording. */
inline void localize_ui_layers(UiRenderFrame& frame) {
    if (frame.bounded_layers.empty())
        return;
    std::vector<bool> moved(frame.vertices.size());
    const auto move = [&](std::uint32_t first, std::uint32_t count, const PixelViewport& rect) {
        for (std::size_t i = first; i < first + count; ++i) {
            const auto index = frame.indices[i];
            if (moved[index])
                continue;
            moved[index] = true;
            frame.vertices[index].x -= rect.x;
            frame.vertices[index].y -= rect.y;
        }
    };
    for (auto& draw : frame.draws) {
        const auto rect = ui_layer_target(frame, draw.layer).rect;
        move(draw.first_index, draw.index_count, rect);
        draw.scissor_x -= rect.x;
        draw.scissor_y -= rect.y;
    }
    for (const auto& composite : frame.composites)
        move(composite.first_index, composite.index_count,
             ui_layer_target(frame, composite.destination).rect);
    for (auto& layer : frame.bounded_layers) {
        layer.composite_first_index = static_cast<std::uint32_t>(frame.indices.size());
        append_ui_quad(frame, 0, 0, float(layer.rect.width), float(layer.rect.height), 255);
    }
}

} // namespace bbl::pal

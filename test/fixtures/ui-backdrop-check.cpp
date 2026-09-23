#include "pal_ui_backdrop.hpp"
#include <cassert>
#include <cmath>
#include <iostream>
#include <numbers>

using namespace bbl::pal;

static double area(const std::vector<UiClipTriangle>& triangles) {
    double result = 0;
    for (const auto& t : triangles)
        result += std::abs(ui_clip_side(t[0], t[1], t[2])) * 0.5;
    return result;
}

// The allocation-heavy reference keeps the original operation order, including
// subtraction's outside fragments. Exact comparison guards raster edge behavior.
static std::vector<UiClipPoint> reference_clip(const std::vector<UiClipPoint>& polygon,
                                               UiClipPoint a, UiClipPoint b, float sign) {
    std::vector<UiClipPoint> result;
    if (polygon.empty())
        return result;
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
    return result;
}

static std::vector<UiClipTriangle> reference_intersect(const std::vector<UiClipTriangle>& left,
                                                       const std::vector<UiClipTriangle>& right) {
    std::vector<UiClipTriangle> result;
    for (const auto& a : left)
        for (const auto& b : right) {
            const float orientation = ui_clip_side(b[0], b[1], b[2]);
            if (std::abs(orientation) < 1e-6f)
                continue;
            const float sign = orientation > 0 ? 1.f : -1.f;
            std::vector<UiClipPoint> polygon(a.begin(), a.end());
            for (std::size_t edge = 0; edge < 3 && !polygon.empty(); ++edge)
                polygon = reference_clip(polygon, b[edge], b[(edge + 1) % 3], sign);
            triangulate_ui_polygon(result, polygon);
        }
    return result;
}

static std::vector<UiClipTriangle> reference_subtract(std::vector<UiClipTriangle> left,
                                                      const std::vector<UiClipTriangle>& right) {
    for (const auto& b : right) {
        const float orientation = ui_clip_side(b[0], b[1], b[2]);
        if (std::abs(orientation) < 1e-6f)
            continue;
        const float sign = orientation > 0 ? 1.f : -1.f;
        std::vector<UiClipTriangle> remaining;
        for (const auto& a : left) {
            std::vector<UiClipPoint> inside(a.begin(), a.end());
            for (std::size_t edge = 0; edge < 3 && !inside.empty(); ++edge) {
                triangulate_ui_polygon(remaining,
                                       reference_clip(inside, b[edge], b[(edge + 1) % 3], -sign));
                inside = reference_clip(inside, b[edge], b[(edge + 1) % 3], sign);
            }
        }
        left = std::move(remaining);
    }
    return left;
}

static void check_clip_replay() {
    std::uint32_t seed = 1337;
    const auto triangle = [&seed] {
        UiClipTriangle result;
        for (auto& point : result)
            for (auto& coordinate : point) {
                seed = seed * 1664525u + 1013904223u;
                coordinate = static_cast<float>(static_cast<int>(seed >> 16) - 32768) / 64.f;
            }
        return result;
    };
    for (int i = 0; i < 2000; ++i) {
        const std::vector<UiClipTriangle> a{triangle()}, b{triangle()};
        assert(intersect_ui_masks(a, b) == reference_intersect(a, b));
        assert(subtract_ui_masks(a, b) == reference_subtract(a, b));
    }

    std::vector<UiClipTriangle> round_mask;
    for (int i = 0; i < 32; ++i) {
        const auto point = [](int index) {
            const float angle = float(index) * 2.f * std::numbers::pi_v<float> / 32.f;
            return UiClipPoint{10.f + 8.f * std::cos(angle), 10.f + 8.f * std::sin(angle)};
        };
        round_mask.push_back({{{10.f, 10.f}, point(i), point(i + 1)}});
    }
    const auto rectangle = ui_rect_mask(3.5f, 4.25f, 16.5f, 17.25f);
    const auto nested = intersect_ui_masks(rectangle, round_mask);
    assert(nested == reference_intersect(rectangle, round_mask));
    assert(subtract_ui_masks(rectangle, round_mask) == reference_subtract(rectangle, round_mask));
    assert(intersect_ui_masks(nested, rectangle) == reference_intersect(nested, rectangle));

    for (const float offset : {0.f, 0.00001f, 0.0001f, 0.001f}) {
        const auto touching = ui_rect_mask(16.5f - offset, 4.25f, 20.f, 17.25f);
        assert(intersect_ui_masks(rectangle, touching) == reference_intersect(rectangle, touching));
        assert(subtract_ui_masks(rectangle, touching) == reference_subtract(rectangle, touching));
    }
}

static void check_clipped_attributes() {
    UiRenderFrame frame;
    append_ui_quad(frame, -5, -5, -1, -1, 255);
    const auto prefix = frame.vertices;
    frame.vertices.insert(frame.vertices.end(), {{0, 0, 0, 0, 30, 100, 0, 0},
                                                 {10, 0, 100, 0, 30, 200, 1, 0},
                                                 {0, 10, 0, 100, 30, 200, 0, 1}});
    frame.indices.insert(frame.indices.end(), {4, 5, 6});
    clip_ui_geometry(frame, 4, 6, ui_rect_mask(2, 2, 6, 6));
    assert(frame.vertices.size() > 4);
    assert(frame.indices[0] == 0 && frame.indices[5] == 3);
    assert(frame.vertices[0].x == prefix[0].x && frame.vertices[3].y == prefix[3].y);
    for (std::size_t i = 4; i < frame.vertices.size(); ++i) {
        const auto& vertex = frame.vertices[i];
        assert(vertex.x >= 2 && vertex.x <= 6 && vertex.y >= 2 && vertex.y <= 6);
        assert(vertex.red == std::lround(vertex.x * 10));
        assert(vertex.green == std::lround(vertex.y * 10));
        assert(vertex.blue == 30);
        assert(vertex.alpha == std::lround(100 + 10 * vertex.x + 10 * vertex.y));
        assert(std::abs(vertex.u - vertex.x / 10) < 1e-6f);
        assert(std::abs(vertex.v - vertex.y / 10) < 1e-6f);
        assert(frame.indices[i + 2] == i);
    }
}

int main() {
    check_clip_replay();
    check_clipped_attributes();
    UiRenderFrame target_reads;
    assert(!ui_frame_reads_target(target_reads));
    target_reads.composites.emplace_back();
    assert(ui_frame_reads_target(target_reads));
    target_reads.composites[0].source = 1;
    assert(!ui_frame_reads_target(target_reads));
    target_reads.backdrops.emplace_back();
    assert(ui_frame_reads_target(target_reads));
    const auto a = ui_rect_mask(0, 0, 10, 10);
    const auto b = ui_rect_mask(5, 3, 15, 8);
    assert(std::abs(area(intersect_ui_masks(a, b)) - 25) < 0.001);
    assert(std::abs(area(intersect_ui_masks(a, a)) - 100) < 0.001);
    assert(intersect_ui_masks(a, ui_rect_mask(20, 20, 30, 30)).empty());
    assert(std::abs(area(subtract_ui_masks(a, b)) - 75) < 0.001);
    assert(subtract_ui_masks(a, a).empty());
    assert(std::abs(area(subtract_ui_masks(a, ui_rect_mask(2, 2, 8, 8))) - 64) < 0.001);
    assert(std::abs(area(subtract_ui_masks(a, ui_rect_mask(20, 20, 30, 30))) - 100) < 0.001);
    const std::vector<UiClipTriangle> reversed{{{{8, 8}, {8, 2}, {2, 2}}},
                                               {{{8, 8}, {2, 2}, {2, 8}}}};
    assert(std::abs(area(subtract_ui_masks(a, reversed)) - 64) < 0.001);
    for (const float sigma : {0.1f, 1.0f, 3.0f, 8.0f, 18.0f, 40.0f}) {
        UiRenderFrame frame;
        frame.width = 1280;
        frame.height = 720;
        UiBackdrop backdrop;
        backdrop.left = 100;
        backdrop.top = 100;
        backdrop.width = 500;
        backdrop.height = 300;
        const UiBlurKernel kernel = make_ui_blur_kernel(sigma);
        append_ui_backdrop_geometry(frame, backdrop, kernel, a);
        assert(backdrop.blur_width > 0 && backdrop.blur_width <= backdrop.width);
        assert(backdrop.blur_height > 0 && backdrop.blur_height <= backdrop.height);
        for (const auto first : {backdrop.horizontal_index(), backdrop.vertical_index()}) {
            unsigned sum = 0;
            for (auto i = first; i < first + backdrop.kernel_index_count; i += 6) {
                const auto& vertex = frame.vertices[frame.indices[i]];
                assert(vertex.red == vertex.alpha);
                sum += vertex.alpha;
            }
            assert(sum == 255); // Constant backgrounds remain constant.
        }
        for (const auto index : frame.indices)
            assert(index < frame.vertices.size());
        assert(backdrop.composite_index_count == 6);
    }
    std::cout << "ui-backdrop-check: ok\n";
}

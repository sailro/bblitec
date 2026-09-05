#include "pal_ui_backdrop.hpp"
#include <cassert>
#include <cmath>
#include <iostream>

using namespace bbl::pal;

static double area(const std::vector<UiClipTriangle>& triangles) {
    double result = 0;
    for (const auto& t : triangles) result += std::abs(ui_clip_side(t[0], t[1], t[2])) * 0.5;
    return result;
}

int main() {
    const auto a = ui_rect_mask(0, 0, 10, 10);
    const auto b = ui_rect_mask(5, 3, 15, 8);
    assert(std::abs(area(intersect_ui_masks(a, b)) - 25) < 0.001);
    assert(std::abs(area(intersect_ui_masks(a, a)) - 100) < 0.001);
    assert(intersect_ui_masks(a, ui_rect_mask(20, 20, 30, 30)).empty());
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
        for (const auto first : {
                 backdrop.horizontal_index(), backdrop.vertical_index()}) {
            unsigned sum = 0;
            for (auto i = first; i < first + backdrop.kernel_index_count; i += 6) {
                const auto& vertex = frame.vertices[frame.indices[i]];
                assert(vertex.red == vertex.alpha);
                sum += vertex.alpha;
            }
            assert(sum == 255); // Constant backgrounds remain constant.
        }
        for (const auto index : frame.indices) assert(index < frame.vertices.size());
        assert(backdrop.composite_index_count == 6);
    }
    std::cout << "ui-backdrop-check: ok\n";
}

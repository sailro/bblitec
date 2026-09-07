#include "pal_ui_canvas.hpp"

#include <cassert>
#include <cmath>
#include <iostream>
#include <limits>

using namespace bbl;
using namespace bbl::pal;

static void check_coverage(double start, double end) {
    const auto bands = canvas_coverage_bands(start, end);
    double area = 0.0;
    for (const auto& band : bands) {
        if (band.coverage == 0.0) continue;
        assert(band.start == std::floor(band.start));
        assert(band.end == std::floor(band.end));
        assert(band.coverage > 0.0 && band.coverage <= 1.0);
        area += (band.end - band.start) * band.coverage;
    }
    assert(std::abs(area - (end - start)) < 1e-10);
    for (double pixel = std::floor(start) - 1; pixel <= std::ceil(end); pixel += 1) {
        double actual = 0.0;
        int overlaps = 0;
        for (const auto& band : bands) {
            if (band.start <= pixel && band.end > pixel) {
                actual += band.coverage;
                ++overlaps;
            }
        }
        const double expected = std::max(0.0, std::min(pixel + 1.0, end) - std::max(pixel, start));
        assert(std::abs(actual - expected) < 1e-10);
        assert(overlaps <= 1);
    }
}

int main() {
    for (const double start : {-3.9, -1.0, -0.25, 0.0, 0.1, 0.999, 3.0}) {
        for (const double width : {0.0001, 0.1, 0.75, 1.0, 1.8, 14.25}) {
            check_coverage(start, start + width);
        }
    }
    for (const auto& band : canvas_coverage_bands(1.0, 1.0)) assert(band.coverage == 0.0);
    for (const auto& band : canvas_coverage_bands(3.0, -1.0)) assert(band.coverage == 0.0);
    for (const auto& band : canvas_coverage_bands(0.0, std::numeric_limits<double>::infinity())) assert(band.coverage == 0.0);

    UiElementRecord::CanvasState canvas;
    canvas.width = 20;
    canvas.height = 10;
    canvas.fill_style = "#abc";
    canvas.path = {{2, 3}, {6, 7}};
    canvas.path_closed = true;
    canvas.line_width = 3.0;
    retain_canvas_fill_rect(canvas, 8, 7, -10, -4, true);
    assert(canvas.draws.size() == 1);
    const auto first = canvas.draws.front();
    assert(first.kind == UiElementRecord::CanvasDrawCommand::Kind::FillRect);
    assert(first.destination_x == 0 && first.destination_y == 3);
    assert(first.destination_width == 8 && first.destination_height == 4);
    assert(first.color == "#abc");
    assert(canvas.path.size() == 2 && canvas.path[0].x == 2 && canvas.path[1].y == 7);
    assert(canvas.path_closed && canvas.line_width == 3.0);
    retain_canvas_fill_rect(canvas, 0, 0, 20, 10, false);
    assert(canvas.draws.size() == 2); // Translucent full fills preserve prior content.
    retain_canvas_fill_rect(canvas, 0, 0, 19.9, 10, true);
    assert(canvas.draws.size() == 3); // A nearly-full opaque fill still leaves an edge.
    for (int frame = 0; frame < 10000; ++frame) {
        retain_canvas_fill_rect(canvas, -1, -1, 22, 12, true);
        retain_canvas_fill_rect(canvas, 5, 3, 2, 2, true);
        assert(canvas.draws.size() == 2);
    }
    assert(canvas.path.size() == 2 && canvas.path_closed && canvas.line_width == 3.0);
    canvas.scale_x = -2;
    canvas.scale_y = 2;
    retain_canvas_fill_rect(canvas, -4, 1, 2, 2, true);
    const auto& scaled = canvas.draws.back();
    assert(scaled.destination_x == 4 && scaled.destination_y == 2);
    assert(scaled.destination_width == 4 && scaled.destination_height == 4);
    const auto count = canvas.draws.size();
    retain_canvas_fill_rect(canvas, 0, 0, 0, 5, true);
    retain_canvas_fill_rect(canvas, 0, 0, std::numeric_limits<double>::infinity(), 5, true);
    retain_canvas_fill_rect(canvas, std::numeric_limits<double>::quiet_NaN(), 0, 5, 5, true);
    assert(canvas.draws.size() == count);
    std::cout << "ui-canvas-rectangle-check: ok\n";
}

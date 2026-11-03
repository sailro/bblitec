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
        if (band.coverage == 0.0)
            continue;
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
    for (const auto& band : canvas_coverage_bands(1.0, 1.0))
        assert(band.coverage == 0.0);
    for (const auto& band : canvas_coverage_bands(3.0, -1.0))
        assert(band.coverage == 0.0);
    for (const auto& band : canvas_coverage_bands(0.0, std::numeric_limits<double>::infinity()))
        assert(band.coverage == 0.0);

    UiElementRecord element;
    auto& canvas = element.canvas.emplace();
    assert(canvas.width == 300 && canvas.height == 150);
    assert(canvas.drawing.transform.a == 1 && canvas.drawing.transform.d == 1 &&
           canvas.drawing.fill_style == "#000000");
    canvas.width = 20;
    canvas.height = 10;
    canvas.drawing.fill_style = "#abc";
    canvas.path = {{2, 3}, {6, 7}};
    canvas.path_closed = true;
    canvas.drawing.line_width = 3.0;
    retain_canvas_fill_rect(canvas, 8, 7, -10, -4, true);
    assert(canvas.draws.size() == 1);
    const auto first = canvas.draws.front();
    assert(first.kind == UiElementRecord::CanvasDrawCommand::Kind::FillRect);
    assert(first.destination_x == 0 && first.destination_y == 3);
    assert(first.destination_width == 8 && first.destination_height == 4);
    assert(first.color == "#abc");
    assert(canvas.path.size() == 2 && canvas.path[0].x == 2 && canvas.path[1].y == 7);
    assert(canvas.path_closed && canvas.drawing.line_width == 3.0);
    retain_canvas_fill_rect(canvas, 0, 0, 20, 10, false);
    assert(canvas.draws.size() == 2); // Translucent full fills preserve prior content.
    retain_canvas_fill_rect(canvas, 0, 0, 19.9, 10, true);
    assert(canvas.draws.size() == 3); // A nearly-full opaque fill still leaves an edge.
    for (int frame = 0; frame < 10000; ++frame) {
        retain_canvas_fill_rect(canvas, -1, -1, 22, 12, true);
        retain_canvas_fill_rect(canvas, 5, 3, 2, 2, true);
        assert(canvas.draws.size() == 2);
    }
    assert(canvas.path.size() == 2 && canvas.path_closed && canvas.drawing.line_width == 3.0);
    canvas.drawing.transform.a = -2;
    canvas.drawing.transform.d = 2;
    retain_canvas_fill_rect(canvas, -4, 1, 2, 2, true);
    const auto& scaled = canvas.draws.back();
    assert(scaled.destination_x == 4 && scaled.destination_y == 2);
    assert(scaled.destination_width == 4 && scaled.destination_height == 4);
    const auto count = canvas.draws.size();
    retain_canvas_fill_rect(canvas, 0, 0, 0, 5, true);
    retain_canvas_fill_rect(canvas, 0, 0, std::numeric_limits<double>::infinity(), 5, true);
    retain_canvas_fill_rect(canvas, std::numeric_limits<double>::quiet_NaN(), 0, 5, 5, true);
    assert(canvas.draws.size() == count);
    // A translation keeps the rectangle axis-aligned; a rotation turns it into a convex quad.
    canvas.drawing.transform = {1, 0, 0, 1, 3, 2};
    retain_canvas_fill_rect(canvas, 1, 1, 4, 2, true);
    const auto& moved = canvas.draws.back();
    assert(moved.kind == UiElementRecord::CanvasDrawCommand::Kind::FillRect);
    assert(moved.destination_x == 4 && moved.destination_y == 3);
    assert(moved.destination_width == 4 && moved.destination_height == 2);
    canvas.drawing.transform = {0, 1, -1, 0, 10, 0};
    retain_canvas_fill_rect(canvas, 1, 2, 4, 3, true);
    const auto& turned = canvas.draws.back();
    assert(turned.kind == UiElementRecord::CanvasDrawCommand::Kind::Fill && turned.closed);
    assert(turned.points.size() == 4 && turned.color == "#abc");
    assert(turned.points[0].x == 8 && turned.points[0].y == 1);
    assert(turned.points[2].x == 5 && turned.points[2].y == 5);
    assert(canvas_length_scale({2, 0, 0, 4, 0, 0}) == 3);

    // clearRect drops what it covers, keeps what it misses and cuts filled rectangles exactly.
    canvas.drawing.transform = {};
    retain_canvas_clear_rect(canvas, 0, 0, 20, 10);
    assert(canvas.draws.empty());
    retain_canvas_fill_rect(canvas, 0, 0, 20, 10, false);
    retain_canvas_fill_rect(canvas, 1, 1, 2, 2, false);
    retain_canvas_fill_rect(canvas, 16, 6, 2, 2, false);
    retain_canvas_clear_rect(canvas, 0, 0, 4, 4);
    assert(canvas.draws.size() == 3);
    double area = 0.0;
    for (const auto& draw : canvas.draws)
        area += draw.destination_width * draw.destination_height;
    assert(area == 200 - 16 + 4);
    retain_canvas_clear_rect(canvas, 5, 2, 4, 4);
    area = 0.0;
    for (const auto& draw : canvas.draws)
        area += draw.destination_width * draw.destination_height;
    assert(canvas.draws.size() == 7 && area == 200 - 16 - 16 + 4);
    canvas.path = {{12, 1}, {14, 1}, {13, 3}};
    UiElementRecord::CanvasDrawCommand triangle;
    triangle.kind = UiElementRecord::CanvasDrawCommand::Kind::Fill;
    triangle.points = canvas.path;
    canvas.draws.push_back(triangle);
    bool refused = false;
    try {
        retain_canvas_clear_rect(canvas, 13, 0, 4, 4);
    } catch (const std::runtime_error&) {
        refused = true;
    }
    assert(refused);
    retain_canvas_clear_rect(canvas, 11, 0, 4, 4);
    assert(canvas.draws.size() == 9); // The triangle went with its cover; two pieces were cut.
    canvas.drawing.transform = {0, 1, -1, 0, 10, 0};
    retain_canvas_clear_rect(canvas, -1, -11, 12, 22);
    assert(canvas.draws.empty());

    // putImageData pixels clear when the clear covers their centre.
    const double clears[][4] = {
        {0.6, 0.4, 2.0, 1.2}, {-3, 1.5, 4.5, 9}, {2.5, 0, 0.5, 3}, {3.4, 2.6, 0.2, 0.2}};
    for (const auto& clear : clears) {
        UiElementRecord image;
        auto& surface = image.canvas.emplace();
        surface.width = 4;
        surface.height = 3;
        surface.pixels.assign(4 * 3 * 4, 255);
        retain_canvas_clear_rect(surface, clear[0], clear[1], clear[2], clear[3]);
        for (int row = 0; row < 3; ++row)
            for (int column = 0; column < 4; ++column) {
                const double cx = column + 0.5, cy = row + 0.5;
                const bool cleared = cx >= clear[0] && cx < clear[0] + clear[2] && cy >= clear[1] &&
                                     cy < clear[1] + clear[3];
                for (int channel = 0; channel < 4; ++channel)
                    assert(surface.pixels[(row * 4 + column) * 4 + channel] == (cleared ? 0 : 255));
            }
    }
    std::cout << "ui-canvas-rectangle-check: ok\n";
}

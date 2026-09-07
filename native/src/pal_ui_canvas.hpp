#pragma once

#include <bblite/runtime.hpp>

#include <algorithm>
#include <array>
#include <cmath>

namespace bbl::pal {

/** A run of backing pixels with the same covered fraction along one axis. */
struct CanvasCoverageBand {
    double start = 0.0;
    double end = 0.0;
    double coverage = 0.0;
};

/** At most two fractional edge pixels surround a fully covered interior. */
inline std::array<CanvasCoverageBand, 3> canvas_coverage_bands(
    double start,
    double end) {
    std::array<CanvasCoverageBand, 3> result{};
    if (!std::isfinite(start) || !std::isfinite(end) || end <= start) return result;
    const double first_pixel = std::floor(start);
    if (end <= first_pixel + 1.0) {
        result[0] = {first_pixel, first_pixel + 1.0, end - start};
        return result;
    }
    std::size_t count = 0;
    if (start > first_pixel) {
        result[count++] = {first_pixel, first_pixel + 1.0, first_pixel + 1.0 - start};
        start = first_pixel + 1.0;
    }
    const double last_pixel = std::floor(end);
    if (last_pixel > start) result[count++] = {start, last_pixel, 1.0};
    if (end > last_pixel) result[count] = {last_pixel, last_pixel + 1.0, end - last_pixel};
    return result;
}

/**
 * Retain a rectangle in backing coordinates. Drawing does not alter the path;
 * only an opaque overwrite covering the entire backing store hides all history.
 */
inline void retain_canvas_fill_rect(
    UiElementRecord::CanvasState& canvas,
    double x,
    double y,
    double width,
    double height,
    bool opaque) {
    const double x0 = x * canvas.scale_x;
    const double y0 = y * canvas.scale_y;
    const double x1 = (x + width) * canvas.scale_x;
    const double y1 = (y + height) * canvas.scale_y;
    if (!std::isfinite(x0) || !std::isfinite(y0) ||
        !std::isfinite(x1) || !std::isfinite(y1)) return;
    const double left = std::max(0.0, std::min(x0, x1));
    const double top = std::max(0.0, std::min(y0, y1));
    const double right = std::min(canvas.width, std::max(x0, x1));
    const double bottom = std::min(canvas.height, std::max(y0, y1));
    if (right <= left || bottom <= top) return;
    if (opaque && left == 0.0 && top == 0.0 &&
        right == canvas.width && bottom == canvas.height) {
        canvas.draws.clear();
    }
    UiElementRecord::CanvasDrawCommand draw;
    draw.kind = UiElementRecord::CanvasDrawCommand::Kind::FillRect;
    draw.color = canvas.fill_style;
    draw.destination_x = left;
    draw.destination_y = top;
    draw.destination_width = right - left;
    draw.destination_height = bottom - top;
    canvas.draws.push_back(std::move(draw));
}

} // namespace bbl::pal

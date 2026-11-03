#pragma once

#include <bblite/runtime.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
#include <stdexcept>
#include <utility>
#include <vector>

namespace bbl::pal {

/** A run of backing pixels with the same covered fraction along one axis. */
struct CanvasCoverageBand {
    double start = 0.0;
    double end = 0.0;
    double coverage = 0.0;
};

/** At most two fractional edge pixels surround a fully covered interior. */
inline std::array<CanvasCoverageBand, 3> canvas_coverage_bands(double start, double end) {
    std::array<CanvasCoverageBand, 3> result{};
    if (!std::isfinite(start) || !std::isfinite(end) || end <= start)
        return result;
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
    if (last_pixel > start)
        result[count++] = {start, last_pixel, 1.0};
    if (end > last_pixel)
        result[count] = {last_pixel, last_pixel + 1.0, end - last_pixel};
    return result;
}

/** A user-space point in backing coordinates. */
inline UiElementRecord::CanvasPoint canvas_transformed(const UiElementRecord::CanvasTransform& m,
                                                       double x, double y) {
    return {m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f};
}

/** Whether the transform keeps rectangles axis-aligned (no rotation or skew). */
inline bool canvas_axis_aligned(const UiElementRecord::CanvasTransform& m) {
    return m.b == 0.0 && m.c == 0.0;
}

/** One length's scale under the transform: the mean of its axes' scales. */
inline double canvas_length_scale(const UiElementRecord::CanvasTransform& m) {
    return (std::hypot(m.a, m.b) + std::hypot(m.c, m.d)) * 0.5;
}

/**
 * Retain a rectangle in backing coordinates. Drawing does not alter the path;
 * only an opaque overwrite covering the entire backing store hides all history.
 */
inline void retain_canvas_fill_rect(UiElementRecord::CanvasState& canvas, double x, double y,
                                    double width, double height, bool opaque) {
    const auto& transform = canvas.drawing.transform;
    if (!canvas_axis_aligned(transform)) {
        // A rotated or skewed rectangle is a convex quad.
        UiElementRecord::CanvasDrawCommand draw;
        draw.kind = UiElementRecord::CanvasDrawCommand::Kind::Fill;
        draw.points = {canvas_transformed(transform, x, y),
                       canvas_transformed(transform, x + width, y),
                       canvas_transformed(transform, x + width, y + height),
                       canvas_transformed(transform, x, y + height)};
        for (const auto& point : draw.points)
            if (!std::isfinite(point.x) || !std::isfinite(point.y))
                return;
        if (width == 0.0 || height == 0.0)
            return;
        draw.color = canvas.drawing.fill_style;
        draw.line_width = 0.0;
        draw.closed = true;
        canvas.draws.push_back(std::move(draw));
        return;
    }
    const double x0 = x * transform.a + transform.e;
    const double y0 = y * transform.d + transform.f;
    const double x1 = (x + width) * transform.a + transform.e;
    const double y1 = (y + height) * transform.d + transform.f;
    if (!std::isfinite(x0) || !std::isfinite(y0) || !std::isfinite(x1) || !std::isfinite(y1))
        return;
    const double left = std::max(0.0, std::min(x0, x1));
    const double top = std::max(0.0, std::min(y0, y1));
    const double right = std::min(canvas.width, std::max(x0, x1));
    const double bottom = std::min(canvas.height, std::max(y0, y1));
    if (right <= left || bottom <= top)
        return;
    if (opaque && left == 0.0 && top == 0.0 && right == canvas.width && bottom == canvas.height) {
        canvas.draws.clear();
    }
    UiElementRecord::CanvasDrawCommand draw;
    draw.kind = UiElementRecord::CanvasDrawCommand::Kind::FillRect;
    draw.color = canvas.drawing.fill_style;
    draw.destination_x = left;
    draw.destination_y = top;
    draw.destination_width = right - left;
    draw.destination_height = bottom - top;
    canvas.draws.push_back(std::move(draw));
}

/** A backing-space rectangle. */
struct CanvasBounds {
    double left = 0.0;
    double top = 0.0;
    double right = 0.0;
    double bottom = 0.0;
};

/** Where a retained draw paints, in backing coordinates; text's extent is unknown. */
inline std::optional<CanvasBounds>
canvas_draw_bounds(const UiElementRecord::CanvasDrawCommand& draw) {
    using Kind = UiElementRecord::CanvasDrawCommand::Kind;
    if (draw.kind == Kind::Text)
        return std::nullopt;
    if (draw.kind == Kind::FillRect)
        return CanvasBounds{draw.destination_x, draw.destination_y,
                            draw.destination_x + draw.destination_width,
                            draw.destination_y + draw.destination_height};
    if (draw.points.empty())
        return CanvasBounds{};
    CanvasBounds bounds{draw.points[0].x, draw.points[0].y, draw.points[0].x, draw.points[0].y};
    for (const auto& point : draw.points) {
        bounds.left = std::min(bounds.left, point.x);
        bounds.top = std::min(bounds.top, point.y);
        bounds.right = std::max(bounds.right, point.x);
        bounds.bottom = std::max(bounds.bottom, point.y);
    }
    // A stroke's quads and round joins reach half its width past the path.
    const double reach = draw.kind == Kind::Stroke ? draw.line_width * 0.5 : 0.0;
    return CanvasBounds{bounds.left - reach, bounds.top - reach, bounds.right + reach,
                        bounds.bottom + reach};
}

/**
 * clearRect erases to transparent black. The retained draw list holds no pixels to erase, so
 * a clear drops the draws it covers whole, keeps the ones it misses and cuts filled rectangles
 * exactly; one that would cut a path, an image or text refuses. putImageData pixels clear by
 * pixel centre.
 */
inline void retain_canvas_clear_rect(UiElementRecord::CanvasState& canvas, double x, double y,
                                     double width, double height) {
    for (const double value : {x, y, width, height})
        if (!std::isfinite(value))
            return;
    const auto& transform = canvas.drawing.transform;
    constexpr double tolerance = 1e-6;
    const bool painted = !canvas.draws.empty() || !canvas.pixels.empty();
    if (!canvas_axis_aligned(transform)) {
        if (!painted)
            return;
        // Only a rotated clear that contains the whole surface is represented.
        const std::array quad{canvas_transformed(transform, x, y),
                              canvas_transformed(transform, x + width, y),
                              canvas_transformed(transform, x + width, y + height),
                              canvas_transformed(transform, x, y + height)};
        const auto inside = [&quad](double px, double py) {
            int sign = 0;
            for (std::size_t index = 0; index < quad.size(); ++index) {
                const auto& a = quad[index];
                const auto& b = quad[(index + 1) % quad.size()];
                const double side = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
                if (std::abs(side) <= tolerance)
                    continue;
                const int current = side > 0 ? 1 : -1;
                if (sign != 0 && current != sign)
                    return false;
                sign = current;
            }
            return true;
        };
        if (!inside(0, 0) || !inside(canvas.width, 0) || !inside(canvas.width, canvas.height) ||
            !inside(0, canvas.height))
            throw std::runtime_error(
                "A rotated Canvas2D clearRect that leaves part of the surface is not represented.");
        canvas.draws.clear();
        if (!canvas.pixels.empty()) {
            std::fill(canvas.pixels.begin(), canvas.pixels.end(), std::uint8_t{0});
            ++canvas.pixel_revision;
        }
        return;
    }
    const double x0 = x * transform.a + transform.e;
    const double x1 = (x + width) * transform.a + transform.e;
    const double y0 = y * transform.d + transform.f;
    const double y1 = (y + height) * transform.d + transform.f;
    const CanvasBounds clear{std::max(0.0, std::min(x0, x1)), std::max(0.0, std::min(y0, y1)),
                             std::min(canvas.width, std::max(x0, x1)),
                             std::min(canvas.height, std::max(y0, y1))};
    if (clear.right <= clear.left || clear.bottom <= clear.top || !painted)
        return;
    if (clear.left <= tolerance && clear.top <= tolerance &&
        clear.right >= canvas.width - tolerance && clear.bottom >= canvas.height - tolerance) {
        canvas.draws.clear();
        if (!canvas.pixels.empty()) {
            std::fill(canvas.pixels.begin(), canvas.pixels.end(), std::uint8_t{0});
            ++canvas.pixel_revision;
        }
        return;
    }
    std::vector<UiElementRecord::CanvasDrawCommand> kept;
    kept.reserve(canvas.draws.size());
    for (auto& draw : canvas.draws) {
        const auto bounds = canvas_draw_bounds(draw);
        if (!bounds)
            throw std::runtime_error("A partial Canvas2D clearRect over text is not represented.");
        // Only the visible part of a draw matters.
        const CanvasBounds visible{std::max(bounds->left, 0.0), std::max(bounds->top, 0.0),
                                   std::min(bounds->right, canvas.width),
                                   std::min(bounds->bottom, canvas.height)};
        if (visible.right <= visible.left || visible.bottom <= visible.top)
            continue;
        if (visible.left >= clear.left && visible.right <= clear.right &&
            visible.top >= clear.top && visible.bottom <= clear.bottom)
            continue;
        if (visible.right <= clear.left || visible.left >= clear.right ||
            visible.bottom <= clear.top || visible.top >= clear.bottom) {
            kept.push_back(std::move(draw));
            continue;
        }
        if (draw.kind != UiElementRecord::CanvasDrawCommand::Kind::FillRect)
            throw std::runtime_error(
                "A Canvas2D clearRect that cuts a path or image draw is not represented.");
        // A filled rectangle minus the clear: up to four exact pieces.
        const auto piece = [&kept, &draw](double left, double top, double right, double bottom) {
            if (right <= left || bottom <= top)
                return;
            auto part = draw;
            part.destination_x = left;
            part.destination_y = top;
            part.destination_width = right - left;
            part.destination_height = bottom - top;
            kept.push_back(std::move(part));
        };
        const double middle_top = std::max(visible.top, clear.top);
        const double middle_bottom = std::min(visible.bottom, clear.bottom);
        piece(visible.left, visible.top, visible.right, clear.top);
        piece(visible.left, middle_top, clear.left, middle_bottom);
        piece(clear.right, middle_top, visible.right, middle_bottom);
        piece(visible.left, clear.bottom, visible.right, visible.bottom);
    }
    canvas.draws = std::move(kept);
    const auto columns = static_cast<std::size_t>(std::floor(canvas.width));
    if (!canvas.pixels.empty() && columns > 0) {
        const std::size_t rows = canvas.pixels.size() / (columns * 4);
        // The pixels whose centres i + 0.5 lie in [start, end): i from ceil(start - 0.5) up to
        // ceil(end - 0.5).
        const auto covered = [](double start, double end, std::size_t count) {
            const auto edge = [count](double value) {
                return static_cast<std::size_t>(
                    std::clamp(std::ceil(value - 0.5), 0.0, static_cast<double>(count)));
            };
            return std::pair{edge(start), edge(end)};
        };
        const auto [first_column, end_column] = covered(clear.left, clear.right, columns);
        const auto [first_row, end_row] = covered(clear.top, clear.bottom, rows);
        if (first_column < end_column)
            for (std::size_t row = first_row; row < end_row; ++row)
                std::fill_n(canvas.pixels.begin() +
                                static_cast<std::ptrdiff_t>((row * columns + first_column) * 4),
                            (end_column - first_column) * 4, std::uint8_t{0});
        ++canvas.pixel_revision;
    }
}

} // namespace bbl::pal

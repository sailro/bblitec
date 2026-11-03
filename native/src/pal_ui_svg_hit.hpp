#pragma once

#include <bblite/pal_ui.hpp>
#include "pal_ui_svg_path.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <functional>
#include <numbers>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace bbl::pal {

/** A glyph's cell on its baseline: from its origin along its unit direction by its advance. */
struct UiSvgGlyphCell {
    UiSvgPoint origin;
    UiSvgPoint direction{1, 0};
    double advance = 0;
    double ascent = 0;
    double descent = 0;
};

/**
 * A drawn SVG element's hit geometry in user units (SVG 1.1 §16.6, visiblePainted): its fill
 * area when filled, the band within half its stroke width when stroked, a text's glyph cells.
 * An event over it targets `target` (a textPath for the glyphs it lays out).
 */
struct UiSvgHitShape {
    UiElementHandle target;
    // Whether its pointer-events let it take the pointer; every shape keeps its bounds.
    bool pointer = false;
    UiSvgPolylines outline;
    bool fill = false;
    double stroke_width = 0;
    std::vector<UiSvgGlyphCell> cells;
    // Its ui_svg_hit_bounds, kept when the markup is built: hit tests reject outside them first.
    std::optional<std::array<double, 4>> bounds;
};

namespace svg_hit_detail {

inline double side(UiSvgPoint a, UiSvgPoint b, UiSvgPoint point) {
    return (b.x - a.x) * (point.y - a.y) - (point.x - a.x) * (b.y - a.y);
}

/** Nonzero winding over every subpath, each implicitly closed (SVG's default fill-rule). */
inline bool inside(const UiSvgPolylines& outline, UiSvgPoint point) {
    int winding = 0;
    for (const auto& line : outline)
        for (std::size_t index = 0; index < line.size(); ++index) {
            const UiSvgPoint a = line[index], b = line[(index + 1) % line.size()];
            if (a.y <= point.y) {
                if (b.y > point.y && side(a, b, point) > 0)
                    ++winding;
            } else if (b.y <= point.y && side(a, b, point) < 0)
                --winding;
        }
    return winding != 0;
}

inline double distance_squared(UiSvgPoint a, UiSvgPoint b, UiSvgPoint point) {
    const double dx = b.x - a.x, dy = b.y - a.y;
    const double length = dx * dx + dy * dy;
    const double t =
        length > 0 ? std::clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / length, 0.0, 1.0)
                   : 0.0;
    const double x = point.x - (a.x + dx * t), y = point.y - (a.y + dy * t);
    return x * x + y * y;
}

/** An ellipse's outline, fine enough that a stroke band stays within a thousandth of its radius. */
inline std::vector<UiSvgPoint> ellipse(double cx, double cy, double rx, double ry, double from = 0,
                                       double to = 2 * std::numbers::pi, int segments = 64) {
    std::vector<UiSvgPoint> points;
    for (int step = 0; step <= segments; ++step) {
        const double angle = from + (to - from) * step / segments;
        points.push_back({cx + rx * std::cos(angle), cy + ry * std::sin(angle)});
    }
    return points;
}

/** The numbers of a list (`x,y x,y` or `x y x y`) as path data reads them, nullopt for other text. */
inline std::optional<std::vector<double>> numbers(std::string_view text) {
    svg_path_detail::Reader reader(text);
    std::vector<double> values;
    while (!reader.done()) {
        const auto value = reader.number();
        if (!value)
            return std::nullopt;
        values.push_back(*value);
    }
    return values;
}

} // namespace svg_hit_detail

/** A root's viewBox (min-x, min-y, width, height); nullopt without a usable one. */
inline std::optional<std::array<double, 4>> ui_svg_view_box(const UiElementRecord& root) {
    const auto box = root.attributes.find("viewBox");
    if (box == root.attributes.end())
        return std::nullopt;
    const auto values = svg_hit_detail::numbers(box->second);
    if (!values || values->size() != 4 || (*values)[2] <= 0 || (*values)[3] <= 0)
        return std::nullopt;
    return std::array<double, 4>{(*values)[0], (*values)[1], (*values)[2], (*values)[3]};
}

/**
 * The root's user space in its content box: a viewBox scales uniformly and centres (SVG 1.1 §7.7,
 * the default xMidYMid meet); without one a user unit is a CSS pixel, `unit` box pixels.
 */
struct UiSvgViewport {
    double scale = 1;
    double x = 0;
    double y = 0;
    UiSvgPoint to_box(UiSvgPoint user) const { return {user.x * scale + x, user.y * scale + y}; }
    UiSvgPoint to_user(UiSvgPoint box) const { return {(box.x - x) / scale, (box.y - y) / scale}; }
};

inline UiSvgViewport ui_svg_viewport(const std::optional<std::array<double, 4>>& view_box,
                                     double width, double height, double unit) {
    if (!view_box)
        return {unit, 0, 0};
    const auto& view = *view_box;
    const double scale = std::min(width / view[2], height / view[3]);
    return {scale, (width - view[2] * scale) / 2 - view[0] * scale,
            (height - view[3] * scale) / 2 - view[1] * scale};
}

/** Whether `point` hits the shape: its fill, its stroke band or one of its glyph cells. */
inline bool ui_svg_hits(const UiSvgHitShape& shape, UiSvgPoint point) {
    if (!shape.pointer)
        return false;
    if (shape.bounds) {
        // Outside its bounds nothing hits; the slack leaves every rounding edge to the exact test.
        const auto& [left, top, width, height] = *shape.bounds;
        const double slack = 1e-9 * (1 + std::abs(left) + std::abs(top) + width + height);
        if (point.x < left - slack || point.x > left + width + slack || point.y < top - slack ||
            point.y > top + height + slack)
            return false;
    }
    if (shape.fill && svg_hit_detail::inside(shape.outline, point))
        return true;
    if (shape.stroke_width > 0) {
        const double reach = shape.stroke_width / 2;
        for (const auto& line : shape.outline)
            for (std::size_t index = 1; index < line.size(); ++index)
                if (svg_hit_detail::distance_squared(line[index - 1], line[index], point) <=
                    reach * reach)
                    return true;
    }
    for (const auto& cell : shape.cells) {
        const double dx = point.x - cell.origin.x, dy = point.y - cell.origin.y;
        const double along = dx * cell.direction.x + dy * cell.direction.y;
        const double across = -dx * cell.direction.y + dy * cell.direction.x;
        if (along >= 0 && along <= cell.advance && across >= -cell.ascent && across <= cell.descent)
            return true;
    }
    return false;
}

/** The shape's bounds in user units: its outline, widened by half its stroke, and its cells. */
inline std::optional<std::array<double, 4>> ui_svg_hit_bounds(const UiSvgHitShape& shape) {
    double left = INFINITY, top = INFINITY, right = -INFINITY, bottom = -INFINITY;
    const auto add = [&](UiSvgPoint point, double margin) {
        left = std::min(left, point.x - margin);
        top = std::min(top, point.y - margin);
        right = std::max(right, point.x + margin);
        bottom = std::max(bottom, point.y + margin);
    };
    // Only a positive width strokes (ui_svg_hits).
    const double reach = std::max(0.0, shape.stroke_width) / 2;
    for (const auto& line : shape.outline)
        for (const auto point : line)
            add(point, reach);
    for (const auto& cell : shape.cells) {
        const double c = cell.direction.x, s = cell.direction.y;
        for (const double along : {0.0, cell.advance})
            for (const double across : {-cell.ascent, cell.descent})
                add({cell.origin.x + along * c - across * s,
                     cell.origin.y + along * s + across * c},
                    0);
    }
    if (left > right)
        return std::nullopt;
    return std::array<double, 4>{left, top, right - left, bottom - top};
}

/**
 * A basic shape's outline from its geometry attributes (SVG 1.1 §9): rectangles with their
 * corner radii, circles and ellipses, lines, polylines, polygons, and path data; nullopt for
 * points or path data outside what flattens.
 */
inline std::optional<UiSvgPolylines>
ui_svg_shape_outline(const UiElementRecord& record,
                     const std::function<double(std::string_view)>& number) {
    using std::numbers::pi;
    const auto& tag = record.tag;
    if (tag == "rect") {
        const double x = number("x"), y = number("y"), width = number("width"),
                     height = number("height");
        // A missing radius takes the other's; both clamp to half the side (SVG 2 §10.2).
        double rx = record.attributes.contains("rx") ? number("rx") : number("ry");
        double ry = record.attributes.contains("ry") ? number("ry") : rx;
        rx = std::clamp(rx, 0.0, width / 2);
        ry = std::clamp(ry, 0.0, height / 2);
        if (rx == 0 || ry == 0)
            return UiSvgPolylines{
                {{x, y}, {x + width, y}, {x + width, y + height}, {x, y + height}, {x, y}}};
        std::vector<UiSvgPoint> line;
        const auto corner = [&](double cx, double cy, double from) {
            const auto arc = svg_hit_detail::ellipse(cx, cy, rx, ry, from, from + pi / 2, 16);
            line.insert(line.end(), arc.begin(), arc.end());
        };
        corner(x + width - rx, y + ry, -pi / 2);
        corner(x + width - rx, y + height - ry, 0);
        corner(x + rx, y + height - ry, pi / 2);
        corner(x + rx, y + ry, pi);
        line.push_back(line.front());
        return UiSvgPolylines{line};
    }
    if (tag == "circle")
        return UiSvgPolylines{
            svg_hit_detail::ellipse(number("cx"), number("cy"), number("r"), number("r"))};
    if (tag == "ellipse")
        return UiSvgPolylines{
            svg_hit_detail::ellipse(number("cx"), number("cy"), number("rx"), number("ry"))};
    if (tag == "line")
        return UiSvgPolylines{{{number("x1"), number("y1")}, {number("x2"), number("y2")}}};
    if (tag == "polyline" || tag == "polygon") {
        const auto found = record.attributes.find("points");
        const auto values =
            svg_hit_detail::numbers(found == record.attributes.end() ? "" : found->second);
        if (!values)
            return std::nullopt;
        std::vector<UiSvgPoint> line;
        for (std::size_t index = 0; index + 1 < values->size(); index += 2)
            line.push_back({(*values)[index], (*values)[index + 1]});
        if (tag == "polygon" && !line.empty())
            line.push_back(line.front());
        return UiSvgPolylines{line};
    }
    if (tag == "path") {
        const auto found = record.attributes.find("d");
        return found == record.attributes.end() ? std::optional<UiSvgPolylines>{UiSvgPolylines{}}
                                                : ui_svg_path_polylines(found->second);
    }
    return UiSvgPolylines{};
}

} // namespace bbl::pal

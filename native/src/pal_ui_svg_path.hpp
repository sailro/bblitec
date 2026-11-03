#pragma once

#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstddef>
#include <numbers>
#include <system_error>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace bbl::pal {

struct UiSvgPoint {
    double x = 0;
    double y = 0;
};

/**
 * An SVG path's geometry flattened to polylines, one per subpath: lines kept,
 * arcs and curves sampled finely enough that a glyph placed along them sits
 * within a hundredth of a pixel of the curve.
 */
using UiSvgPolylines = std::vector<std::vector<UiSvgPoint>>;

namespace svg_path_detail {

/** SVG path data and number lists: tokens apart by whitespace or commas, numbers locale-free. */
class Reader {
public:
    explicit Reader(std::string_view text) : text_(text) {}

    void skip_separators() {
        while (at_ < text_.size() &&
               (text_[at_] == ' ' || text_[at_] == ',' || text_[at_] == '\t' ||
                text_[at_] == '\n' || text_[at_] == '\r'))
            ++at_;
    }
    bool done() {
        skip_separators();
        return at_ >= text_.size();
    }
    std::optional<char> command() {
        skip_separators();
        if (at_ < text_.size() &&
            std::string_view("MmLlHhVvAaCcQqZz").find(text_[at_]) != std::string_view::npos)
            return text_[at_++];
        return std::nullopt;
    }
    bool number_next() {
        skip_separators();
        return at_ < text_.size() && (text_[at_] == '-' || text_[at_] == '+' || text_[at_] == '.' ||
                                      (text_[at_] >= '0' && text_[at_] <= '9'));
    }
    std::optional<double> number() {
        if (!number_next())
            return std::nullopt;
        // from_chars reads no leading plus sign.
        if (text_[at_] == '+')
            ++at_;
        double value = 0;
        const auto [end, error] =
            std::from_chars(text_.data() + at_, text_.data() + text_.size(), value);
        if (error != std::errc{})
            return std::nullopt;
        at_ = static_cast<std::size_t>(end - text_.data());
        return value;
    }
    /** What follows the last item read. */
    [[nodiscard]] std::string_view rest() const { return text_.substr(at_); }
    // An arc flag may be written without a separator before the next number.
    std::optional<bool> flag() {
        skip_separators();
        if (at_ < text_.size() && (text_[at_] == '0' || text_[at_] == '1'))
            return text_[at_++] == '1';
        return std::nullopt;
    }

private:
    std::string_view text_;
    std::size_t at_ = 0;
};

inline int samples_for(double length) {
    return std::max(8, std::min(512, static_cast<int>(std::ceil(length * 2))));
}

/** SVG's endpoint arc to center parameterization (SVG 1.1 F.6.5), sampled. */
inline void append_arc(std::vector<UiSvgPoint>& line, UiSvgPoint from, double rx, double ry,
                       double rotation_deg, bool large, bool sweep, UiSvgPoint to) {
    if (rx == 0 || ry == 0 || (from.x == to.x && from.y == to.y)) {
        line.push_back(to);
        return;
    }
    rx = std::abs(rx);
    ry = std::abs(ry);
    const double phi = rotation_deg * std::numbers::pi / 180;
    const double cos_phi = std::cos(phi), sin_phi = std::sin(phi);
    const double dx = (from.x - to.x) / 2, dy = (from.y - to.y) / 2;
    const double x1 = cos_phi * dx + sin_phi * dy;
    const double y1 = -sin_phi * dx + cos_phi * dy;
    const double lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lambda > 1) {
        rx *= std::sqrt(lambda);
        ry *= std::sqrt(lambda);
    }
    const double numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const double denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    double coefficient = denominator == 0 ? 0 : std::sqrt(std::max(0.0, numerator / denominator));
    if (large == sweep)
        coefficient = -coefficient;
    const double cx1 = coefficient * rx * y1 / ry;
    const double cy1 = -coefficient * ry * x1 / rx;
    const double cx = cos_phi * cx1 - sin_phi * cy1 + (from.x + to.x) / 2;
    const double cy = sin_phi * cx1 + cos_phi * cy1 + (from.y + to.y) / 2;
    const auto angle = [](double ux, double uy, double vx, double vy) {
        return std::atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    };
    const double theta = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    double delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
    if (!sweep && delta > 0)
        delta -= 2 * std::numbers::pi;
    else if (sweep && delta < 0)
        delta += 2 * std::numbers::pi;
    const int samples = samples_for(std::abs(delta) * std::max(rx, ry));
    for (int i = 1; i <= samples; ++i) {
        const double t = theta + delta * i / samples;
        const double ex = rx * std::cos(t), ey = ry * std::sin(t);
        line.push_back({cos_phi * ex - sin_phi * ey + cx, sin_phi * ex + cos_phi * ey + cy});
    }
    line.back() = to;
}

inline void append_cubic(std::vector<UiSvgPoint>& line, UiSvgPoint p0, UiSvgPoint p1, UiSvgPoint p2,
                         UiSvgPoint p3) {
    const double hull = std::hypot(p1.x - p0.x, p1.y - p0.y) +
                        std::hypot(p2.x - p1.x, p2.y - p1.y) + std::hypot(p3.x - p2.x, p3.y - p2.y);
    const int samples = samples_for(hull);
    for (int i = 1; i <= samples; ++i) {
        const double t = static_cast<double>(i) / samples, u = 1 - t;
        line.push_back(
            {u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
             u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y});
    }
}

} // namespace svg_path_detail

/** The path data's subpaths; nullopt when the data is malformed. */
inline std::optional<UiSvgPolylines> ui_svg_path_polylines(std::string_view data) {
    using namespace svg_path_detail;
    Reader reader(data);
    UiSvgPolylines lines;
    UiSvgPoint current, start;
    std::optional<char> command;
    while (!reader.done()) {
        if (const auto next = reader.command())
            command = next;
        else if (!command || *command == 'Z' || *command == 'z')
            return std::nullopt;
        const char op = *command;
        const bool relative = op >= 'a' && op <= 'z';
        const auto point = [&]() -> std::optional<UiSvgPoint> {
            const auto x = reader.number();
            const auto y = reader.number();
            if (!x || !y)
                return std::nullopt;
            return relative ? UiSvgPoint{current.x + *x, current.y + *y} : UiSvgPoint{*x, *y};
        };
        switch (op) {
        case 'M':
        case 'm': {
            const auto to = point();
            if (!to)
                return std::nullopt;
            current = start = *to;
            lines.push_back({current});
            // Coordinates after a moveto are implicit linetos.
            command = relative ? 'l' : 'L';
            break;
        }
        case 'L':
        case 'l': {
            const auto to = point();
            if (!to || lines.empty())
                return std::nullopt;
            current = *to;
            lines.back().push_back(current);
            break;
        }
        case 'H':
        case 'h':
        case 'V':
        case 'v': {
            const auto value = reader.number();
            if (!value || lines.empty())
                return std::nullopt;
            if (op == 'H' || op == 'h')
                current.x = op == 'h' ? current.x + *value : *value;
            else
                current.y = op == 'v' ? current.y + *value : *value;
            lines.back().push_back(current);
            break;
        }
        case 'A':
        case 'a': {
            const auto rx = reader.number();
            const auto ry = reader.number();
            const auto rotation = reader.number();
            const auto large = reader.flag();
            const auto sweep = reader.flag();
            const auto to = point();
            if (!rx || !ry || !rotation || !large || !sweep || !to || lines.empty())
                return std::nullopt;
            append_arc(lines.back(), current, *rx, *ry, *rotation, *large, *sweep, *to);
            current = *to;
            break;
        }
        case 'C':
        case 'c': {
            const auto p1 = point();
            const auto p2 = point();
            const auto p3 = point();
            if (!p1 || !p2 || !p3 || lines.empty())
                return std::nullopt;
            append_cubic(lines.back(), current, *p1, *p2, *p3);
            current = *p3;
            break;
        }
        case 'Q':
        case 'q': {
            const auto control = point();
            const auto to = point();
            if (!control || !to || lines.empty())
                return std::nullopt;
            // A quadratic is the cubic with its control points two thirds along.
            append_cubic(
                lines.back(), current,
                {current.x + 2.0 / 3 * (control->x - current.x),
                 current.y + 2.0 / 3 * (control->y - current.y)},
                {to->x + 2.0 / 3 * (control->x - to->x), to->y + 2.0 / 3 * (control->y - to->y)},
                *to);
            current = *to;
            break;
        }
        case 'Z':
        case 'z':
            if (lines.empty())
                return std::nullopt;
            lines.back().push_back(start);
            current = start;
            break;
        default:
            return std::nullopt;
        }
    }
    return lines;
}

/** The length of a path's first subpath, the one a textPath follows. */
inline double ui_svg_path_length(const UiSvgPolylines& path) {
    double length = 0;
    if (!path.empty())
        for (std::size_t i = 1; i < path.front().size(); ++i)
            length += std::hypot(path.front()[i].x - path.front()[i - 1].x,
                                 path.front()[i].y - path.front()[i - 1].y);
    return length;
}

/**
 * One glyph placed along a path: its origin on the baseline, its rotation in degrees and that
 * rotation's unit direction.
 */
struct UiSvgGlyphPlacement {
    std::string text;
    UiSvgPoint origin;
    double rotate = 0;
    double advance = 0;
    UiSvgPoint direction{1, 0};
};

/**
 * SVG textPath layout (SVG 1.1 §10.13.3): the glyphs advance along the
 * path's first subpath from the start offset, shifted by the text anchor;
 * each glyph's midpoint sits on the path and it turns with the path's
 * direction there. A glyph whose midpoint falls off the path is not drawn.
 * `advances` holds each glyph's advance, letter spacing included.
 */
inline std::vector<UiSvgGlyphPlacement>
ui_svg_text_path_layout(const UiSvgPolylines& path, const std::vector<std::string>& glyphs,
                        const std::vector<double>& advances, double start_offset,
                        std::string_view anchor) {
    std::vector<UiSvgGlyphPlacement> placed;
    if (path.empty() || path.front().size() < 2 || glyphs.size() != advances.size())
        return placed;
    const auto& line = path.front();
    std::vector<double> distance(line.size(), 0.0);
    for (std::size_t i = 1; i < line.size(); ++i)
        distance[i] =
            distance[i - 1] + std::hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
    const double length = distance.back();
    double total = 0;
    for (const double advance : advances)
        total += advance;
    double cursor = start_offset;
    if (anchor == "middle")
        cursor -= total / 2;
    else if (anchor == "end")
        cursor -= total;
    std::size_t segment = 1;
    for (std::size_t glyph = 0; glyph < glyphs.size(); ++glyph) {
        const double advance = advances[glyph];
        const double middle = cursor + advance / 2;
        cursor += advance;
        if (middle < 0 || middle > length)
            continue;
        while (segment + 1 < line.size() && distance[segment] < middle)
            ++segment;
        while (segment > 1 && distance[segment - 1] > middle)
            --segment;
        const UiSvgPoint a = line[segment - 1], b = line[segment];
        const double span = distance[segment] - distance[segment - 1];
        const double t = span > 0 ? (middle - distance[segment - 1]) / span : 0;
        const double dx = b.x - a.x, dy = b.y - a.y;
        const double norm = std::hypot(dx, dy);
        const double ux = norm > 0 ? dx / norm : 1, uy = norm > 0 ? dy / norm : 0;
        const UiSvgPoint on{a.x + dx * t, a.y + dy * t};
        placed.push_back({glyphs[glyph],
                          {on.x - ux * advance / 2, on.y - uy * advance / 2},
                          std::atan2(uy, ux) * 180 / std::numbers::pi,
                          advance,
                          {ux, uy}});
    }
    return placed;
}

/**
 * A <text> drawing each placed glyph at its own origin and rotation, the form RmlUi's SVG plugin
 * draws (it has no textPath); \`attributes\` carries the element's font and paints.
 */
inline std::string ui_svg_positioned_text(const std::vector<UiSvgGlyphPlacement>& placed,
                                          std::string_view attributes) {
    const auto number = [](double value) {
        char buffer[32];
        const auto [end, error] =
            std::to_chars(buffer, buffer + sizeof buffer, value, std::chars_format::fixed, 3);
        return error == std::errc{} ? std::string(buffer, end) : std::string("0");
    };
    std::string xs, ys, rotations, characters;
    for (const auto& glyph : placed) {
        const auto separator = xs.empty() ? "" : " ";
        xs += separator + number(glyph.origin.x);
        ys += separator + number(glyph.origin.y);
        rotations += separator + number(glyph.rotate);
        for (const char character : glyph.text)
            characters += character == '&'   ? std::string("&amp;")
                          : character == '<' ? std::string("&lt;")
                          : character == '>' ? std::string("&gt;")
                                             : std::string(1, character);
    }
    return "<text x=\"" + xs + "\" y=\"" + ys + "\" rotate=\"" + rotations + "\"" +
           std::string(attributes) + ">" + characters + "</text>";
}

} // namespace bbl::pal

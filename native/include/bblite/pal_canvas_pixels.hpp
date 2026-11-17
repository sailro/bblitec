#pragma once

#include <bblite/pal_image.hpp>
#include <bblite/runtime.hpp>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <charconv>
#include <functional>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>
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

/** A canvas colour's premultiplied 8-bit channels. */
struct CanvasRgba {
    std::uint8_t red = 0;
    std::uint8_t green = 0;
    std::uint8_t blue = 0;
    std::uint8_t alpha = 0;
};

/**
 * A canvas style's colour, premultiplied: `#rgb`, `#rrggbb` or `rgba(r,g,b,a)` (each channel a
 * number after optional whitespace, the commas next to it); any other string is transparent black.
 */
inline CanvasRgba canvas_rgba(std::string_view source) {
    double red = 0.0;
    double green = 0.0;
    double blue = 0.0;
    double alpha = 1.0;
    if (source.size() == 4 && source[0] == '#') {
        auto nibble = [](char digit) {
            if (digit >= '0' && digit <= '9')
                return digit - '0';
            if (digit >= 'a' && digit <= 'f')
                return digit - 'a' + 10;
            if (digit >= 'A' && digit <= 'F')
                return digit - 'A' + 10;
            return 0;
        };
        red = nibble(source[1]) * 17;
        green = nibble(source[2]) * 17;
        blue = nibble(source[3]) * 17;
    } else if (source.size() == 7 && source[0] == '#') {
        const auto hex = [&source](std::size_t start, double& channel) {
            unsigned value = 0;
            const char* end = source.data() + start + 2;
            const auto parsed = std::from_chars(source.data() + start, end, value, 16);
            channel = value;
            return parsed.ec == std::errc{} && parsed.ptr == end;
        };
        if (!hex(1, red) || !hex(3, green) || !hex(5, blue))
            return {};
    } else {
        if (!source.starts_with("rgba("))
            return {};
        std::string_view rest = source.substr(5);
        const auto number = [&rest](double& channel) {
            while (!rest.empty() && std::isspace(static_cast<unsigned char>(rest.front())))
                rest.remove_prefix(1);
            if (!rest.empty() && rest.front() == '+')
                rest.remove_prefix(1);
            const auto parsed =
                js::number_chars::from_chars(rest.data(), rest.data() + rest.size(), channel);
            if (parsed.ec != std::errc{})
                return false;
            rest.remove_prefix(static_cast<std::size_t>(parsed.ptr - rest.data()));
            return true;
        };
        const auto comma = [&rest] {
            if (rest.empty() || rest.front() != ',')
                return false;
            rest.remove_prefix(1);
            return true;
        };
        if (!number(red) || !comma() || !number(green) || !comma() || !number(blue) || !comma() ||
            !number(alpha))
            return {};
    }
    alpha = std::clamp(alpha, 0.0, 1.0);
    const auto channel = [alpha](double component) {
        return static_cast<std::uint8_t>(std::clamp(std::lround(component * alpha), 0l, 255l));
    };
    return {channel(red), channel(green), channel(blue),
            static_cast<std::uint8_t>(std::lround(alpha * 255.0))};
}

/** An empty `width` x `height` bitmap in the default drawing state, as setting a size leaves it. */
inline void reset_canvas(UiElementRecord::CanvasState& canvas, double width, double height) {
    const std::uint64_t next_pixel_revision = canvas.pixel_revision + 1;
    canvas = {};
    canvas.width = std::max(0.0, std::floor(width));
    canvas.height = std::max(0.0, std::floor(height));
    canvas.pixel_revision = next_pixel_revision;
}

/** An image's straight-alpha RGBA rows as a draw keeps them: premultiplied, rounded as Skia does. */
inline std::shared_ptr<const UiElementRecord::CanvasBitmap> canvas_bitmap(DecodedImage image) {
    premultiply_image_alpha(image);
    auto bitmap = std::make_shared<UiElementRecord::CanvasBitmap>();
    bitmap->width = image.width;
    bitmap->height = image.height;
    bitmap->pixels = std::move(image.rgba);
    return bitmap;
}

/** A drawImage source: a canvas, or an image's pixels captured now. */
struct CanvasImageSource {
    UiElementHandle canvas{};
    std::shared_ptr<const UiElementRecord::CanvasBitmap> bitmap;
    double width = 0.0;
    double height = 0.0;
};

/**
 * `drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh)` retained as a blit under the current
 * transform; false when it draws nothing (a non-finite or empty rectangle, or a source rectangle
 * off the image).
 */
inline bool retain_canvas_image(UiElementRecord::CanvasState& canvas,
                                const CanvasImageSource& image, double sx, double sy, double sw,
                                double sh, double dx, double dy, double dw, double dh) {
    for (const double value : {sx, sy, sw, sh, dx, dy, dw, dh})
        if (!std::isfinite(value))
            return false;
    if (sw == 0.0 || sh == 0.0 || dw == 0.0 || dh == 0.0 || image.width <= 0.0 ||
        image.height <= 0.0)
        return false;
    // Both rectangles normalize, as in Chromium: a negative extent does not mirror.
    const auto normalize = [](double& start, double& extent) {
        if (extent < 0.0) {
            start += extent;
            extent = -extent;
        }
    };
    normalize(sx, sw);
    normalize(sy, sh);
    normalize(dx, dw);
    normalize(dy, dh);
    // The source rectangle clips to the image, the destination in proportion.
    const double left = std::max(sx, 0.0);
    const double top = std::max(sy, 0.0);
    const double right = std::min(sx + sw, image.width);
    const double bottom = std::min(sy + sh, image.height);
    if (right <= left || bottom <= top)
        return false;
    const double x_scale = dw / sw;
    const double y_scale = dh / sh;
    dx += (left - sx) * x_scale;
    dy += (top - sy) * y_scale;
    dw = (right - left) * x_scale;
    dh = (bottom - top) * y_scale;
    UiElementRecord::CanvasDrawCommand draw;
    draw.kind = UiElementRecord::CanvasDrawCommand::Kind::Blit;
    draw.source = image.canvas;
    draw.bitmap = image.bitmap;
    draw.source_x = left;
    draw.source_y = top;
    draw.source_width = right - left;
    draw.source_height = bottom - top;
    // The destination rectangle under the current transform.
    const auto& transform = canvas.drawing.transform;
    draw.points = {canvas_transformed(transform, dx, dy),
                   canvas_transformed(transform, dx + dw, dy),
                   canvas_transformed(transform, dx + dw, dy + dh),
                   canvas_transformed(transform, dx, dy + dh)};
    draw.nearest_sampling = !canvas.drawing.image_smoothing_enabled;
    canvas.draws.push_back(std::move(draw));
    return true;
}

/** `getImageData`'s result: the rectangle's unpremultiplied RGBA rows. */
struct CanvasImageData {
    double width = 0.0;
    double height = 0.0;
    js::U8Array data;
};

/** The state of the canvas a blit's `source` handle names. */
using CanvasSourceState = std::function<const UiElementRecord::CanvasState&(UiElementHandle)>;

/** The source of a canvas no canvas is drawn into: it has none to give. */
inline const UiElementRecord::CanvasState& no_canvas_source(UiElementHandle) {
    throw std::logic_error("A canvas without canvas sources reached one.");
}

/**
 * `getImageData(sx, sy, sw, sh)` rasterized from what the canvas holds: putImageData pixels,
 * filled rectangles and image blits. A path, stroke or text draw throws.
 */
inline CanvasImageData compose_canvas_image_data(const UiElementRecord::CanvasState& canvas,
                                                 const CanvasSourceState& canvas_source, double sx,
                                                 double sy, double sw, double sh) {
    // The arguments are WebIDL longs: a non-finite one throws, the rest truncate.
    for (const double value : {sx, sy, sw, sh})
        if (!std::isfinite(value))
            throw js::NamedError("TypeError", "Failed to execute 'getImageData' on "
                                              "'CanvasRenderingContext2D': The provided value is "
                                              "non-finite.");
    auto x = static_cast<long long>(std::trunc(sx));
    auto y = static_cast<long long>(std::trunc(sy));
    auto width = static_cast<long long>(std::trunc(sw));
    auto height = static_cast<long long>(std::trunc(sh));
    if (width == 0 || height == 0)
        throw js::make_dom_exception(std::string("Failed to execute 'getImageData' on "
                                                 "'CanvasRenderingContext2D': The source ") +
                                         (width == 0 ? "width" : "height") + " is 0.",
                                     "IndexSizeError");
    if (width < 0) {
        x += width;
        width = -width;
    }
    if (height < 0) {
        y += height;
        height = -height;
    }
    const auto columns = static_cast<std::size_t>(width);
    const auto rows = static_cast<std::size_t>(height);
    const auto backing_width = static_cast<long long>(std::floor(canvas.width));
    const auto backing_height = static_cast<long long>(std::floor(canvas.height));
    // Premultiplied RGBA in [0, 1], stored as 8-bit after every draw as a canvas bitmap is.
    std::vector<float> pixels(columns * rows * 4, 0.0f);
    const auto at = [&](long long px, long long py) -> float* {
        if (px < x || py < y || px >= x + width || py >= y + height || px < 0 || py < 0 ||
            px >= backing_width || py >= backing_height)
            return nullptr;
        return &pixels[(static_cast<std::size_t>(py - y) * columns +
                        static_cast<std::size_t>(px - x)) *
                       4];
    };
    const auto blend = [&](long long px, long long py, const std::array<float, 4>& source) {
        float* pixel = at(px, py);
        if (!pixel)
            return;
        const float keep = 1.0f - source[3];
        for (std::size_t channel = 0; channel < 4; ++channel)
            pixel[channel] =
                std::round(std::clamp(source[channel] + pixel[channel] * keep, 0.0f, 1.0f) *
                           255.0f) /
                255.0f;
    };
    if (!canvas.pixels.empty())
        for (long long py = std::max(y, 0LL); py < std::min(y + height, backing_height); ++py)
            for (long long px = std::max(x, 0LL); px < std::min(x + width, backing_width); ++px) {
                const std::size_t offset =
                    (static_cast<std::size_t>(py) * static_cast<std::size_t>(backing_width) +
                     static_cast<std::size_t>(px)) *
                    4;
                if (offset + 3 >= canvas.pixels.size())
                    continue;
                float* pixel = at(px, py);
                for (std::size_t channel = 0; channel < 4; ++channel)
                    pixel[channel] = canvas.pixels[offset + channel] / 255.0f;
            }
    using Kind = UiElementRecord::CanvasDrawCommand::Kind;
    for (const auto& draw : canvas.draws) {
        if (draw.kind == Kind::FillRect) {
            const auto color = canvas_rgba(draw.color);
            const std::array<float, 4> premultiplied{color.red / 255.0f, color.green / 255.0f,
                                                     color.blue / 255.0f, color.alpha / 255.0f};
            const auto xs = canvas_coverage_bands(draw.destination_x,
                                                  draw.destination_x + draw.destination_width);
            const auto ys = canvas_coverage_bands(draw.destination_y,
                                                  draw.destination_y + draw.destination_height);
            for (const auto& band_y : ys)
                for (const auto& band_x : xs) {
                    const auto coverage = static_cast<float>(band_x.coverage * band_y.coverage);
                    if (coverage <= 0.0f)
                        continue;
                    std::array<float, 4> source{};
                    for (std::size_t channel = 0; channel < 4; ++channel)
                        source[channel] = premultiplied[channel] * coverage;
                    for (auto py = static_cast<long long>(band_y.start); py < band_y.end; ++py)
                        for (auto px = static_cast<long long>(band_x.start); px < band_x.end; ++px)
                            blend(px, py, source);
                }
            continue;
        }
        if (draw.kind != Kind::Blit || draw.points.size() != 4)
            throw std::runtime_error(
                "Reading back a Canvas2D path, stroke or text draw is not represented.");
        // The source's premultiplied pixels: an image bitmap, or a pixel-only canvas.
        int source_width = 0;
        int source_height = 0;
        const std::vector<std::uint8_t>* texels = nullptr;
        if (draw.bitmap) {
            source_width = draw.bitmap->width;
            source_height = draw.bitmap->height;
            texels = &draw.bitmap->pixels;
        } else {
            const auto& source = canvas_source(draw.source);
            if (!source.draws.empty())
                throw std::runtime_error(
                    "Reading back a blit of a canvas with retained draws is not represented.");
            source_width = static_cast<int>(std::floor(source.width));
            source_height = static_cast<int>(std::floor(source.height));
            texels = &source.pixels;
        }
        if (source_width <= 0 || source_height <= 0 ||
            texels->size() < static_cast<std::size_t>(source_width) * source_height * 4)
            continue;
        const auto texel = [&](int tx, int ty) {
            tx = std::clamp(tx, 0, source_width - 1);
            ty = std::clamp(ty, 0, source_height - 1);
            const std::size_t offset =
                (static_cast<std::size_t>(ty) * source_width + static_cast<std::size_t>(tx)) * 4;
            return std::array<float, 4>{(*texels)[offset] / 255.0f, (*texels)[offset + 1] / 255.0f,
                                        (*texels)[offset + 2] / 255.0f,
                                        (*texels)[offset + 3] / 255.0f};
        };
        // The destination quad maps the unit square: origin, u edge, v edge.
        const auto origin = draw.points[0];
        const double ux = draw.points[1].x - origin.x;
        const double uy = draw.points[1].y - origin.y;
        const double vx = draw.points[3].x - origin.x;
        const double vy = draw.points[3].y - origin.y;
        const double determinant = ux * vy - uy * vx;
        if (std::abs(determinant) < 1e-12)
            continue;
        double left = origin.x;
        double top = origin.y;
        double right = origin.x;
        double bottom = origin.y;
        for (const auto& point : draw.points) {
            left = std::min(left, point.x);
            top = std::min(top, point.y);
            right = std::max(right, point.x);
            bottom = std::max(bottom, point.y);
        }
        // Pixels whose centres the quad covers, as the UI compositor rasterizes it.
        for (auto py = static_cast<long long>(std::floor(top)); py < std::ceil(bottom); ++py)
            for (auto px = static_cast<long long>(std::floor(left)); px < std::ceil(right); ++px) {
                if (!at(px, py))
                    continue;
                const double dx = px + 0.5 - origin.x;
                const double dy = py + 0.5 - origin.y;
                const double u = (dx * vy - dy * vx) / determinant;
                const double v = (ux * dy - uy * dx) / determinant;
                if (u < 0.0 || u >= 1.0 || v < 0.0 || v >= 1.0)
                    continue;
                const double s = draw.source_x + u * draw.source_width;
                const double t = draw.source_y + v * draw.source_height;
                if (draw.nearest_sampling) {
                    blend(px, py,
                          texel(static_cast<int>(std::floor(s)), static_cast<int>(std::floor(t))));
                    continue;
                }
                // Bilinear between texel centres, clamped at the texture edge.
                const double fs = s - 0.5;
                const double ft = t - 0.5;
                const auto s0 = static_cast<int>(std::floor(fs));
                const auto t0 = static_cast<int>(std::floor(ft));
                const auto ws = static_cast<float>(fs - s0);
                const auto wt = static_cast<float>(ft - t0);
                const auto a = texel(s0, t0);
                const auto b = texel(s0 + 1, t0);
                const auto c = texel(s0, t0 + 1);
                const auto d = texel(s0 + 1, t0 + 1);
                std::array<float, 4> sample{};
                for (std::size_t channel = 0; channel < 4; ++channel)
                    sample[channel] = (a[channel] * (1 - ws) + b[channel] * ws) * (1 - wt) +
                                      (c[channel] * (1 - ws) + d[channel] * ws) * wt;
                blend(px, py, sample);
            }
    }
    // ImageData holds unpremultiplied bytes.
    std::vector<std::uint8_t> bytes(pixels.size(), 0);
    for (std::size_t offset = 0; offset < pixels.size(); offset += 4) {
        const float alpha = pixels[offset + 3];
        if (alpha <= 0.0f)
            continue;
        for (std::size_t channel = 0; channel < 3; ++channel)
            bytes[offset + channel] = static_cast<std::uint8_t>(
                std::lround(std::clamp(pixels[offset + channel] / alpha, 0.0f, 1.0f) * 255.0f));
        bytes[offset + 3] = static_cast<std::uint8_t>(std::lround(alpha * 255.0f));
    }
    return {static_cast<double>(width), static_cast<double>(height),
            js::U8Array(js::ArrayBuffer(std::move(bytes)))};
}

} // namespace bbl::pal

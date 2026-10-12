#pragma once

#include <RmlUi/Core/Colour.h>
#include <RmlUi/Core/Types.h>
#include <cmath>
#include <cstddef>
#include <vector>

namespace bbl::pal {

/**
 * Premultiplied RGBA pixels of a shape, each pixel `color` scaled by the
 * fraction of an 8x8 sample grid `inside(x, y)` accepts. Sample positions are
 * in CSS pixels from the texture origin, so one shape serves every density.
 */
template <typename Inside>
std::vector<Rml::byte> ui_coverage_pixels(int width, int height, float density,
                                          Rml::ColourbPremultiplied color, Inside inside) {
    constexpr int samples = 8;
    std::vector<Rml::byte> bytes(static_cast<std::size_t>(width) * height * 4);
    for (int y = 0; y < height; ++y)
        for (int x = 0; x < width; ++x) {
            int hits = 0;
            for (int sy = 0; sy < samples; ++sy)
                for (int sx = 0; sx < samples; ++sx)
                    hits += inside((x + (sx + .5f) / samples) / density,
                                   (y + (sy + .5f) / samples) / density)
                                ? 1
                                : 0;
            const float coverage = static_cast<float>(hits) / (samples * samples);
            const auto pixel = static_cast<std::size_t>(y * width + x) * 4;
            bytes[pixel] = static_cast<Rml::byte>(std::lround(color.red * coverage));
            bytes[pixel + 1] = static_cast<Rml::byte>(std::lround(color.green * coverage));
            bytes[pixel + 2] = static_cast<Rml::byte>(std::lround(color.blue * coverage));
            bytes[pixel + 3] = static_cast<Rml::byte>(std::lround(color.alpha * coverage));
        }
    return bytes;
}

} // namespace bbl::pal

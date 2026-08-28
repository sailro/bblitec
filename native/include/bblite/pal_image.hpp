#pragma once

#include <bblite/js_data.hpp>

#include <cstdint>
#include <vector>

namespace bbl::pal {

struct DecodedImage {
    int width = 0;
    int height = 0;
    std::vector<std::uint8_t> rgba;
};

DecodedImage decode_image(const js::ArrayBuffer& buffer);

inline void premultiply_image_alpha(DecodedImage& image) {
    for (std::size_t index = 0; index + 3 < image.rgba.size(); index += 4) {
        const std::uint32_t alpha = image.rgba[index + 3];
        for (std::size_t channel = 0; channel < 3; ++channel) {
            image.rgba[index + channel] = static_cast<std::uint8_t>(
                (static_cast<std::uint32_t>(image.rgba[index + channel]) *
                     alpha +
                 127u) /
                255u);
        }
    }
}

} // namespace bbl::pal

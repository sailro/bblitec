#pragma once

#include <bblite/js_data.hpp>

#include <cstdint>
#include <mutex>
#include <span>
#include <vector>

namespace bbl::pal {

struct DecodedImage {
    int width = 0;
    int height = 0;
    std::vector<std::uint8_t> rgba;
};

inline std::mutex& image_decoder_mutex() {
    static std::mutex mutex;
    return mutex;
}

DecodedImage decode_image(std::span<const std::uint8_t> bytes);

inline DecodedImage decode_image(const js::ArrayBuffer& buffer) {
    return decode_image(std::span<const std::uint8_t>{buffer.data(), buffer.byte_length()});
}

inline void premultiply_image_alpha(DecodedImage& image) {
    for (std::size_t index = 0; index + 3 < image.rgba.size(); index += 4) {
        const std::uint32_t alpha = image.rgba[index + 3];
        for (std::size_t channel = 0; channel < 3; ++channel) {
            image.rgba[index + channel] = static_cast<std::uint8_t>(
                (static_cast<std::uint32_t>(image.rgba[index + channel]) * alpha + 127u) / 255u);
        }
    }
}

} // namespace bbl::pal

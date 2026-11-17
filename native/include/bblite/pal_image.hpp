#pragma once

#include <bblite/js_data.hpp>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace bbl::pal {

struct DecodedImage {
    int width = 0;
    int height = 0;
    std::vector<std::uint8_t> rgba;
};

/**
 * Serializes SDL_image codec calls process-wide: every load and save runs
 * its codec's initializer (IMG_InitPNG, IMG_InitJPG, ...), which updates
 * unsynchronized library state.
 */
inline std::mutex& image_decoder_mutex() {
    static std::mutex mutex;
    return mutex;
}

DecodedImage decode_image(std::span<const std::uint8_t> bytes);

/** An encoded image: the MIME type it is in and its bytes. */
struct EncodedImage {
    std::string type;
    std::vector<std::uint8_t> bytes;
};

/**
 * Straight-alpha RGBA rows serialized as a canvas serializes its bitmap: `image/jpeg` (ASCII
 * case-insensitive) encodes at Chromium's quality, `quality` in [0, 1] times 100 rounded and
 * 0.92 otherwise, with each pixel composited onto opaque black; any other type is PNG.
 */
EncodedImage encode_image(std::span<const std::uint8_t> rgba, int width, int height,
                          const std::string& type, std::optional<double> quality);

/**
 * `canvas.toDataURL(type, quality)`: `encode_image`'s bytes as a base64 data: URL; a canvas
 * without pixels gives "data:,".
 */
std::string encode_image_data_url(std::span<const std::uint8_t> rgba, int width, int height,
                                  const std::string& type, std::optional<double> quality);

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

/**
 * The pin's upload transforms of decoded texels, the one owner of their
 * rule: `premultiplyAlpha` premultiplies (`createImageBitmap`), and
 * `invertY` flips the rows (`copyExternalImageToTexture`'s `flipY`).
 */
inline void orient_image(DecodedImage& image, bool invert_y, bool premultiply_alpha) {
    if (premultiply_alpha)
        premultiply_image_alpha(image);
    if (!invert_y)
        return;
    const auto row_bytes = static_cast<std::ptrdiff_t>(image.width) * 4;
    for (int top = 0, bottom = image.height - 1; top < bottom; ++top, --bottom) {
        const auto first = image.rgba.begin() + top * row_bytes;
        std::swap_ranges(first, first + row_bytes, image.rgba.begin() + bottom * row_bytes);
    }
}

} // namespace bbl::pal

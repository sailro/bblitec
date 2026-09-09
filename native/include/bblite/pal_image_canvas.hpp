#pragma once

#include <bblite/pal_image.hpp>

#include <cmath>
#include <limits>
#include <stdexcept>
#include <string_view>

namespace bbl::pal {

inline void image_data_store(std::vector<std::uint8_t>& data, double index, double value) {
    if (!std::isfinite(index) || index < 0 || std::floor(index) != index || index >= static_cast<double>(data.size())) return;
    // ImageData uses Uint8ClampedArray, including ties-to-even rounding.
    std::uint8_t byte = 0;
    if (value >= 255) byte = 255;
    else if (value > 0) {
        const double lower = std::floor(value);
        const double fraction = value - lower;
        byte = static_cast<std::uint8_t>(lower);
        if (fraction > 0.5 || (fraction == 0.5 && byte % 2 != 0)) ++byte;
    }
    data[static_cast<std::size_t>(index)] = byte;
}

// CPU Canvas2D transport for complete, unscaled opaque bitmap transfers.
class ImageCanvas {
    DecodedImage image_;

    static int dimension(double value) {
        if (!std::isfinite(value) || value < 1 || value > std::numeric_limits<int>::max() || std::floor(value) != value)
            throw std::runtime_error("Unsupported image canvas dimension.");
        return static_cast<int>(value);
    }

    void full_rectangle(double x, double y, double width, double height) const {
        if (x != 0 || y != 0 || width != image_.width || height != image_.height)
            throw std::runtime_error("Image canvas requires a complete origin-aligned rectangle.");
    }

    void compatible(const DecodedImage& image) const {
        if (image.width != image_.width || image.height != image_.height || image.rgba.size() != image_.rgba.size())
            throw std::runtime_error("Image canvas scaling is unsupported.");
    }

    static void opaque(const DecodedImage& image) {
        for (std::size_t index = 3; index < image.rgba.size(); index += 4)
            if (image.rgba[index] != 255) throw std::runtime_error("Image canvas alpha compositing is unsupported.");
    }

public:
    ImageCanvas(double width, double height) {
        image_.width = dimension(width);
        image_.height = dimension(height);
        const auto width_bytes = static_cast<std::size_t>(image_.width) * 4;
        if (static_cast<std::size_t>(image_.height) > image_.rgba.max_size() / width_bytes)
            throw std::runtime_error("Image canvas dimensions exceed storage.");
        image_.rgba.resize(width_bytes * static_cast<std::size_t>(image_.height));
    }

    ImageCanvas& context(std::string_view kind) {
        if (kind != "2d") throw std::runtime_error("Image canvas requires a 2d context.");
        return *this;
    }

    void draw_image(const DecodedImage& image, double x, double y, double width, double height) {
        full_rectangle(x, y, width, height);
        compatible(image);
        opaque(image);
        image_.rgba = image.rgba;
    }

    DecodedImage get_image_data(double x, double y, double width, double height) const {
        full_rectangle(x, y, width, height);
        return image_;
    }

    void put_image_data(const DecodedImage& image, double x, double y) {
        full_rectangle(x, y, image.width, image.height);
        compatible(image);
        image_ = image;
    }

    DecodedImage bitmap() const { opaque(image_); return image_; }
};

} // namespace bbl::pal

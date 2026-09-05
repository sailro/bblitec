#include "pinned_rgbd.hpp"
#include "pinned_texture.hpp"
#include <bit>
#include <cstdio>
#include <stdexcept>

int main() {
    for (unsigned alpha = 0; alpha < 256; ++alpha) {
        for (unsigned color = 0; color < 256; ++color) {
            const std::uint8_t rgba[] = {static_cast<std::uint8_t>(color),
                static_cast<std::uint8_t>(255 - color), static_cast<std::uint8_t>(color / 2), static_cast<std::uint8_t>(alpha)};
            const auto pixel = bbl::upstream::decode_rgbd_pixel(rgba);
            for (unsigned lane = 0; lane < 3; ++lane) {
                const float baseline = std::pow(static_cast<float>(rgba[lane]) / 255.0f, 2.2f) /
                    std::max(static_cast<float>(alpha) / 255.0f, 1.0f / 255.0f);
                if (std::bit_cast<std::uint32_t>(pixel[lane]) != std::bit_cast<std::uint32_t>(baseline))
                    throw std::runtime_error("RGBD f32 result changed before half packing");
            }
            if (pixel[3] != 1.0f) throw std::runtime_error("RGBD opacity changed");
        }
    }
    for (unsigned width = 1; width <= 8192; width = width * 2 + 1) {
        for (unsigned height = 1; height <= 8192; height = height * 2 + 1) {
            const double full = std::floor(std::log2(static_cast<double>(std::max(width, height)))) + 1;
            if (bbl::upstream::mip_level_count(width, height) != full ||
                bbl::upstream::transmission_mip_level_count(width, height) != std::max(1.0, full - 4))
                throw std::runtime_error("Mip allocation changed");
        }
    }
    std::puts("pinned-texture-check: ok");
}

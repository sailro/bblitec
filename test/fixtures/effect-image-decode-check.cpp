#include <bblite/pal_texture_texels.hpp>
#include <SDL3/SDL.h>
#if BBLITE_HAS_IMAGE_DECODER
#include <SDL3_image/SDL_image.h>
#endif
#include <cassert>
#include <future>
#include "image.hpp"

namespace bbl::pal {
std::string environment_variable(const char*) { return {}; }
} // namespace bbl::pal

int main() {
    const bbl::js::ArrayBuffer input(png_bytes);
    bbl::TextureData texture;
    texture.bytes = png_bytes;
    texture.loaded_texels =
        std::make_shared<bbl::pal::LoadedTexels>(bbl::pal::DecodedImage{3, 2, expected_pixels});
    const auto held = bbl::pal::texture_image_texels(texture);
    assert(held.width == 3 && held.height == 2 && held.rgba == expected_pixels);
    texture.invert_y = true;
    texture.premultiply_alpha = true;
#if BBLITE_HAS_IMAGE_DECODER
    const auto oriented = bbl::pal::texture_image_texels(texture);
    const std::vector<std::uint8_t> expected_oriented{
        2, 4, 6, 44, 19, 23, 27, 88, 51, 57, 63, 132, 255, 0, 0, 255, 0, 128, 0, 128, 0, 0, 0, 0};
    assert(oriented.width == 3 && oriented.height == 2 && oriented.rgba == expected_oriented);
    for (const auto& fixture : png16_cases) {
        SDL_Surface* surface =
            IMG_Load_IO(SDL_IOFromConstMem(fixture.bytes.data(), fixture.bytes.size()), true);
        assert(surface && surface->w == 3 && surface->h == 2);
        assert(surface->format == (fixture.alpha ? SDL_PIXELFORMAT_RGBA64 : SDL_PIXELFORMAT_RGB48));
        const std::size_t row_samples = fixture.alpha ? 12 : 9;
        // Three RGB48 pixels leave row padding; sample checks must cross it.
        assert(fixture.alpha || surface->pitch > static_cast<int>(row_samples * sizeof(Uint16)));
        for (int y = 0; y < surface->h; ++y) {
            const auto* row = reinterpret_cast<const Uint16*>(
                static_cast<const Uint8*>(surface->pixels) + y * surface->pitch);
            assert(std::equal(row, row + row_samples, fixture.samples.begin() + y * row_samples));
        }
        SDL_DestroySurface(surface);
        const auto image = bbl::pal::decode_image(std::span<const std::uint8_t>{fixture.bytes});
        assert(image.width == 3 && image.height == 2 && image.rgba == fixture.rgba);
    }
    std::vector<std::future<bbl::pal::DecodedImage>> native_decodes;
    for (int index = 0; index < 8; ++index)
        native_decodes.push_back(std::async(std::launch::async, [] {
            return bbl::pal::decode_image(std::span<const std::uint8_t>{png_bytes});
        }));
    for (auto& result : native_decodes) {
        const auto image = result.get();
        assert(image.width == 3 && image.height == 2 && image.rgba == expected_pixels);
    }
    const auto decoded = bbl::pal::decode_image(input);
    assert(decoded.width == 3 && decoded.height == 2);
    assert(decoded.rgba == expected_pixels);
    assert(input.byte_length() == png_bytes.size());
    assert(std::equal(png_bytes.begin(), png_bytes.end(), input.data()));
    for (const auto& bytes :
         {std::vector<std::uint8_t>{}, std::vector<std::uint8_t>{1, 2, 3},
          std::vector<std::uint8_t>(png_bytes.begin(), png_bytes.begin() + 16)}) {
        try {
            static_cast<void>(bbl::pal::decode_image(bbl::js::ArrayBuffer(bytes)));
            assert(false);
        } catch (const std::runtime_error& error) {
            const std::string_view message(error.what());
            assert(message.starts_with("Unable to open image:") ||
                   message.starts_with("Unable to decode image:"));
        }
    }
#else
    for (int path = 0; path < 2; ++path) {
        bool refused = false;
        try {
            if (path == 0)
                static_cast<void>(bbl::pal::decode_image(input));
            else
                static_cast<void>(bbl::pal::texture_image_texels(texture));
        } catch (const std::runtime_error& error) {
            assert(std::string_view(error.what()) ==
                   "This scene was built without image decoding.");
            refused = true;
        }
        assert(refused);
    }
#endif
}

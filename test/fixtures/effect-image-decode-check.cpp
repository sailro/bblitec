#include "pal_sdl.cpp"
#include <cassert>
#include "image.hpp"

namespace bbl::pal {
std::string environment_variable(const char*) { return {}; }
}

int main() {
    const bbl::js::ArrayBuffer input(png_bytes);
#if BBLITE_HAS_IMAGE_DECODER
    const auto decoded = bbl::pal::decode_image(input);
    assert(decoded.width == 3 && decoded.height == 2);
    assert(decoded.rgba == expected_pixels);
    assert(input.byte_length() == png_bytes.size());
    assert(std::equal(png_bytes.begin(), png_bytes.end(), input.data()));
    for (const auto& bytes : {std::vector<std::uint8_t>{}, std::vector<std::uint8_t>{1, 2, 3},
            std::vector<std::uint8_t>(png_bytes.begin(), png_bytes.begin() + 16)}) {
        try { static_cast<void>(bbl::pal::decode_image(bbl::js::ArrayBuffer(bytes))); assert(false); }
        catch (const std::runtime_error& error) {
            const std::string_view message(error.what());
            assert(message.starts_with("Unable to open image:") || message.starts_with("Unable to decode image:"));
        }
    }
#else
    try { static_cast<void>(bbl::pal::decode_image(input)); assert(false); }
    catch (const std::runtime_error& error) {
        assert(std::string_view(error.what()) == "This scene was built without image decoding.");
    }
#endif
}

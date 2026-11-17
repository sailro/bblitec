// `canvas.toDataURL`'s encoder (`pal::encode_image_data_url`): each case prints
// its data URL's prefix and the pixels decoding its payload gives back.

#include <bblite/pal_image.hpp>

#include <cstdint>
#include <cstdio>
#include <optional>
#include <string>
#include <vector>

namespace {
std::vector<std::uint8_t> base64_bytes(const std::string& text) {
    static const std::string alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::vector<std::uint8_t> bytes;
    std::uint32_t chunk = 0;
    int bits = 0;
    for (const char character : text) {
        const auto value = alphabet.find(character);
        if (value == std::string::npos)
            continue;
        chunk = (chunk << 6) | static_cast<std::uint32_t>(value);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes.push_back(static_cast<std::uint8_t>((chunk >> bits) & 0xFF));
        }
    }
    return bytes;
}

void print_case(const char* label, const std::vector<std::uint8_t>& rgba, const std::string& type,
                std::optional<double> quality) {
    const std::string url = bbl::pal::encode_image_data_url(rgba, 3, 2, type, quality);
    const auto comma = url.find(',');
    std::printf("%s %s", label, url.substr(0, comma + 1).c_str());
    if (url.size() > comma + 1) {
        const auto image = bbl::pal::decode_image(base64_bytes(url.substr(comma + 1)));
        std::printf(" %dx%d", image.width, image.height);
        for (const std::uint8_t byte : image.rgba)
            std::printf(" %u", byte);
        std::printf(" bytes=%zu", url.size());
    }
    std::printf("\n");
}
} // namespace

int main() {
    // Opaque red, half-transparent green, transparent blue; opaque white, black, grey.
    const std::vector<std::uint8_t> rgba{255, 0,   0,   255, 0, 255, 0, 128, 0,   0,   255, 0,
                                         255, 255, 255, 255, 0, 0,   0, 255, 128, 128, 128, 255};
    print_case("png", rgba, "image/png", std::nullopt);
    print_case("unknown", rgba, "image/bmp", 0.5);
    print_case("jpeg", rgba, "IMAGE/JPEG", 1.0);
    print_case("default", rgba, "image/jpeg", std::nullopt);
    print_case("explicit", rgba, "image/jpeg", 0.92);
    print_case("outside", rgba, "image/jpeg", 2.0);
    print_case("low", rgba, "image/jpeg", 0.1);
    std::printf("empty %s\n", bbl::pal::encode_image_data_url({}, 0, 0, "", std::nullopt).c_str());
}

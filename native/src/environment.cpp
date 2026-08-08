#include <bblite/runtime.hpp>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <string_view>
#include <utility>
#include <vector>

namespace bbl {
namespace {

struct MipmapEntry {
    std::size_t position = 0;
    std::size_t length = 0;
};

std::vector<std::uint8_t> read_file(const std::string& path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream) {
        throw std::runtime_error("Unable to open environment file '" + path + "'.");
    }
    return std::vector<std::uint8_t>(
        std::istreambuf_iterator<char>(stream),
        std::istreambuf_iterator<char>());
}

void skip_space(std::string_view text, std::size_t& position) {
    while (position < text.size() && std::isspace(static_cast<unsigned char>(text[position]))) {
        ++position;
    }
}

double parse_number(std::string_view text, std::size_t& position) {
    skip_space(text, position);
    const char* begin = text.data() + position;
    char* end = nullptr;
    const double value = std::strtod(begin, &end);
    if (end == begin) {
        throw std::runtime_error("Invalid number in environment manifest.");
    }
    position = static_cast<std::size_t>(end - text.data());
    return value;
}

std::size_t find_value(std::string_view text, std::string_view key, std::size_t start = 0) {
    const std::string quoted = "\"" + std::string(key) + "\"";
    const std::size_t key_position = text.find(quoted, start);
    if (key_position == std::string_view::npos) {
        throw std::runtime_error("Environment manifest is missing '" + std::string(key) + "'.");
    }
    const std::size_t colon = text.find(':', key_position + quoted.size());
    if (colon == std::string_view::npos) {
        throw std::runtime_error("Invalid environment manifest field '" + std::string(key) + "'.");
    }
    return colon + 1;
}

std::size_t parse_unsigned(std::string_view text, std::string_view key, std::size_t start = 0) {
    std::size_t position = find_value(text, key, start);
    const double value = parse_number(text, position);
    if (value < 0.0) {
        throw std::runtime_error("Environment manifest contains a negative unsigned value.");
    }
    return static_cast<std::size_t>(value);
}

Color3 parse_color(std::string_view text, std::string_view key, std::size_t start) {
    std::size_t position = find_value(text, key, start);
    position = text.find('[', position);
    if (position == std::string_view::npos) {
        throw std::runtime_error("Invalid environment color coefficient.");
    }
    ++position;
    Color3 result;
    result.r = static_cast<float>(parse_number(text, position));
    position = text.find(',', position);
    if (position == std::string_view::npos) throw std::runtime_error("Invalid environment color coefficient.");
    ++position;
    result.g = static_cast<float>(parse_number(text, position));
    position = text.find(',', position);
    if (position == std::string_view::npos) throw std::runtime_error("Invalid environment color coefficient.");
    ++position;
    result.b = static_cast<float>(parse_number(text, position));
    return result;
}

float channel(const Color3& color, int index) {
    return index == 0 ? color.r : index == 1 ? color.g : color.b;
}

void set_channel(Color3& color, int index, float value) {
    if (index == 0) {
        color.r = value;
    } else if (index == 1) {
        color.g = value;
    } else {
        color.b = value;
    }
}

std::array<Color3, 9> pre_scale_harmonics(const std::array<Color3, 9>& polynomial) {
    constexpr float c00xy = 0.3333338747897695f;
    constexpr float c00z = 0.33333298856284405f;
    constexpr float c1 = 1.4999984284682104f;
    constexpr float c2 = 3.999982863580422f;
    constexpr float c20zz = 1.3333326611423701f;
    constexpr float c20xy = 0.6666653397393608f;
    constexpr float c22 = 1.999991431790211f;

    std::array<Color3, 9> result{};
    for (int index = 0; index < 3; ++index) {
        const float x = channel(polynomial[0], index);
        const float y = channel(polynomial[1], index);
        const float z = channel(polynomial[2], index);
        const float xx = channel(polynomial[3], index);
        const float yy = channel(polynomial[4], index);
        const float zz = channel(polynomial[5], index);
        const float yz = channel(polynomial[6], index);
        const float zx = channel(polynomial[7], index);
        const float xy = channel(polynomial[8], index);
        set_channel(result[0], index, (xx + yy) * c00xy + zz * c00z);
        set_channel(result[1], index, y * c1);
        set_channel(result[2], index, z * c1);
        set_channel(result[3], index, x * c1);
        set_channel(result[4], index, xy * c2);
        set_channel(result[5], index, yz * c2);
        set_channel(result[6], index, zz * c20zz - (xx + yy) * c20xy);
        set_channel(result[7], index, zx * c2);
        set_channel(result[8], index, (xx - yy) * c22);
    }
    return result;
}

std::vector<MipmapEntry> parse_mipmaps(std::string_view manifest) {
    const std::size_t mipmaps_position = manifest.find("\"mipmaps\"");
    if (mipmaps_position == std::string_view::npos) {
        throw std::runtime_error("Environment manifest has no specular mipmaps.");
    }
    const std::size_t array_start = manifest.find('[', mipmaps_position);
    const std::size_t array_end = manifest.find(']', array_start);
    if (array_start == std::string_view::npos || array_end == std::string_view::npos) {
        throw std::runtime_error("Invalid environment mipmap array.");
    }

    std::vector<MipmapEntry> result;
    std::size_t cursor = array_start;
    while (true) {
        const std::size_t length_key = manifest.find("\"length\"", cursor);
        if (length_key == std::string_view::npos || length_key >= array_end) {
            break;
        }
        const std::size_t position_key = manifest.find("\"position\"", length_key);
        if (position_key == std::string_view::npos || position_key >= array_end) {
            throw std::runtime_error("Invalid environment mipmap entry.");
        }
        result.push_back(MipmapEntry{
            parse_unsigned(manifest, "position", position_key),
            parse_unsigned(manifest, "length", length_key),
        });
        cursor = position_key + 10;
    }
    if (result.empty() || result.size() % 6 != 0) {
        throw std::runtime_error("Environment mipmap count is not six faces per level.");
    }
    return result;
}

} // namespace

void load_environment(Scene& scene, EnvironmentOptions options) {
    static constexpr std::array<std::uint8_t, 8> magic{
        0x86, 0x16, 0x87, 0x96, 0xf6, 0xd6, 0x96, 0x36,
    };
    const std::vector<std::uint8_t> bytes = read_file(options.environment_url);
    if (bytes.size() < magic.size() + 2 || !std::equal(magic.begin(), magic.end(), bytes.begin())) {
        throw std::runtime_error("Invalid Babylon environment file.");
    }

    const auto null_terminator = std::find(bytes.begin() + 8, bytes.end(), std::uint8_t{0});
    if (null_terminator == bytes.end()) {
        throw std::runtime_error("Environment manifest has no null terminator.");
    }
    const std::size_t json_end = static_cast<std::size_t>(null_terminator - bytes.begin());
    const std::string_view manifest(
        reinterpret_cast<const char*>(bytes.data() + 8),
        json_end - 8);
    const std::size_t irradiance_start = manifest.find("\"irradiance\"");
    if (irradiance_start == std::string_view::npos) {
        throw std::runtime_error("Environment manifest has no irradiance data.");
    }

    const std::array<std::string_view, 9> coefficient_names{
        "x", "y", "z", "xx", "yy", "zz", "yz", "zx", "xy",
    };
    std::array<Color3, 9> polynomial{};
    for (std::size_t index = 0; index < coefficient_names.size(); ++index) {
        polynomial[index] = parse_color(manifest, coefficient_names[index], irradiance_start);
    }

    const std::vector<MipmapEntry> mipmaps = parse_mipmaps(manifest);
    const std::size_t binary_start = json_end + 1;

    scene.environment.enabled = true;
    scene.environment.has_irradiance = true;
    scene.environment.spherical_harmonics = pre_scale_harmonics(polynomial);
    scene.environment.specular_width = static_cast<std::uint32_t>(parse_unsigned(manifest, "width"));
    scene.environment.specular_mip_count = static_cast<std::uint32_t>(mipmaps.size() / 6);
    scene.environment.specular_faces.clear();
    scene.environment.specular_faces.reserve(mipmaps.size());
    for (const MipmapEntry& mipmap : mipmaps) {
        const std::size_t start = binary_start + mipmap.position;
        const std::size_t end = start + mipmap.length;
        if (end > bytes.size()) {
            throw std::runtime_error("Environment mipmap extends beyond the file.");
        }
        TextureData face;
        face.mime_type = "image/png";
        face.bytes.assign(bytes.begin() + static_cast<std::ptrdiff_t>(start), bytes.begin() + static_cast<std::ptrdiff_t>(end));
        scene.environment.specular_faces.push_back(std::move(face));
    }
    scene.environment.brdf_lut = {};
    if (!options.brdf_url.empty()) {
        scene.environment.brdf_lut.bytes = read_file(options.brdf_url);
        scene.environment.brdf_lut.mime_type = "image/png";
    }
    scene.environment.source_url = std::move(options.environment_url);
    scene.clear_color = Color4{0.2f, 0.2f, 0.29f, 1.0f};
}

} // namespace bbl

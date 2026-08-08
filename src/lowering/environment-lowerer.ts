import { LoweredSource, LoweringContext } from "./context.js";

interface EnvironmentConstants {
    magic: number[];
    coefficientNames: string[];
    imageType: string;
    harmonicConstants: number[];
}

export class EnvironmentLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerParser(): LoweredSource {
        const modulePath = "src/loader-env/env-parse.ts";
        const symbolName = "parseEnvFile";
        const constants = this.extractConstants();
        const magic = constants.magic
            .map((value) => `0x${value.toString(16).padStart(2, "0")}`)
            .join(", ");
        const keys = constants.coefficientNames.map((value) => `"${value}"`).join(", ");
        const harmonic = constants.harmonicConstants.map((value) => this.context.floatLiteral(value));
        return {
            modulePath,
            symbolName,
            header: `#pragma once

#include <bblite/runtime.hpp>

#include <array>
#include <cstdint>
#include <vector>

namespace bbl::upstream {

struct ParsedEnvironment {
    std::array<Color3, 9> spherical_harmonics{};
    std::uint32_t width = 0;
    std::uint32_t mip_count = 0;
    std::vector<TextureData> faces;
};

ParsedEnvironment parse_env_file(const std::vector<std::uint8_t>& bytes);

} // namespace bbl::upstream
`,
            source: `// ${this.context.provenance(
                modulePath,
                symbolName,
                "src/loader-env/load-env.ts#polynomialToPreScaledHarmonics",
            )}
#include <bblite/upstream/env_parse.hpp>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <string_view>

namespace bbl::upstream {
namespace {

struct MipmapEntry {
    std::size_t position = 0;
    std::size_t length = 0;
};

void skip_space(std::string_view text, std::size_t& position) {
    while (position < text.size() && std::isspace(static_cast<unsigned char>(text[position]))) ++position;
}

double parse_number(std::string_view text, std::size_t& position) {
    skip_space(text, position);
    const char* begin = text.data() + position;
    char* end = nullptr;
    const double value = std::strtod(begin, &end);
    if (end == begin) throw std::runtime_error("Invalid number in environment manifest.");
    position = static_cast<std::size_t>(end - text.data());
    return value;
}

std::size_t find_value(std::string_view text, std::string_view key, std::size_t start = 0) {
    const std::string quoted = "\\\"" + std::string(key) + "\\\"";
    const std::size_t key_position = text.find(quoted, start);
    if (key_position == std::string_view::npos) {
        throw std::runtime_error("Environment manifest is missing '" + std::string(key) + "'.");
    }
    const std::size_t colon = text.find(':', key_position + quoted.size());
    if (colon == std::string_view::npos) throw std::runtime_error("Invalid environment manifest.");
    return colon + 1;
}

std::size_t parse_unsigned(std::string_view text, std::string_view key, std::size_t start = 0) {
    std::size_t position = find_value(text, key, start);
    const double value = parse_number(text, position);
    if (value < 0.0) throw std::runtime_error("Negative environment manifest value.");
    return static_cast<std::size_t>(value);
}

Color3 parse_color(std::string_view text, std::string_view key, std::size_t start) {
    std::size_t position = text.find('[', find_value(text, key, start));
    if (position == std::string_view::npos) throw std::runtime_error("Invalid environment coefficient.");
    ++position;
    Color3 result;
    result.r = static_cast<float>(parse_number(text, position));
    position = text.find(',', position) + 1;
    result.g = static_cast<float>(parse_number(text, position));
    position = text.find(',', position) + 1;
    result.b = static_cast<float>(parse_number(text, position));
    return result;
}

float channel(const Color3& color, int index) {
    return index == 0 ? color.r : index == 1 ? color.g : color.b;
}

void set_channel(Color3& color, int index, float value) {
    if (index == 0) color.r = value;
    else if (index == 1) color.g = value;
    else color.b = value;
}

std::array<Color3, 9> pre_scale_harmonics(const std::array<Color3, 9>& polynomial) {
    constexpr float c00xy = ${harmonic[0]};
    constexpr float c00z = ${harmonic[1]};
    constexpr float c1 = ${harmonic[2]};
    constexpr float c2 = ${harmonic[3]};
    constexpr float c20zz = ${harmonic[4]};
    constexpr float c20xy = ${harmonic[5]};
    constexpr float c22 = ${harmonic[6]};
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
    const std::size_t start = manifest.find("\\\"mipmaps\\\"");
    const std::size_t array_start = manifest.find('[', start);
    const std::size_t array_end = manifest.find(']', array_start);
    if (start == std::string_view::npos || array_start == std::string_view::npos || array_end == std::string_view::npos) {
        throw std::runtime_error("Invalid environment mipmap array.");
    }
    std::vector<MipmapEntry> result;
    std::size_t cursor = array_start;
    while (true) {
        const std::size_t length_key = manifest.find("\\\"length\\\"", cursor);
        if (length_key == std::string_view::npos || length_key >= array_end) break;
        const std::size_t position_key = manifest.find("\\\"position\\\"", length_key);
        if (position_key == std::string_view::npos || position_key >= array_end) {
            throw std::runtime_error("Invalid environment mipmap entry.");
        }
        result.push_back(MipmapEntry{
            parse_unsigned(manifest, "position", position_key),
            parse_unsigned(manifest, "length", length_key),
        });
        cursor = position_key + 10;
    }
    return result;
}

std::uint32_t mip_level_count(std::uint32_t width) {
    std::uint32_t count = 1;
    while (width > 1) {
        width >>= 1;
        ++count;
    }
    return count;
}

} // namespace

ParsedEnvironment parse_env_file(const std::vector<std::uint8_t>& bytes) {
    static constexpr std::array<std::uint8_t, 8> magic{${magic}};
    if (bytes.size() < magic.size() + 2 || !std::equal(magic.begin(), magic.end(), bytes.begin())) {
        throw std::runtime_error("Invalid .env file: bad magic");
    }
    const auto terminator = std::find(bytes.begin() + 8, bytes.end(), std::uint8_t{0});
    if (terminator == bytes.end()) throw std::runtime_error("Invalid .env manifest.");
    const std::size_t json_end = static_cast<std::size_t>(terminator - bytes.begin());
    const std::size_t binary_start = json_end + 1;
    const std::string_view manifest(
        reinterpret_cast<const char*>(bytes.data() + 8),
        json_end - 8);
    const std::size_t irradiance_start = manifest.find("\\\"irradiance\\\"");
    if (irradiance_start == std::string_view::npos) throw std::runtime_error("Missing irradiance.");
    const std::array<std::string_view, 9> coefficient_names{${keys}};
    std::array<Color3, 9> polynomial{};
    for (std::size_t index = 0; index < coefficient_names.size(); ++index) {
        polynomial[index] = parse_color(manifest, coefficient_names[index], irradiance_start);
    }
    const std::uint32_t width = static_cast<std::uint32_t>(parse_unsigned(manifest, "width"));
    const std::uint32_t mip_count = mip_level_count(width);
    const std::vector<MipmapEntry> mipmaps = parse_mipmaps(manifest);
    if (mipmaps.size() != static_cast<std::size_t>(mip_count) * 6) {
        throw std::runtime_error("Environment mipmap count is not six faces per level.");
    }

    ParsedEnvironment result;
    result.spherical_harmonics = pre_scale_harmonics(polynomial);
    result.width = width;
    result.mip_count = mip_count;
    result.faces.reserve(mipmaps.size());
    for (const MipmapEntry& mipmap : mipmaps) {
        const std::size_t start = binary_start + mipmap.position;
        const std::size_t end = start + mipmap.length;
        if (end > bytes.size()) throw std::runtime_error("Environment mipmap exceeds file.");
        TextureData face;
        face.mime_type = "${constants.imageType}";
        face.bytes.assign(
            bytes.begin() + static_cast<std::ptrdiff_t>(start),
            bytes.begin() + static_cast<std::ptrdiff_t>(end));
        result.faces.push_back(std::move(face));
    }
    return result;
}

} // namespace bbl::upstream
`,
        };
    }

    private extractConstants(): EnvironmentConstants {
        const parser = this.context.store.getSource("src/loader-env/env-parse.ts");
        const loader = this.context.store.getSource("src/loader-env/load-env.ts");
        const magicMatch = parser.match(/ENV_MAGIC\s*=\s*new U8\(\[([^\]]+)\]\)/);
        const keysMatch = parser.match(/shKeys\s*=\s*\[([^\]]+)\]/);
        const imageTypeMatch = parser.match(/manifest\.imageType\s*\|\|\s*"([^"]+)"/);
        if (!magicMatch?.[1] || !keysMatch?.[1] || !imageTypeMatch?.[1]) {
            throw new Error("Unable to extract upstream environment parser constants.");
        }
        const constant = (name: string): number =>
            this.context.extractNumber(
                loader,
                new RegExp(`const ${name} = ([0-9.]+)`),
                `harmonic ${name}`,
            );
        return {
            magic: magicMatch[1].split(",").map((value) => Number(value.trim())),
            coefficientNames: [...keysMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]!),
            imageType: imageTypeMatch[1],
            harmonicConstants: [
                constant("C00xy"),
                constant("C00z"),
                constant("C1"),
                constant("C2"),
                constant("C20zz"),
                constant("C20xy"),
                constant("C22"),
            ],
        };
    }
}

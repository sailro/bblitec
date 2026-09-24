// Texel data both backends upload and read back, whatever the scene
// reaches: the half-float packing, the decoded image a texture uploads,
// the compressed-texture copy geometry, and the readback row conversion.
// Reads no generated header, so its unit compiles once for every scene.
#pragma once
#include <bblite/pal_image.hpp>
#include <bblite/runtime.hpp>

#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <ostream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "pal_compressed_formats.hpp"

namespace bbl::pal {

inline std::uint16_t float_to_half(float value) {
    std::uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    const std::uint16_t sign = static_cast<std::uint16_t>((bits >> 16) & 0x8000u);
    const std::uint32_t exponent = (bits >> 23) & 0xffu;
    const std::uint32_t mantissa = bits & 0x7fffffu;
    if (exponent == 0xffu) {
        return static_cast<std::uint16_t>(sign | (mantissa == 0 ? 0x7c00u : 0x7e00u));
    }
    const int half_exponent = static_cast<int>(exponent) - 127 + 15;
    if (half_exponent >= 0x1f) {
        return static_cast<std::uint16_t>(sign | 0x7c00u);
    }
    if (half_exponent <= 0) {
        if (half_exponent < -10)
            return sign;
        const std::uint32_t normalized = mantissa | 0x800000u;
        const int shift = 14 - half_exponent;
        const std::uint32_t rounded =
            (normalized + (1u << (shift - 1)) - 1u + ((normalized >> shift) & 1u)) >> shift;
        return static_cast<std::uint16_t>(sign | rounded);
    }
    const std::uint32_t rounded = mantissa + 0xfffu + ((mantissa >> 13) & 1u);
    if ((rounded & 0x800000u) != 0) {
        const int next_exponent = half_exponent + 1;
        return static_cast<std::uint16_t>(
            next_exponent >= 0x1f ? sign | 0x7c00u
                                  : sign | static_cast<std::uint16_t>(next_exponent << 10));
    }
    return static_cast<std::uint16_t>(sign | static_cast<std::uint16_t>(half_exponent << 10) |
                                      static_cast<std::uint16_t>(rounded >> 13));
}

/**
 * Decode a texture's bytes to RGBA, substituting a 1x1 fallback texel
 * when the scene carries none, and apply the pinned `invertY` flip. The
 * result is what both backends upload, so it is produced once.
 */
inline DecodedImage decode_uploadable_image(const TextureData& texture_data,
                                            const std::array<std::uint8_t, 4>& fallback) {
    if (texture_data.gpu_source || texture_data.render_source)
        throw std::runtime_error("GPU-backed texture requires a live sampled-resource binding.");
    DecodedImage image;
    if (texture_data.bytes.empty()) {
        image.width = image.height = 1;
        image.rgba.assign(fallback.begin(), fallback.end());
    } else if (texture_data.rgba_width && texture_data.rgba_height) {
        // Already texels: a `createTexture2DFromPixels` texture bound to a
        // material slot. Nothing to decode, and the size is the caller's.
        image.width = static_cast<int>(texture_data.rgba_width);
        image.height = static_cast<int>(texture_data.rgba_height);
        image.rgba = texture_data.bytes;
    } else {
        image = decode_image(js::ArrayBuffer(texture_data.bytes));
    }
    if (texture_data.premultiply_alpha) {
        premultiply_image_alpha(image);
    }
    if (texture_data.invert_y && image.height > 1) {
        const std::size_t row_bytes = static_cast<std::size_t>(image.width) * 4;
        std::vector<std::uint8_t> row(row_bytes);
        for (int y = 0; y < image.height / 2; ++y) {
            std::uint8_t* top = image.rgba.data() + static_cast<std::size_t>(y) * row_bytes;
            std::uint8_t* bottom =
                image.rgba.data() + static_cast<std::size_t>(image.height - 1 - y) * row_bytes;
            std::memcpy(row.data(), top, row_bytes);
            std::memcpy(top, bottom, row_bytes);
            std::memcpy(bottom, row.data(), row_bytes);
        }
    }
    return image;
}

/**
 * One compressed mip level's copy geometry, by the pin's own rules
 * (`ktx-loader.ts` uploadCompressed, `basis-loader.ts`).
 *
 * The copy extent is the block-padded size rather than the logical one:
 * a tail mip smaller than the block — 2x2 and 1x1 under a 4x4 block —
 * still occupies one whole block, and both WebGPU and D3D12 reject a
 * copy extent that is not a block multiple.
 */
struct CompressedMipCopy {
    std::uint32_t row_bytes;
    std::uint32_t block_rows;
    std::uint32_t width;
    std::uint32_t height;
};

inline CompressedMipCopy compressed_mip_copy(const CompressedTexture& texture,
                                             const CompressedMipLevel& mip) {
    const std::uint32_t blocks_per_row =
        (mip.width + texture.block_width - 1) / texture.block_width;
    const std::uint32_t block_rows = (mip.height + texture.block_height - 1) / texture.block_height;
    return CompressedMipCopy{
        blocks_per_row * texture.block_bytes,
        block_rows,
        blocks_per_row * texture.block_width,
        block_rows * texture.block_height,
    };
}

/**
 * The block-compressed formats this port uploads, as the pin's own WebGPU
 * format names resolve to.
 *
 * The generated table carries the pinned rows; this is the set both
 * backends can bind, so each translates one enumerator rather than
 * repeating the names. A name outside it is refused where the container is
 * parsed, which is the pin's own `if (!format) throw`.
 */
enum class CompressedBlockFormat {
#define BBLITE_FORMAT_ENUM(id, name, sdl, dawn) id,
    BBLITE_COMPRESSED_FORMATS(BBLITE_FORMAT_ENUM)
#undef BBLITE_FORMAT_ENUM
};

inline CompressedBlockFormat compressed_block_format(std::string_view name) {
#define BBLITE_FORMAT_NAME(id, text, sdl, dawn)                                                    \
    if (name == (text))                                                                            \
        return CompressedBlockFormat::id;
    BBLITE_COMPRESSED_FORMATS(BBLITE_FORMAT_NAME)
#undef BBLITE_FORMAT_NAME
    throw std::runtime_error("No compressed texture format for '" + std::string(name) + "'.");
}

template <typename Supports>
const CompressedTexture& select_compressed_texture(const TextureData& data, Supports supports) {
    if (supports(data.compressed.format))
        return data.compressed;
    if (data.compressed_alternatives) {
        for (const auto& candidate : *data.compressed_alternatives) {
            if (supports(candidate.format))
                return candidate;
        }
    }
    throw std::runtime_error("This device cannot sample any packaged compressed texture variant.");
}

// The readback inverse of float_to_half above, shared by both backends'
// screenshot and diagnostic-buffer paths: a half-float channel decoded
// and quantized to the byte a PNG stores.
inline std::uint8_t half_to_byte(std::uint16_t value) {
    const bool negative = (value & 0x8000u) != 0;
    const std::uint16_t exponent = (value >> 10) & 0x1fu;
    const std::uint16_t mantissa = value & 0x03ffu;
    float decoded = 0.0f;
    if (exponent == 0) {
        decoded = std::ldexp(static_cast<float>(mantissa), -24);
    } else if (exponent == 31) {
        decoded = mantissa == 0 ? std::numeric_limits<float>::infinity()
                                : std::numeric_limits<float>::quiet_NaN();
    } else {
        decoded = std::ldexp(1.0f + static_cast<float>(mantissa) / 1024.0f,
                             static_cast<int>(exponent) - 15);
    }
    if (negative)
        decoded = -decoded;
    return static_cast<std::uint8_t>(std::lround(std::clamp(decoded, 0.0f, 1.0f) * 255.0f));
}

// ---------------------------------------------------------------------------
// Readback row conversion, shared by both backends' screenshot and
// diagnostic-buffer paths. The copy/map mechanics stay per backend; what a
// row of readback bytes MEANS as PNG pixels is decided once: rgba16float
// decodes through the manual half conversion (clamped to bytes), r16float
// lands in the red channel, 8-bit rows copy through with an optional
// BGRA swap. Rows arrive 256-byte aligned, the way both APIs return them.

enum class ReadbackFormatClass {
    rgba16_float,
    r16_float,
    rgba8,
    bgra8,
};

inline std::vector<std::uint8_t> convert_readback_rows(const std::uint8_t* mapped,
                                                       std::uint32_t width, std::uint32_t height,
                                                       std::uint32_t aligned_row_bytes,
                                                       ReadbackFormatClass format) {
    const std::uint32_t output_row_bytes = width * 4;
    std::vector<std::uint8_t> rgba(static_cast<std::size_t>(output_row_bytes) * height);
    for (std::uint32_t y = 0; y < height; ++y) {
        const std::uint8_t* source_row = mapped + static_cast<std::size_t>(y) * aligned_row_bytes;
        std::uint8_t* destination_row =
            rgba.data() + static_cast<std::size_t>(y) * output_row_bytes;
        if (format == ReadbackFormatClass::rgba16_float) {
            const auto* source_pixels = reinterpret_cast<const std::uint16_t*>(source_row);
            for (std::uint32_t x = 0; x < width; ++x) {
                for (std::uint32_t channel = 0; channel < 4; ++channel) {
                    destination_row[x * 4 + channel] = half_to_byte(source_pixels[x * 4 + channel]);
                }
            }
        } else if (format == ReadbackFormatClass::r16_float) {
            const auto* source_pixels = reinterpret_cast<const std::uint16_t*>(source_row);
            for (std::uint32_t x = 0; x < width; ++x) {
                destination_row[x * 4] = half_to_byte(source_pixels[x]);
                destination_row[x * 4 + 1] = 0;
                destination_row[x * 4 + 2] = 0;
                destination_row[x * 4 + 3] = 255;
            }
        } else {
            std::memcpy(destination_row, source_row, output_row_bytes);
            if (format == ReadbackFormatClass::bgra8) {
                for (std::uint32_t x = 0; x < width; ++x) {
                    std::swap(destination_row[x * 4], destination_row[x * 4 + 2]);
                }
            }
        }
    }
    return rgba;
}

/**
 * The HDR diagnostic sidecar: the unpadded rgba16float rows, written to a
 * stream the caller opened (opening — and cleaning up its own GPU
 * resources when the open fails — stays per backend).
 */
inline void write_readback_raw_rows(std::ostream& raw, const std::uint8_t* mapped,
                                    std::uint32_t height, std::uint32_t aligned_row_bytes,
                                    std::uint32_t source_row_bytes) {
    for (std::uint32_t y = 0; y < height; ++y) {
        raw.write(
            reinterpret_cast<const char*>(mapped + static_cast<std::size_t>(y) * aligned_row_bytes),
            source_row_bytes);
    }
}

} // namespace bbl::pal

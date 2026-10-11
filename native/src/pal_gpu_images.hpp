// Texel data both backends upload and read back, whatever the scene
// reaches: the half-float packing, the decoded image a texture uploads,
// the compressed-format mapping, and the readback row conversion.
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

/**
 * A float stored into an `rgba16float` storage texel the way the reference
 * device's `textureStore` stores it: rounded toward zero, subnormals
 * included, and a finite value past the range kept at the largest finite
 * half. WGSL leaves the direction of that conversion to the
 * implementation; the pin's GPU kernels that produce such texels on the
 * reference device (the RGBD decode) truncate.
 */
inline std::uint16_t float_to_half_toward_zero(float value) {
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
        return static_cast<std::uint16_t>(sign | 0x7bffu);
    }
    if (half_exponent <= 0) {
        if (half_exponent < -10)
            return sign;
        const std::uint32_t normalized = mantissa | 0x800000u;
        return static_cast<std::uint16_t>(sign | (normalized >> (14 - half_exponent)));
    }
    return static_cast<std::uint16_t>(sign | static_cast<std::uint16_t>(half_exponent << 10) |
                                      static_cast<std::uint16_t>(mantissa >> 13));
}

/**
 * The RGBA texels a texture uploads, with the pinned upload transforms
 * (`orient_image`): its encoded image's (`texture_image_texels`), its
 * caller-supplied texels, or a 1x1 fallback texel when the scene carries
 * none. The result is what both backends upload, so it is produced once.
 */
DecodedImage decode_uploadable_image(const TextureData& texture_data,
                                     const std::array<std::uint8_t, 4>& fallback);

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

CompressedBlockFormat compressed_block_format(std::string_view name);

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

// The readback inverse of float_to_half_toward_zero above: a half-float
// channel decoded exactly.
inline float half_to_float(std::uint16_t value) {
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
    return negative ? -decoded : decoded;
}

// A half-float channel quantized to the byte a PNG stores, shared by both
// backends' screenshot and diagnostic-buffer paths.
inline std::uint8_t half_to_byte(std::uint16_t value) {
    return static_cast<std::uint8_t>(
        std::lround(std::clamp(half_to_float(value), 0.0f, 1.0f) * 255.0f));
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

std::vector<std::uint8_t> convert_readback_rows(const std::uint8_t* mapped, std::uint32_t width,
                                                std::uint32_t height,
                                                std::uint32_t aligned_row_bytes,
                                                ReadbackFormatClass format);

/**
 * The HDR diagnostic sidecar: the unpadded rgba16float rows, written to a
 * stream the caller opened (opening — and cleaning up its own GPU
 * resources when the open fails — stays per backend).
 */
void write_readback_raw_rows(std::ostream& raw, const std::uint8_t* mapped, std::uint32_t height,
                             std::uint32_t aligned_row_bytes, std::uint32_t source_row_bytes);

} // namespace bbl::pal

// The texel bodies (pal_gpu_images.hpp): the decoded image a texture uploads,
// the compressed-texture copy geometry and the readback row conversion. It
// reads no generated header, so it compiles once for every scene.
#include "pal_gpu_images.hpp"

namespace bbl::pal {

DecodedImage decode_uploadable_image(const TextureData& texture_data,
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
        image = decode_image(
            std::span<const std::uint8_t>{texture_data.bytes.data(), texture_data.bytes.size()});
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

CompressedMipCopy compressed_mip_copy(const CompressedTexture& texture,
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

CompressedBlockFormat compressed_block_format(std::string_view name) {
#define BBLITE_FORMAT_NAME(id, text, sdl, dawn)                                                    \
    if (name == (text))                                                                            \
        return CompressedBlockFormat::id;
    BBLITE_COMPRESSED_FORMATS(BBLITE_FORMAT_NAME)
#undef BBLITE_FORMAT_NAME
    throw std::runtime_error("No compressed texture format for '" + std::string(name) + "'.");
}

std::vector<std::uint8_t> convert_readback_rows(const std::uint8_t* mapped, std::uint32_t width,
                                                std::uint32_t height,
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

void write_readback_raw_rows(std::ostream& raw, const std::uint8_t* mapped, std::uint32_t height,
                             std::uint32_t aligned_row_bytes, std::uint32_t source_row_bytes) {
    for (std::uint32_t y = 0; y < height; ++y) {
        raw.write(
            reinterpret_cast<const char*>(mapped + static_cast<std::size_t>(y) * aligned_row_bytes),
            source_row_bytes);
    }
}

} // namespace bbl::pal

#pragma once
#include <bblite/js_data.hpp>
#include <bblite/runtime.hpp>

#include <cstring>
#include <stdexcept>

namespace bbl::pal {

/**
 * A pixels-texture write's WebGPU copy region: integral texel coordinates
 * (`GPUIntegerCoordinate`) inside the texture. The browser reports a
 * violation as a validation error and drops the write; here it throws.
 */
inline PixelsTexels::Region pixels_texture_region(const PixelsTexture& texture, double x, double y,
                                                  double width, double height) {
    const PixelsTexels::Region region{gpu_u32(gpu_size(x)), gpu_u32(gpu_size(y)),
                                      gpu_u32(gpu_size(width)), gpu_u32(gpu_size(height))};
    if (region.x > texture.width || region.width > texture.width - region.x ||
        region.y > texture.height || region.height > texture.height - region.y)
        throw std::runtime_error("GPU texture write exceeds its destination texture.");
    return region;
}

/**
 * `queue.writeTexture` into a pixels texture: the region every binding's GPU
 * image takes from the texels at its next frame upload, before that frame's
 * draws, as a queue write lands before the next submit.
 */
inline void queue_pixels_texture_write(const PixelsTexture& texture, double x, double y,
                                       double width, double height) {
    const PixelsTexels::Region region = pixels_texture_region(texture, x, y, width, height);
    if (region.whole())
        return;
    PixelsTexels::State& texels = *texture.rgba.state();
    texels.require_writable();
    texels.note_write(region);
}

/**
 * The device-recovery record's write (`_dlr.w`): the region's tightly packed
 * rows of `data` into the texels, which every upload and a recovery read.
 */
inline void record_pixels_texture_write(const PixelsTexture& texture, const js::U8Array& data,
                                        double x, double y, double width, double height) {
    const PixelsTexels::Region region = pixels_texture_region(texture, x, y, width, height);
    const std::size_t row_bytes = static_cast<std::size_t>(region.width) * 4u;
    const std::size_t stride = static_cast<std::size_t>(texture.width) * 4u;
    if (region.whole())
        return;
    if (data.size() / row_bytes < region.height)
        throw std::runtime_error("Pixels texture write is shorter than its region.");
    SharedTextureBytes& texels = texture.rgba.state()->rgba;
    if (texels.size() / stride < texture.height)
        throw std::runtime_error("Pixels texture texels are shorter than the texture.");
    // In place: every binding shares the texels and uploads the regions
    // written since the version it holds.
    std::uint8_t* destination = texels.shared_data();
    for (std::uint32_t row = 0; row < region.height; ++row)
        std::memcpy(destination + (static_cast<std::size_t>(region.y) + row) * stride +
                        static_cast<std::size_t>(region.x) * 4u,
                    data.data() + row * row_bytes, row_bytes);
}

} // namespace bbl::pal

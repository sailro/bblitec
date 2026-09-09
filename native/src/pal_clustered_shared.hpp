#pragma once

#include <bblite/runtime.hpp>
#include <bblite/upstream/clustered_light.hpp>

namespace bbl::pal {

enum class ClusteredTexture { lights, cells, indices };

/** The pin owns binning and upload extents; each backend writes the same three payloads. */
template<class Params, class Texture>
void sync_clustered_payloads(ClusteredLightContainer& container, std::uint64_t& uploaded_version,
    const std::array<float, 16>& view, const std::array<float, 16>& projection,
    double near_plane, double far_plane, Params&& params, Texture&& texture) {
    upstream::refresh_clustered_lights(container, view, projection, near_plane, far_plane);
    if (uploaded_version == container.upload_version) return;
    params(container.params.data(), container.params.size() * sizeof(std::uint32_t));
    const auto upload = [&](ClusteredTexture slot, const auto& bytes, std::uint32_t texel_bytes,
        std::uint32_t texels, std::uint32_t rows) {
        const auto region = container.upload_region(texels, rows);
        texture(slot, bytes.data(), bytes.size() * sizeof(bytes[0]), texel_bytes, region.width, region.height);
    };
    upload(ClusteredTexture::lights, container.light_data, 16u, container.light_texels, container.light_rows);
    upload(ClusteredTexture::cells, container.slice_data, 16u, container.slice_count, container.slice_rows);
    upload(ClusteredTexture::indices, container.mask_data, 4u, container.mask_texels, container.mask_rows);
    uploaded_version = container.upload_version;
}

} // namespace bbl::pal

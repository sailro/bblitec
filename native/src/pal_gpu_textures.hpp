// Texture sources the scene renderers upload: the local cubemap replay,
// the RGBD decode, the environment cube and DDS skybox walks, and the mip
// chains a texture or a sprite atlas uploads with.
#pragma once
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_sprites.hpp>

#include <bblite/runtime.hpp>
#include <bblite/upstream/render_capabilities.hpp>
#if BBLITE_RECT_AREA_EMISSION
#include <bblite/pal_image.hpp>
#endif
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>
#include <bblite/upstream/pinned_texture.hpp>

namespace bbl::pal {

#if BBLITE_LOCAL_CUBEMAP
// Replay the pin's recorded copies over the retained source face payloads.
// Decoding/upload uses the same path as an ordinary environment cubemap.
EnvironmentState local_cubemap_texture(const LocalCubemapRecord& local);
#endif

// The RGBD decode both render backends upload through.
#if BBLITE_HAS_PBR_RENDERER
std::vector<std::uint16_t> decode_rgbd(const TextureData& texture_data, int& width, int& height);

/**
 * Whether the compiled environment carries a complete specular cube: a
 * nonzero extent and mip count, and one face per (mip, face) cell. Moved
 * verbatim from the two scene renderers' upload paths; what each backend
 * does WITHOUT one stays deliberately its own (SDL uploads fallback faces,
 * Dawn keeps its startup fallback cube).
 */
#endif

bool environment_cube_present(const EnvironmentState& environment);

/**
 * The DDS skybox payload walk both backends upload through: face-major,
 * each face's mip chain in file order, with the running byte offset and the
 * truncation guard decided here, once. `visit` receives one
 * (face, mip, extent, offset, byte_size) cell and performs the backend's
 * own upload; rgba16f texels at 8 bytes each, as the parser promised.
 */
template <typename Visit>
inline void for_each_dds_skybox_level(const EnvironmentState& environment, const Visit& visit) {
    const TextureData& data = environment.skybox_texture;
    std::size_t offset = environment.skybox_data_offset;
    for (std::uint32_t face = 0; face < 6; ++face) {
        for (std::uint32_t mip = 0; mip < environment.skybox_mip_count; ++mip) {
            const std::uint32_t size = std::max(environment.skybox_width >> mip, 1u);
            const std::size_t byte_size = static_cast<std::size_t>(size) * size * 8;
            if (offset + byte_size > data.bytes.size()) {
                throw std::runtime_error("DDS skybox pixel data is truncated.");
            }
            visit(face, mip, size, offset, byte_size);
            offset += byte_size;
        }
    }
}

#if BBLITE_RECT_AREA_EMISSION
/**
 * The packaged processAreaLightTexture chain both backends upload
 * (`packagedAreaLightImage`): one decoded image `image.size` texels wide,
 * each level at the left of its own band of rows, level zero first, so a
 * level's rows are `image.size` texels apart. `visit` receives one
 * (level, extent, byte offset of the level's first texel) cell and performs
 * the backend's own upload; the bounds check is decided here, once.
 */
template <typename Visit>
inline void for_each_area_light_image_level(const AreaLightImage& image, const DecodedImage& atlas,
                                            const Visit& visit) {
    std::size_t rows = 0;
    for (std::uint32_t level = 0; level < image.levels; ++level)
        rows += std::max(image.size >> level, 1u);
    if (atlas.width < 0 || static_cast<std::size_t>(atlas.width) != image.size ||
        atlas.height < 0 || static_cast<std::size_t>(atlas.height) != rows) {
        throw std::runtime_error("Packaged area light image '" + image.path + "' is not the " +
                                 std::to_string(image.size) + "x" + std::to_string(rows) +
                                 " band layout of its " + std::to_string(image.levels) +
                                 " levels.");
    }
    std::size_t row = 0;
    for (std::uint32_t level = 0; level < image.levels; ++level) {
        const std::uint32_t extent = std::max(image.size >> level, 1u);
        visit(level, extent, row * image.size * 4u);
        row += extent;
    }
}
#endif

inline std::uint32_t full_mip_chain(std::uint32_t width, std::uint32_t height) {
    return static_cast<std::uint32_t>(upstream::mip_level_count(width, height));
}

/**
 * The mip levels a sprite atlas's texture is uploaded with.
 *
 * The chain is the pinned loader's own `mipMaps` decision, carried on the
 * record: `loadSpriteAtlas` turns it off, and the atlas a node-particle
 * graph's texture block builds through `loadTexture2D` leaves it on. Both
 * backends ask this rather than each inferring the option back out of the
 * sampler.
 */
#if BBLITE_HAS_SPRITES
inline std::uint32_t atlas_mip_levels(const SpriteAtlasRecord& atlas) {
    return atlas.mip_maps ? full_mip_chain(atlas.width, atlas.height) : 1u;
}
#endif

} // namespace bbl::pal

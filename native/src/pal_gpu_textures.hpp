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
#include <memory>
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
 * (`packagedAreaLightImage`): every level's texels back to back, level zero
 * first, in one decoded image `image.size` texels wide whose last row is
 * padded, so a level's rows are tight. `visit` receives one (level, extent,
 * byte offset of the level's first texel) cell and performs the backend's
 * own upload; the bounds check is decided here, once.
 */
template <typename Visit>
inline void for_each_area_light_image_level(const AreaLightImage& image, const DecodedImage& packed,
                                            const Visit& visit) {
    std::size_t texels = 0;
    for (std::uint32_t level = 0; level < image.levels; ++level) {
        const std::size_t extent = std::max(image.size >> level, 1u);
        texels += extent * extent;
    }
    const std::size_t rows = (texels + image.size - 1) / image.size;
    if (packed.width < 0 || static_cast<std::size_t>(packed.width) != image.size ||
        packed.height < 0 || static_cast<std::size_t>(packed.height) != rows) {
        throw std::runtime_error("Packaged area light image '" + image.path + "' is not the " +
                                 std::to_string(image.size) + "x" + std::to_string(rows) +
                                 " packing of its " + std::to_string(image.levels) + " levels.");
    }
    std::size_t offset = 0;
    for (std::uint32_t level = 0; level < image.levels; ++level) {
        const std::uint32_t extent = std::max(image.size >> level, 1u);
        visit(level, extent, offset * 4u);
        offset += static_cast<std::size_t>(extent) * extent;
    }
}

/**
 * A backend's per-device cache of what it built from a shared runtime
 * source (a processed area light image, a scene's emission snapshot), keyed
 * by the source's identity: an entry only the backend still holds belongs
 * to no scene and is released.
 */
template <typename Entry, typename Release>
inline void prune_unshared_sources(std::vector<std::unique_ptr<Entry>>& cache,
                                   const Release& release) {
    std::erase_if(cache, [&release](const std::unique_ptr<Entry>& entry) {
        if (entry->source.use_count() > 1)
            return false;
        release(*entry);
        return true;
    });
}

/**
 * The entry built from `source`, uploaded on its first use: the cache is
 * pruned first ({@link prune_unshared_sources}), then looked up by
 * identity. Entries are heap-held, so a returned reference outlives later
 * uploads.
 */
template <typename Entry, typename Source, typename Upload, typename Release>
inline Entry& cached_source_upload(std::vector<std::unique_ptr<Entry>>& cache,
                                   const std::shared_ptr<const Source>& source,
                                   const Upload& upload, const Release& release) {
    prune_unshared_sources(cache, release);
    for (const std::unique_ptr<Entry>& entry : cache)
        if (entry->source == source)
            return *entry;
    cache.push_back(upload(source));
    return *cache.back();
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

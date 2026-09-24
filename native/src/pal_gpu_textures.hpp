// Texture sources the scene renderers upload: the local cubemap replay,
// the RGBD decode, the environment cube and DDS skybox walks, and the mip
// chains a texture or a sprite atlas uploads with.
#pragma once
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_sprites.hpp>
#include "pal_gpu_scene_headers.hpp"

namespace bbl::pal {

#if BBLITE_LOCAL_CUBEMAP
// Replay the pin's recorded copies over the retained source face payloads.
// Decoding/upload uses the same path as an ordinary environment cubemap.
inline EnvironmentState local_cubemap_texture(const LocalCubemapRecord& local) {
    EnvironmentState result;
    result.has_irradiance = true;
    result.specular_width = local.width;
    result.specular_mip_count = local.mip_count;
    result.specular_faces.resize(static_cast<std::size_t>(local.layers) * local.mip_count);
    std::vector<bool> copied(result.specular_faces.size(), false);
    result.specular_rgba16f = local.environments.at(0)->specular_rgba16f;
    for (const auto& copy : local.copies) {
        const auto& source = *local.environments.at(copy.source);
        if (copy.source_layer >= 6 || copy.source_mip >= source.specular_mip_count ||
            copy.layer >= local.layers || copy.mip >= local.mip_count ||
            copy.size != std::max(1u, source.specular_width >> copy.source_mip) ||
            copy.size != std::max(1u, local.width >> copy.mip) ||
            source.specular_rgba16f != result.specular_rgba16f)
            throw std::runtime_error("Local cubemap copy does not match its source environment.");
        const auto destination = static_cast<std::size_t>(copy.mip) * local.layers + copy.layer;
        if (copied.at(destination))
            throw std::runtime_error("Local cubemap repeats a face copy.");
        copied[destination] = true;
        result.specular_faces[destination] = source.specular_faces.at(
            static_cast<std::size_t>(copy.source_mip) * 6 + copy.source_layer);
    }
    if (std::find(copied.begin(), copied.end(), false) != copied.end())
        throw std::runtime_error("Local cubemap copy plan leaves a face uninitialized.");
    return result;
}
#endif

// The RGBD decode both render backends upload through.
#if BBLITE_HAS_PBR_RENDERER
inline std::vector<std::uint16_t> decode_rgbd(const TextureData& texture_data, int& width,
                                              int& height) {
    // src/loader-env/rgbd-decode.ts: the pin decodes into a
    // `texture_storage_2d<rgba16float, write>`, so a half is the decode's
    // result type, not a packing step a caller may skip. Returning halves
    // is what keeps every caller on the pin's precision: an RGBA32Float
    // upload on one path beside a half-packed one on another would be a
    // silent backend delta.
    if (texture_data.bytes.empty()) {
        width = height = 1;
        return {0, 0, 0, float_to_half(1.0f)};
    }
    const DecodedImage image = decode_image(js::ArrayBuffer(texture_data.bytes));
    width = image.width;
    height = image.height;
    std::vector<std::uint16_t> result(static_cast<std::size_t>(width) * height * 4);
    for (std::size_t index = 0; index < image.rgba.size(); index += 4) {
        const auto pixel = upstream::decode_rgbd_pixel(image.rgba.data() + index);
        for (std::size_t channel = 0; channel < pixel.size(); ++channel) {
            result[index + channel] = float_to_half(pixel[channel]);
        }
    }
    return result;
}

/**
 * Whether the compiled environment carries a complete specular cube: a
 * nonzero extent and mip count, and one face per (mip, face) cell. Moved
 * verbatim from the two scene renderers' upload paths; what each backend
 * does WITHOUT one stays deliberately its own (SDL uploads fallback faces,
 * Dawn keeps its startup fallback cube).
 */
#endif

inline bool environment_cube_present(const EnvironmentState& environment) {
    return environment.specular_width != 0 && environment.specular_mip_count != 0 &&
           (environment.specular_gpu ||
            environment.specular_faces.size() >=
                static_cast<std::size_t>(environment.specular_mip_count) * 6);
}

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

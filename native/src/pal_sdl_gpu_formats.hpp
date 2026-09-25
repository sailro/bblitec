#pragma once

// Every record enum in SDL_GPU's spelling, once for all SDL_GPU units. The
// records (runtime.hpp) and the generated tables own the values; only the
// mapping onto this API belongs to the backend. Mappings of generated
// renderer enums (cull mode, primitive topology, ESM formats) and the
// device-dependent depth format stay with the one unit that reaches them.

#include <bblite/features/has_sprites.hpp>

#include <bblite/runtime.hpp>

#include <cstdint>
#include <stdexcept>
#include <string>

#include <SDL3/SDL_gpu.h>

namespace bbl::pal {

inline SDL_GPUTextureFormat texture_format(TextureFormatClass format) {
    switch (format) {
    case TextureFormatClass::rgba8_unorm:
        return SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
    case TextureFormatClass::r8_unorm:
        return SDL_GPU_TEXTUREFORMAT_R8_UNORM;
    case TextureFormatClass::r16_float:
        return SDL_GPU_TEXTUREFORMAT_R16_FLOAT;
    case TextureFormatClass::rg16_float:
        return SDL_GPU_TEXTUREFORMAT_R16G16_FLOAT;
    case TextureFormatClass::r32_float:
        return SDL_GPU_TEXTUREFORMAT_R32_FLOAT;
    case TextureFormatClass::rgba16_float:
        return SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
    }
    return SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
}

/**
 * The pin's depth compare in this API's enum.
 *
 * `upstream::pinned_depth_compare` carries the value the pin declares; only
 * the mapping onto SDL_GPU's enum belongs to this backend, the same split
 * the blend factors use.
 */
inline SDL_GPUCompareOp gpu_depth_compare(DepthCompare compare) {
    switch (compare) {
    case DepthCompare::never:
        return SDL_GPU_COMPAREOP_NEVER;
    case DepthCompare::less:
        return SDL_GPU_COMPAREOP_LESS;
    case DepthCompare::equal:
        return SDL_GPU_COMPAREOP_EQUAL;
    case DepthCompare::less_equal:
        return SDL_GPU_COMPAREOP_LESS_OR_EQUAL;
    case DepthCompare::greater:
        return SDL_GPU_COMPAREOP_GREATER;
    case DepthCompare::not_equal:
        return SDL_GPU_COMPAREOP_NOT_EQUAL;
    case DepthCompare::greater_equal:
        return SDL_GPU_COMPAREOP_GREATER_OR_EQUAL;
    case DepthCompare::always:
        return SDL_GPU_COMPAREOP_ALWAYS;
    }
    return SDL_GPU_COMPAREOP_GREATER_OR_EQUAL;
}

inline SDL_GPUBlendFactor gpu_blend_factor(BlendFactor factor) {
    switch (factor) {
    case BlendFactor::one:
        return SDL_GPU_BLENDFACTOR_ONE;
    case BlendFactor::src_alpha:
        return SDL_GPU_BLENDFACTOR_SRC_ALPHA;
    case BlendFactor::one_minus_src_alpha:
        return SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
    }
    return SDL_GPU_BLENDFACTOR_ONE;
}

#if BBLITE_HAS_SPRITES
inline SDL_GPUBlendFactor sprite_blend_factor(SpriteBlendFactor factor) {
    switch (factor) {
    case SpriteBlendFactor::zero:
        return SDL_GPU_BLENDFACTOR_ZERO;
    case SpriteBlendFactor::one:
        return SDL_GPU_BLENDFACTOR_ONE;
    case SpriteBlendFactor::src_alpha:
        return SDL_GPU_BLENDFACTOR_SRC_ALPHA;
    case SpriteBlendFactor::one_minus_src_alpha:
        return SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
    case SpriteBlendFactor::dst:
        return SDL_GPU_BLENDFACTOR_DST_COLOR;
    case SpriteBlendFactor::dst_alpha:
        return SDL_GPU_BLENDFACTOR_DST_ALPHA;
    }
    return SDL_GPU_BLENDFACTOR_ONE;
}
#endif

inline SDL_GPUFilter gpu_filter(TextureFilter filter) {
    return filter == TextureFilter::nearest ? SDL_GPU_FILTER_NEAREST : SDL_GPU_FILTER_LINEAR;
}

inline SDL_GPUSamplerMipmapMode gpu_mipmap_mode(TextureMipmapMode mode) {
    return mode == TextureMipmapMode::nearest ? SDL_GPU_SAMPLERMIPMAPMODE_NEAREST
                                              : SDL_GPU_SAMPLERMIPMAPMODE_LINEAR;
}

inline SDL_GPUSamplerAddressMode gpu_address_mode(TextureAddressMode mode) {
    return mode == TextureAddressMode::clamp    ? SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE
           : mode == TextureAddressMode::mirror ? SDL_GPU_SAMPLERADDRESSMODE_MIRRORED_REPEAT
                                                : SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
}

/** A numeric sample count in this API's enum; counts outside the API's
 *  set are refused rather than rounded. */
inline SDL_GPUSampleCount gpu_sample_count_from(std::uint32_t samples) {
    switch (samples) {
    case 1u:
        return SDL_GPU_SAMPLECOUNT_1;
    case 2u:
        return SDL_GPU_SAMPLECOUNT_2;
    case 4u:
        return SDL_GPU_SAMPLECOUNT_4;
    case 8u:
        return SDL_GPU_SAMPLECOUNT_8;
    }
    throw std::runtime_error("No SDL_GPU sample count for " + std::to_string(samples) + ".");
}

/** The enum back as a number, for the shared rules that reason about
 *  counts (`alpha_to_coverage_enabled`). */
inline std::uint32_t gpu_sample_count_value(SDL_GPUSampleCount samples) {
    switch (samples) {
    case SDL_GPU_SAMPLECOUNT_1:
        return 1u;
    case SDL_GPU_SAMPLECOUNT_2:
        return 2u;
    case SDL_GPU_SAMPLECOUNT_4:
        return 4u;
    case SDL_GPU_SAMPLECOUNT_8:
        return 8u;
    }
    return 1u;
}

} // namespace bbl::pal

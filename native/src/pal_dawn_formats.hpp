#pragma once

// Every record enum in WebGPU's spelling, once for all Dawn units. The
// records (runtime.hpp) and the generated tables own the values; only the
// mapping onto this API belongs to the backend. Mappings of generated
// renderer enums (cull mode, ESM and ShaderMaterial sampler shapes) stay
// with the one unit that includes their generated header.

#include <bblite/runtime.hpp>

#include <stdexcept>

#include <webgpu/webgpu.h>

namespace bbl::pal {

inline WGPUTextureFormat texture_format(TextureFormatClass format) {
    switch (format) {
    case TextureFormatClass::rgba8_unorm:
        return WGPUTextureFormat_RGBA8Unorm;
    case TextureFormatClass::r8_unorm:
        return WGPUTextureFormat_R8Unorm;
    case TextureFormatClass::r16_float:
        return WGPUTextureFormat_R16Float;
    case TextureFormatClass::rg16_float:
        return WGPUTextureFormat_RG16Float;
    case TextureFormatClass::r32_float:
        return WGPUTextureFormat_R32Float;
    case TextureFormatClass::rgba16_float:
        return WGPUTextureFormat_RGBA16Float;
    }
    return WGPUTextureFormat_RGBA16Float;
}

/** A render target's depth attachment; a shadow map is always depth32float. */
inline WGPUTextureFormat depth_texture_format(const RenderTargetRecord& record) {
    if (record.shadow_map)
        return WGPUTextureFormat_Depth32Float;
    switch (record.depth_format) {
    case DepthTextureFormat::depth24_plus_stencil8:
        return WGPUTextureFormat_Depth24PlusStencil8;
    case DepthTextureFormat::depth16_unorm:
        return WGPUTextureFormat_Depth16Unorm;
    case DepthTextureFormat::depth24_plus:
        return WGPUTextureFormat_Depth24Plus;
    case DepthTextureFormat::depth32_float:
        return WGPUTextureFormat_Depth32Float;
    }
    throw std::runtime_error("Unrepresented depth texture format.");
}

/**
 * The pin's depth compare in this API's enum.
 *
 * `upstream::pinned_depth_compare` carries the value the pin declares; only
 * the mapping onto WebGPU's enum belongs to this backend, the same split
 * the blend factors use.
 */
inline WGPUCompareFunction dawn_depth_compare(DepthCompare compare) {
    switch (compare) {
    case DepthCompare::never:
        return WGPUCompareFunction_Never;
    case DepthCompare::less:
        return WGPUCompareFunction_Less;
    case DepthCompare::equal:
        return WGPUCompareFunction_Equal;
    case DepthCompare::less_equal:
        return WGPUCompareFunction_LessEqual;
    case DepthCompare::greater:
        return WGPUCompareFunction_Greater;
    case DepthCompare::not_equal:
        return WGPUCompareFunction_NotEqual;
    case DepthCompare::greater_equal:
        return WGPUCompareFunction_GreaterEqual;
    case DepthCompare::always:
        return WGPUCompareFunction_Always;
    }
    return WGPUCompareFunction_GreaterEqual;
}

inline WGPUBlendFactor dawn_blend_factor(BlendFactor factor) {
    switch (factor) {
    case BlendFactor::one:
        return WGPUBlendFactor_One;
    case BlendFactor::src_alpha:
        return WGPUBlendFactor_SrcAlpha;
    case BlendFactor::one_minus_src_alpha:
        return WGPUBlendFactor_OneMinusSrcAlpha;
    }
    return WGPUBlendFactor_One;
}

#if !defined(BBLITE_HAS_SPRITES) || BBLITE_HAS_SPRITES
inline WGPUBlendFactor dawn_sprite_blend_factor(SpriteBlendFactor factor) {
    switch (factor) {
    case SpriteBlendFactor::zero:
        return WGPUBlendFactor_Zero;
    case SpriteBlendFactor::one:
        return WGPUBlendFactor_One;
    case SpriteBlendFactor::src_alpha:
        return WGPUBlendFactor_SrcAlpha;
    case SpriteBlendFactor::one_minus_src_alpha:
        return WGPUBlendFactor_OneMinusSrcAlpha;
    case SpriteBlendFactor::dst:
        return WGPUBlendFactor_Dst;
    case SpriteBlendFactor::dst_alpha:
        return WGPUBlendFactor_DstAlpha;
    }
    return WGPUBlendFactor_One;
}
#endif

inline WGPUFilterMode dawn_filter_mode(TextureFilter filter) {
    return filter == TextureFilter::nearest ? WGPUFilterMode_Nearest : WGPUFilterMode_Linear;
}

inline WGPUMipmapFilterMode dawn_mipmap_filter_mode(TextureMipmapMode mode) {
    return mode == TextureMipmapMode::nearest ? WGPUMipmapFilterMode_Nearest
                                              : WGPUMipmapFilterMode_Linear;
}

inline WGPUAddressMode dawn_address_mode(TextureAddressMode mode) {
    return mode == TextureAddressMode::clamp    ? WGPUAddressMode_ClampToEdge
           : mode == TextureAddressMode::mirror ? WGPUAddressMode_MirrorRepeat
                                                : WGPUAddressMode_Repeat;
}

} // namespace bbl::pal

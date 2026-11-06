#pragma once

// Every record enum in WebGPU's spelling, once for all Dawn units. The
// records (runtime.hpp) and the generated tables own the values; only the
// mapping onto this API belongs to the backend. Mappings of generated
// renderer enums (cull mode, ESM and ShaderMaterial sampler shapes) stay
// with the one unit that includes their generated header.

#include <bblite/features/has_sprites.hpp>

#include <bblite/runtime.hpp>

#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>

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
    case BlendFactor::zero:
        return WGPUBlendFactor_Zero;
    case BlendFactor::one:
        return WGPUBlendFactor_One;
    case BlendFactor::src_alpha:
        return WGPUBlendFactor_SrcAlpha;
    case BlendFactor::one_minus_src_alpha:
        return WGPUBlendFactor_OneMinusSrcAlpha;
    case BlendFactor::dst:
        return WGPUBlendFactor_Dst;
    case BlendFactor::dst_alpha:
        return WGPUBlendFactor_DstAlpha;
    }
    return WGPUBlendFactor_One;
}

#if BBLITE_HAS_SPRITES
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

/**
 * The WebGPU format names Dawn creates textures in by name, each with the
 * uses it serves: `sampled` for the sampled and storage textures created by
 * name (compute textures, text atlases), `target` for render targets and
 * their signatures (the WebGPU subset text draws into).
 */
struct DawnNamedTextureFormat {
    std::string_view name;
    WGPUTextureFormat format;
    bool sampled;
    bool target;
};
inline constexpr DawnNamedTextureFormat dawn_webgpu_formats[] = {
    {"rgba8unorm", WGPUTextureFormat_RGBA8Unorm, true, true},
    {"rgba8unorm-srgb", WGPUTextureFormat_RGBA8UnormSrgb, false, true},
    {"rgba8snorm", WGPUTextureFormat_RGBA8Snorm, true, false},
    {"bgra8unorm", WGPUTextureFormat_BGRA8Unorm, false, true},
    {"bgra8unorm-srgb", WGPUTextureFormat_BGRA8UnormSrgb, false, true},
    {"r8unorm", WGPUTextureFormat_R8Unorm, true, true},
    {"r16float", WGPUTextureFormat_R16Float, true, true},
    {"rgba16float", WGPUTextureFormat_RGBA16Float, true, true},
    {"r32float", WGPUTextureFormat_R32Float, true, true},
    {"r32uint", WGPUTextureFormat_R32Uint, true, false},
    {"rg32float", WGPUTextureFormat_RG32Float, true, false},
    {"rg32uint", WGPUTextureFormat_RG32Uint, true, true},
    {"rgba32float", WGPUTextureFormat_RGBA32Float, true, false},
    {"depth16unorm", WGPUTextureFormat_Depth16Unorm, false, true},
    {"depth24plus", WGPUTextureFormat_Depth24Plus, false, true},
    {"depth24plus-stencil8", WGPUTextureFormat_Depth24PlusStencil8, false, true},
    {"depth32float", WGPUTextureFormat_Depth32Float, false, true},
    {"depth32float-stencil8", WGPUTextureFormat_Depth32FloatStencil8, false, true}};

inline WGPUTextureFormat dawn_named_texture_format(std::string_view value) {
    for (const DawnNamedTextureFormat& entry : dawn_webgpu_formats)
        if (entry.sampled && entry.name == value)
            return entry.format;
    throw std::runtime_error("Unrepresented Dawn texture format: " + std::string(value));
}

/** A WebGPU `GPUTextureSampleType` name in Dawn's enum; empty for any other name. */
inline std::optional<WGPUTextureSampleType> dawn_texture_sample_type(std::string_view value) {
    static constexpr std::pair<std::string_view, WGPUTextureSampleType> types[] = {
        {"float", WGPUTextureSampleType_Float},
        {"unfilterable-float", WGPUTextureSampleType_UnfilterableFloat},
        {"depth", WGPUTextureSampleType_Depth},
        {"sint", WGPUTextureSampleType_Sint},
        {"uint", WGPUTextureSampleType_Uint}};
    for (const auto& [name, type] : types)
        if (name == value)
            return type;
    return std::nullopt;
}

/** A render target's format by its WebGPU name. */
inline WGPUTextureFormat dawn_webgpu_format(const std::string& name) {
    for (const DawnNamedTextureFormat& entry : dawn_webgpu_formats)
        if (entry.target && entry.name == name)
            return entry.format;
    throw std::runtime_error("Texture format '" + name + "' has no Dawn target format.");
}
/** A renderer attachment's WebGPU format name, for a target signature. */
inline std::string dawn_webgpu_format_name(WGPUTextureFormat format) {
    for (const DawnNamedTextureFormat& entry : dawn_webgpu_formats)
        if (entry.target && entry.format == format)
            return std::string(entry.name);
    throw std::runtime_error("A Dawn target format has no WebGPU name.");
}

} // namespace bbl::pal

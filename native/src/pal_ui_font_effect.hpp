#pragma once

#include <RmlUi/Core/CallbackTexture.h>
#include <RmlUi/Core/FontEffect.h>
#include <RmlUi/Core/MeshUtilities.h>
#include <RmlUi/Core/RenderManager.h>
#include <algorithm>
#include <cmath>
#include <memory>
#include <optional>
#include <vector>

namespace bbl::pal {

struct UiFontEffectRaster {
    Rml::Vector2i offset{}, dimensions{};
    std::unique_ptr<Rml::CallbackTextureSource> texture;
};

// Platform font engines supply their glyph coverage; RmlUi remains the owner
// of effect metrics and filtering for both monochrome and color glyphs.
inline std::optional<UiFontEffectRaster> ui_font_effect_raster(const Rml::FontGlyph& glyph,
                                                               const Rml::FontEffect& effect) {
    UiFontEffectRaster result{{0, 0}, glyph.bitmap_dimensions, {}};
    if (!effect.GetGlyphMetrics(result.offset, result.dimensions, glyph))
        return std::nullopt;
    const bool unique = effect.HasUniqueTexture();
    if (!unique) {
        result.dimensions = glyph.bitmap_dimensions;
        // A monochrome base texture already contains the effect's coverage.
        if (glyph.color_format == Rml::ColorFormat::A8)
            return result;
    }
    std::vector<Rml::byte> pixels(static_cast<std::size_t>(result.dimensions.x) *
                                  result.dimensions.y * 4);
    if (unique) {
        effect.GenerateGlyphTexture(pixels.data(), result.dimensions, result.dimensions.x * 4,
                                    glyph);
    } else {
        const std::size_t stride = glyph.color_format == Rml::ColorFormat::RGBA8 ? 4 : 1;
        for (std::size_t index = 0; index < pixels.size() / 4; ++index) {
            const auto alpha = glyph.bitmap_data[index * stride + stride - 1];
            for (std::size_t channel = 0; channel < 4; ++channel)
                pixels[index * 4 + channel] = alpha;
        }
    }
    result.texture = std::make_unique<Rml::CallbackTextureSource>(
        [pixels = std::move(pixels),
         dimensions = result.dimensions](const Rml::CallbackTextureInterface& output) {
            return output.GenerateTexture(pixels, dimensions);
        });
    return result;
}

inline void ui_font_effect_mesh(Rml::RenderManager& manager, const UiFontEffectRaster& raster,
                                Rml::CallbackTextureSource& base_texture,
                                Rml::Vector2f glyph_origin, const Rml::FontEffect& effect,
                                float opacity, Rml::TexturedMeshList& meshes) {
    meshes.emplace_back();
    meshes.back().texture = (raster.texture ? *raster.texture : base_texture).GetTexture(manager);
    auto color = effect.GetColour();
    color.alpha = static_cast<Rml::byte>(std::clamp(std::lround(color.alpha * opacity), 0l, 255l));
    Rml::MeshUtilities::GenerateQuad(
        meshes.back().mesh, glyph_origin + Rml::Vector2f(raster.offset),
        Rml::Vector2f(raster.dimensions), color.ToPremultiplied(), {0, 0}, {1, 1});
}

} // namespace bbl::pal

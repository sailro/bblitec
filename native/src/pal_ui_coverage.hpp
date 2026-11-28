#pragma once

#include <RmlUi/Core/CallbackTexture.h>
#include <RmlUi/Core/Colour.h>
#include <RmlUi/Core/Geometry.h>
#include <RmlUi/Core/MeshUtilities.h>
#include <RmlUi/Core/RenderManager.h>
#include <RmlUi/Core/Types.h>
#include <cmath>
#include <cstddef>
#include <utility>
#include <vector>

namespace bbl::pal {

/**
 * Premultiplied RGBA pixels of a shape, each pixel `color` scaled by the
 * fraction of an 8x8 sample grid `inside(x, y)` accepts. Sample positions are
 * in CSS pixels from the texture origin, so one shape serves every density.
 */
template <typename Inside>
std::vector<Rml::byte> ui_coverage_pixels(int width, int height, float density,
                                          Rml::ColourbPremultiplied color, Inside inside) {
    constexpr int samples = 8;
    std::vector<Rml::byte> bytes(static_cast<std::size_t>(width) * height * 4);
    for (int y = 0; y < height; ++y)
        for (int x = 0; x < width; ++x) {
            int hits = 0;
            for (int sy = 0; sy < samples; ++sy)
                for (int sx = 0; sx < samples; ++sx)
                    hits += inside((x + (sx + .5f) / samples) / density,
                                   (y + (sy + .5f) / samples) / density)
                                ? 1
                                : 0;
            const float coverage = static_cast<float>(hits) / (samples * samples);
            const auto pixel = static_cast<std::size_t>(y * width + x) * 4;
            bytes[pixel] = static_cast<Rml::byte>(std::lround(color.red * coverage));
            bytes[pixel + 1] = static_cast<Rml::byte>(std::lround(color.green * coverage));
            bytes[pixel + 2] = static_cast<Rml::byte>(std::lround(color.blue * coverage));
            bytes[pixel + 3] = static_cast<Rml::byte>(std::lround(color.alpha * coverage));
        }
    return bytes;
}

/**
 * Premultiplied RGBA pixels drawn one to one: a callback texture under a white
 * quad mapping UV 0..1 over its `width` x `height` pixels.
 */
struct UiPixelQuad {
    Rml::Geometry geometry;
    Rml::CallbackTexture texture;
    Rml::Vector2i size{};

    explicit operator bool() const { return static_cast<bool>(texture); }
    /** Replaces the texture; the quad is rebuilt only for a new size. */
    void build(Rml::RenderManager& manager, std::vector<Rml::byte> bytes, int width, int height) {
        const Rml::Vector2i next{width, height};
        texture = manager.MakeCallbackTexture(
            [bytes = std::move(bytes), next](const Rml::CallbackTextureInterface& out) {
                return out.GenerateTexture(bytes, next);
            });
        if (geometry && size == next)
            return;
        Rml::Mesh mesh;
        Rml::MeshUtilities::GenerateQuad(
            mesh, {0, 0}, {static_cast<float>(width), static_cast<float>(height)},
            Rml::ColourbPremultiplied{255, 255, 255, 255}, {0, 0}, {1, 1});
        geometry = manager.MakeGeometry(std::move(mesh));
        size = next;
    }
    void render(Rml::Vector2f origin) const { geometry.Render(origin, texture); }
};

} // namespace bbl::pal

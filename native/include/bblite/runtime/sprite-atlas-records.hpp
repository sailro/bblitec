#pragma once
// Included within namespace bbl by runtime.hpp.

struct SpriteFrame {
    Vec2 uv_min{};
    Vec2 uv_max{};
    Vec2 source_size_px{};
    Vec2 pivot{0.5f, 0.5f};
};

struct SpriteAtlasRecord {
    // Decoded at load, because `createGridSpriteAtlas` partitions the
    // texture it was handed and so needs its size before any frame exists.
    std::vector<std::uint8_t> rgba;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::vector<SpriteFrame> frames;
    bool premultiplied_alpha = false;
    // `loadTexture2D`'s own `mipMaps`, as the loader that built this atlas
    // passed it: `loadSpriteAtlas` turns the chain off, and the atlas a
    // particle graph's texture block builds leaves it on. The PALs upload
    // the chain this says rather than inferring one from the sampler.
    bool mip_maps = false;
    TextureSamplerState sampler{};
    bool has_render_texture = false;
    SpriteRenderTextureHandle render_texture{};
};

struct SpriteRenderTextureRecord {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    bool disposed = false;
};

/**
 * A WebGPU `GPUCompareFunction`, as this runtime's own enumerator.
 *
 * The pin writes the WebGPU spelling; `pinned-depth-state.ts` maps it here
 * and fails generation on a spelling with no enumerator, so a backend
 * translates an enum rather than re-typing the pin's string.
 */

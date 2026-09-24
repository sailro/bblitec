#pragma once
// Included within namespace bbl by runtime.hpp.

/**
 * `loadSpriteAtlas`'s options. Generation states every member, an unnamed
 * option as the loader's own default read from the pin, so the members
 * carry no initializers of their own.
 */
struct LoadSpriteAtlasOptions {
    float grid_width_px;
    float grid_height_px;
    TextureFilter sampling;
    bool premultiplied_alpha;
    bool premultiply_on_load;
    // `...options.textureOptions` spreads over the loader's own address
    // modes, so a caller's mode replaces the one the loader stamps. A
    // tiling scroll wants repeat on both axes.
    TextureAddressMode address_u;
    TextureAddressMode address_v;
};

/**
 * `createGridSpriteAtlas`'s options. Each optional member carries its
 * presence: an omitted one is absent, and the lowered partition resolves
 * it through the factory's own `??`.
 */
struct GridSpriteAtlasOptions {
    double cell_width_px = 0.0;
    double cell_height_px = 0.0;
    bool has_columns = false;
    double columns = 0.0;
    bool has_rows = false;
    double rows = 0.0;
    bool has_margin_px = false;
    double margin_px = 0.0;
    bool has_spacing_px = false;
    double spacing_px = 0.0;
    bool has_pivot = false;
    Vec2 pivot{};
    bool has_premultiplied_alpha = false;
    bool premultiplied_alpha = false;
};

/** Normalized runtime input to the in-memory sprite-atlas shelf packer. */
struct SpriteAtlasFramePixelsView {
    const std::uint8_t* pixels = nullptr;
    std::size_t byte_length = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint32_t src_x = 0;
    std::uint32_t src_y = 0;
    std::uint32_t src_stride_bytes = 0;
    Vec2 pivot{0.5f, 0.5f};
};

/**
 * `createSpriteAtlasFromFrames`'s options. Generation always emits the full
 * positional literal, so the members carry no initializers of their own.
 */
struct SpriteAtlasPackOptions {
    std::uint32_t padding_px;
    std::uint32_t max_width_px;
    TextureFilter sampling;
    bool premultiplied_alpha;
    bool has_capacity;
    std::uint32_t capacity_width;
    std::uint32_t capacity_height;
};

/**
 * `createSprite2DLayer`'s options. The intrinsic and the node-particle
 * Sprite2D bridge both state every member, an unnamed option as the
 * factory's own default read from the pin, so the members carry no
 * initializers of their own.
 */
struct Sprite2DLayerOptions {
    float capacity;
    SpriteBlendDescriptor blend_mode;
    float opacity;
    bool visible;
    float order;
    Sprite2DDepthMode depth_mode;
    float layer_z;
    Vec2 pivot;
    std::uint32_t custom_shader;
    std::vector<PixelsTexture> custom_textures;
    std::vector<std::string> custom_texture_names;
};

/**
 * Per-sprite init record (`Sprite2DProps`). Every optional field carries a
 * `has_` companion because the pinned writer distinguishes "absent" from a
 * value: an absent `sizePx` falls back to the frame, an absent `flipX`
 * preserves the orientation already baked into the UVs.
 */
/**
 * createFacingBillboardSystem's options. Every generated construction is a
 * full designated-initializer literal (the pin's defaults are emitted by
 * generation and anchored against the pinned defaults table), so the
 * members carry no initializers of their own — a partially-built options
 * struct would be a generation bug, not a fallback.
 */
struct BillboardSystemOptions {
    double capacity;
    SpriteBlendDescriptor blend;
    float opacity;
    bool visible;
    float alpha_cutoff;
    bool has_alpha_cutoff;
    std::uint32_t custom_shader;
    std::vector<PixelsTexture> custom_textures;
    std::vector<std::string> custom_texture_names;
    // particle-billboard-renderable.ts: the mode-4 wrapper's SECOND pass.
    // The pin builds it as `{...system, blendMode: createParticleBlend(2),
    // _customShader: undefined}` when the renderable is built; here the
    // generated builder fills it by name, so no backend resolves a blend of
    // its own. Read only when `blend.particle_passes == 2`.
    SpriteBlendDescriptor add_pass_blend{};
};

/** addBillboardSpriteIndex's props; a `has_` flag marks what was named. */
struct BillboardSpriteProps {
    Vec3 position{};
    Vec2 size_world{};
    bool has_size_world = false;
    float frame = 0.0f;
    bool has_frame = false;
    float rotation = 0.0f;
    bool has_rotation = false;
    Vec2 pivot{};
    bool has_pivot = false;
    Vec4 color{1.0f, 1.0f, 1.0f, 1.0f};
    bool has_color = false;
    bool flip_x = false;
    bool has_flip_x = false;
    bool flip_y = false;
    bool has_flip_y = false;
    bool visible = true;
    bool has_visible = false;
    // Required by add, optional for updateBillboardSprite.
    bool has_position = false;
};

struct Sprite2DProps {
    Vec2 position_px{};
    // `addSprite2DIndex` throws without `positionPx`; `updateSprite2DIndex`
    // takes a `Partial<Sprite2DProps>`, where an omitted position preserves
    // the slot's own. Both arms write this explicitly.
    bool has_position_px = false;
    Vec2 size_px{};
    bool has_size_px = false;
    float frame = 0.0f;
    bool has_frame = false;
    float rotation = 0.0f;
    bool has_rotation = false;
    Vec4 color{1.0f, 1.0f, 1.0f, 1.0f};
    bool has_color = false;
    bool flip_x = false;
    bool has_flip_x = false;
    bool flip_y = false;
    bool has_flip_y = false;
    bool visible = true;
    bool has_visible = false;
    float z = 0.0f;
    bool has_z = false;
};

struct SpriteRendererOptions {
    std::vector<Sprite2DLayerHandle> layers;
    bool clear = true;
    Color4 clear_value{0.0f, 0.0f, 0.0f, 1.0f};
};

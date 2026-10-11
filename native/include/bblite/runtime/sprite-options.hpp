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

/** Borrowed input records; the call retains each source pixel buffer while packing. */
struct SpriteAtlasFramePixelsView {
    const js::U8Array* pixels{};
    double width{};
    double height{};
    std::optional<double> src_x;
    std::optional<double> src_y;
    std::optional<double> src_stride_bytes;
    std::optional<Vec2d> pivot;
};

/** Optional values remain absent until the pinned factory resolves its defaults. */
struct SpriteAtlasPackOptions {
    std::optional<double> padding_px;
    std::optional<double> max_width_px;
    std::optional<std::string> sampling;
    std::optional<bool> premultiplied_alpha;
    std::optional<Vec2d> capacity_px;
};

/**
 * `createSprite2DLayer`'s options. The intrinsic and the node-particle
 * Sprite2D bridge both state every member, an unnamed option as the
 * factory's own default read from the pin, so the members carry no
 * initializers of their own.
 */
struct Sprite2DLayerOptions {
    double capacity;
    SpriteBlendDescriptor blend_mode;
    float opacity;
    bool visible;
    float order;
    Sprite2DDepthMode depth_mode;
    double layer_z;
    Vec2d pivot;
    std::uint32_t custom_shader;
    std::vector<PixelsTexture> custom_textures;
    std::vector<std::string> custom_texture_names;
};

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
    double order = 0;
    bool has_order = false;
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
    Vec3d position{};
    Vec2d size_world{};
    bool has_size_world = false;
    double frame = 0.0f;
    bool has_frame = false;
    double rotation = 0.0f;
    bool has_rotation = false;
    Vec2d pivot{};
    bool has_pivot = false;
    Vec4d color{1.0f, 1.0f, 1.0f, 1.0f};
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

/** Source numeric inputs remain double until the pinned writer's Float32 stores. */
struct Sprite2DProps {
    Vec2d position_px{};
    // `addSprite2DIndex` throws without `positionPx`; `updateSprite2DIndex`
    // takes a `Partial<Sprite2DProps>`, where an omitted position preserves
    // the slot's own. Both arms write this explicitly.
    bool has_position_px = false;
    Vec2d size_px{};
    bool has_size_px = false;
    double frame = 0.0;
    bool has_frame = false;
    double rotation = 0.0;
    bool has_rotation = false;
    Vec4d color{1.0, 1.0, 1.0, 1.0};
    bool has_color = false;
    bool flip_x = false;
    bool has_flip_x = false;
    bool flip_y = false;
    bool has_flip_y = false;
    bool visible = true;
    bool has_visible = false;
    double z = 0.0;
    bool has_z = false;
};

struct SpriteRendererOptions {
    std::vector<Sprite2DLayerHandle> layers;
    bool clear = true;
    Color4 clear_value{0.0f, 0.0f, 0.0f, 1.0f};
    js::Callback<Color4()> clear_value_reader{};
};

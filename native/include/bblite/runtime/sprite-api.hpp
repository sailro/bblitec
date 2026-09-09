#pragma once
// Included within namespace bbl by runtime.hpp.

SpriteAtlasHandle load_sprite_atlas(
    Engine& engine,
    const std::string& path,
    LoadSpriteAtlasOptions options);
SpriteAtlasHandle create_grid_sprite_atlas(
    Engine& engine,
    const FileTexture& texture,
    GridSpriteAtlasOptions options);
SpriteAtlasHandle create_grid_sprite_atlas(
    Engine& engine,
    const PixelsTexture& texture,
    GridSpriteAtlasOptions options);
SpriteAtlasHandle create_grid_sprite_atlas(
    Engine& engine,
    SpriteRenderTextureHandle texture,
    GridSpriteAtlasOptions options);
SpriteRenderTextureHandle create_sprite_render_texture(
    Engine& engine,
    double width,
    double height);
void dispose_sprite_render_texture(
    Engine& engine,
    SpriteRenderTextureHandle texture);
void set_sprite_renderer_target(
    Engine& engine,
    SpriteRendererHandle renderer,
    SpriteRenderTextureHandle target,
    bool has_target);
SpriteAtlasHandle create_sprite_atlas_from_frames(
    Engine& engine,
    const std::vector<SpriteAtlasFramePixelsView>& sources,
    SpriteAtlasPackOptions options);
Sprite2DLayerHandle create_sprite_2d_layer(
    Engine& engine,
    SpriteAtlasHandle atlas,
    Sprite2DLayerOptions options);
BillboardSystemHandle create_billboard_system(
    Engine& engine,
    SpriteAtlasHandle atlas,
    BillboardOrientation orientation,
    Vec3 axis,
    BillboardSystemOptions options);

double add_billboard_sprite_index(
    Engine& engine,
    BillboardSystemHandle system,
    BillboardSpriteProps props);

BillboardSpriteHandle add_billboard_sprite(
    Engine& engine,
    BillboardSystemHandle system,
    BillboardSpriteProps props);

void update_billboard_sprite(
    Engine& engine,
    BillboardSpriteHandle handle,
    BillboardSpriteProps props);

void set_billboard_sprite_frame(
    Engine& engine,
    BillboardSpriteHandle handle,
    double frame);
bool billboard_sprite_alive(
    const Engine& engine,
    BillboardSpriteHandle handle);
void remove_billboard_sprite(
    Engine& engine,
    BillboardSpriteHandle handle);

void clear_billboard_sprites(
    Engine& engine,
    BillboardSystemHandle system);

void add_billboard_system(
    Scene& scene,
    BillboardSystemHandle system);

void set_billboard_alpha_to_coverage(
    Engine& engine,
    BillboardSystemHandle system,
    bool enabled);

void add_depth_hosted_sprite_layer(
    Scene& scene,
    Sprite2DLayerHandle layer);

void set_sprite_2d_alpha_to_coverage(
    Engine& engine,
    Sprite2DLayerHandle layer,
    bool enabled);

void set_sprite_2d_uv_offset(
    Engine& engine,
    Sprite2DLayerHandle layer,
    double index,
    Vec2 uv_offset);

void set_sprite_2d_shader_params(
    Engine& engine,
    Sprite2DLayerHandle layer,
    Vec4 params);

void set_billboard_shader_params(
    Engine& engine,
    BillboardSystemHandle system,
    Vec4 params);

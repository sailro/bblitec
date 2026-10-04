#define main generated_scene_main
#include "scene.hpp"
#undef main
#include <cassert>
#include <cstdio>

namespace {
std::uint32_t lights = 0;
std::uint32_t offset_writes = 0;
std::uint32_t plane_writes = 0;
} // namespace
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
Scene create_scene_context(Engine& engine) {
    Scene scene;
    scene.engine = &engine;
    return scene;
}
SpriteRenderTextureHandle create_sprite_render_texture(Engine&, double width, double height) {
    assert(width == 1 && height == 1);
    return {0};
}
SpriteAtlasHandle create_grid_sprite_atlas(Engine&, SpriteRenderTextureHandle texture,
                                           GridSpriteAtlasOptions options) {
    assert(texture.value == 0 && options.cell_width_px == 1 && options.cell_height_px == 1);
    return {0};
}
Sprite2DLayerHandle create_sprite_2d_layer(Engine&, SpriteAtlasHandle atlas,
                                           Sprite2DLayerOptions options) {
    assert(atlas.value == 0 && options.capacity == 1);
    return {0};
}
double add_sprite_2d_index(Engine&, Sprite2DLayerHandle layer, Sprite2DProps) {
    assert(layer.value == 0);
    return 0;
}
void set_sprite_2d_uv_offset(Engine&, Sprite2DLayerHandle layer, double index, Vec2 offset) {
    const auto pass = offset_writes++ / 3;
    assert(layer.value == 0 && index == 0);
    assert(offset.x == static_cast<float>(pass + 1));
    assert(offset.y == static_cast<float>(pass + 2));
}
void set_scene_clip_plane(Scene& scene, Vec4 plane) {
    const auto pass = plane_writes++ / 3;
    assert(plane.x == static_cast<float>(pass + 3));
    assert(plane.y == static_cast<float>(pass + 4));
    assert(plane.z == static_cast<float>(pass + 5));
    assert(plane.w == static_cast<float>(pass + 6));
    assert(scene.clear_color.r == static_cast<float>(pass + 10));
    assert(scene.clear_color.g == static_cast<float>(pass + 20));
    assert(scene.clear_color.b == static_cast<float>(pass + 30));
    assert(scene.clear_color.a == static_cast<float>(pass + 40));
}
MaterialHandle create_standard_material(Engine& engine) {
    const auto index = static_cast<std::uint32_t>(engine.materials.size());
    engine.materials.emplace_back();
    return {index};
}
LightHandle create_hemispheric_light(Engine& engine, Vec3 direction, double intensity) {
    assert(direction.x == 4 && direction.y == 5 && direction.z == 6 && intensity == 1);
    assert(engine.materials.size() == lights + 1);
    const auto& color = engine.materials.back().diffuse_color;
    assert(color.r == static_cast<float>(lights * 3 + 1));
    assert(color.g == static_cast<float>(lights * 3 + 2));
    assert(color.b == static_cast<float>(lights * 3 + 3));
    return {lights++};
}
} // namespace bbl
int main() {
    assert(generated_scene_main() == 0);
    assert(lights == 4);
    assert(offset_writes == 12 && plane_writes == 12);
    std::puts("vector-tuple-check: ok");
}

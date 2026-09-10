#define main generated_scene_main
#include "scene.hpp"
#undef main
#include <cassert>
#include <cstdio>

namespace { std::uint32_t lights = 0; }
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
MaterialHandle create_standard_material(Engine& engine) {
    const auto index = static_cast<std::uint32_t>(engine.materials.size());
    engine.materials.emplace_back();
    return {index};
}
LightHandle create_hemispheric_light(Engine& engine, Vec3 direction, float intensity) {
    assert(direction.x == 4 && direction.y == 5 && direction.z == 6 && intensity == 1);
    assert(engine.materials.size() == lights + 1);
    const auto& color = engine.materials.back().diffuse_color;
    assert(color.r == static_cast<float>(lights * 3 + 1));
    assert(color.g == static_cast<float>(lights * 3 + 2));
    assert(color.b == static_cast<float>(lights * 3 + 3));
    return {lights++};
}
}
int main() {
    assert(generated_scene_main() == 0);
    assert(lights == 4);
    std::puts("vector-tuple-check: ok");
}

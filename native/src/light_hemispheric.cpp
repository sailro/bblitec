#include <bblite/runtime.hpp>

namespace bbl {

LightHandle create_hemispheric_light(Engine& engine, Vec3 direction, float intensity) {
    LightRecord light;
    light.direction = direction;
    light.intensity = intensity;
    engine.lights.push_back(light);
    return LightHandle{static_cast<std::uint32_t>(engine.lights.size() - 1)};
}

} // namespace bbl

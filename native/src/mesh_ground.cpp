#include <bblite/runtime.hpp>

namespace bbl {

MeshHandle create_ground(Engine& engine, GroundOptions options) {
    MeshRecord mesh;
    mesh.primitive = PrimitiveKind::ground;
    mesh.dimensions = Vec3{options.width, 0.0f, options.height};
    engine.meshes.push_back(mesh);
    return MeshHandle{static_cast<std::uint32_t>(engine.meshes.size() - 1)};
}

} // namespace bbl

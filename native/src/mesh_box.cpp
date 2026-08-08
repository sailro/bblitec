#include <bblite/runtime.hpp>

namespace bbl {

MeshHandle create_box(Engine& engine, float size) {
    MeshRecord mesh;
    mesh.primitive = PrimitiveKind::box;
    mesh.dimensions = Vec3{size, size, size};
    engine.meshes.push_back(mesh);
    return MeshHandle{static_cast<std::uint32_t>(engine.meshes.size() - 1)};
}

} // namespace bbl

#include <bblite/runtime.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>

namespace bbl {
namespace {

Vec3 rotate(Vec3 value, Vec3 rotation) {
    const float sin_x = std::sin(rotation.x);
    const float cos_x = std::cos(rotation.x);
    const float sin_y = std::sin(rotation.y);
    const float cos_y = std::cos(rotation.y);
    const float sin_z = std::sin(rotation.z);
    const float cos_z = std::cos(rotation.z);

    value = Vec3{value.x, value.y * cos_x - value.z * sin_x, value.y * sin_x + value.z * cos_x};
    value = Vec3{value.x * cos_y + value.z * sin_y, value.y, -value.x * sin_y + value.z * cos_y};
    return Vec3{value.x * cos_z - value.y * sin_z, value.x * sin_z + value.y * cos_z, value.z};
}

Vec3 transform(Vec3 value, const MeshRecord& mesh) {
    value = Vec3{value.x * mesh.scaling.x, value.y * mesh.scaling.y, value.z * mesh.scaling.z};
    value = rotate(value, mesh.rotation);
    return Vec3{value.x + mesh.position.x, value.y + mesh.position.y, value.z + mesh.position.z};
}

void extend_bounds(Vec3 point, Vec3& minimum, Vec3& maximum) {
    minimum.x = std::min(minimum.x, point.x);
    minimum.y = std::min(minimum.y, point.y);
    minimum.z = std::min(minimum.z, point.z);
    maximum.x = std::max(maximum.x, point.x);
    maximum.y = std::max(maximum.y, point.y);
    maximum.z = std::max(maximum.z, point.z);
}

} // namespace

CameraHandle create_default_camera(Engine& engine, Scene& scene) {
    Vec3 minimum{
        std::numeric_limits<float>::max(),
        std::numeric_limits<float>::max(),
        std::numeric_limits<float>::max(),
    };
    Vec3 maximum{
        std::numeric_limits<float>::lowest(),
        std::numeric_limits<float>::lowest(),
        std::numeric_limits<float>::lowest(),
    };
    bool has_bounds = false;

    for (const MeshHandle handle : scene.meshes) {
        if (handle.value >= engine.meshes.size()) {
            continue;
        }
        const MeshRecord& mesh = engine.meshes[handle.value];
        Vec3 local_min{};
        Vec3 local_max{};
        if (mesh.primitive == PrimitiveKind::gltf && mesh.geometry < engine.geometries.size()) {
            local_min = engine.geometries[mesh.geometry].bounds_min;
            local_max = engine.geometries[mesh.geometry].bounds_max;
        } else {
            local_min = Vec3{-mesh.dimensions.x * 0.5f, -mesh.dimensions.y * 0.5f, -mesh.dimensions.z * 0.5f};
            local_max = Vec3{mesh.dimensions.x * 0.5f, mesh.dimensions.y * 0.5f, mesh.dimensions.z * 0.5f};
        }

        const std::array<Vec3, 8> corners = {
            Vec3{local_min.x, local_min.y, local_min.z},
            Vec3{local_max.x, local_min.y, local_min.z},
            Vec3{local_min.x, local_max.y, local_min.z},
            Vec3{local_max.x, local_max.y, local_min.z},
            Vec3{local_min.x, local_min.y, local_max.z},
            Vec3{local_max.x, local_min.y, local_max.z},
            Vec3{local_min.x, local_max.y, local_max.z},
            Vec3{local_max.x, local_max.y, local_max.z},
        };
        for (const Vec3 corner : corners) {
            extend_bounds(transform(corner, mesh), minimum, maximum);
        }
        has_bounds = true;
    }

    Vec3 target{};
    float radius = 1.0f;
    if (has_bounds) {
        target = Vec3{
            (minimum.x + maximum.x) * 0.5f,
            (minimum.y + maximum.y) * 0.5f,
            (minimum.z + maximum.z) * 0.5f,
        };
        const Vec3 extent{maximum.x - minimum.x, maximum.y - minimum.y, maximum.z - minimum.z};
        const float diagonal = std::sqrt(extent.x * extent.x + extent.y * extent.y + extent.z * extent.z);
        radius = diagonal > 0.0f ? diagonal * 1.5f : 1.0f;
    }

    const auto camera = create_arc_rotate_camera(engine, -pi / 2.0f, pi / 2.0f, radius, target);
    set_camera(scene, camera);
    return camera;
}

} // namespace bbl

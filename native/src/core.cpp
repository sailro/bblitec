#include <bblite/runtime.hpp>
#include <bblite/pal.hpp>

#include <stdexcept>
#include <utility>

#ifndef BBLITE_ASSET_DIR
#define BBLITE_ASSET_DIR "."
#endif

namespace bbl {
namespace {

template <typename Record, typename Handle>
Record& checked(std::vector<Record>& records, Handle handle, const char* kind) {
    if (handle.value >= records.size()) {
        throw std::runtime_error(std::string("Invalid ") + kind + " handle.");
    }
    return records[handle.value];
}

void require_scene_engine(const Scene& scene) {
    if (!scene.engine) {
        throw std::runtime_error("Scene is not associated with an engine.");
    }
}

} // namespace

Engine create_engine(EngineOptions options) {
    Engine engine;
    engine.options = std::move(options);
    return engine;
}

std::string asset_path(const std::string& relative_path) {
    return pal::join_path(BBLITE_ASSET_DIR, relative_path);
}

void set_clear_color(Scene& scene, Color4 color) {
    scene.clear_color = color;
}

void set_camera(Scene& scene, CameraHandle camera) {
    require_scene_engine(scene);
    checked(scene.engine->cameras, camera, "camera");
    scene.camera = camera;
}

void set_position(Engine& engine, MeshHandle mesh, Vec3 position) {
    checked(engine.meshes, mesh, "mesh").position = position;
}

void set_rotation(Engine& engine, MeshHandle mesh, Vec3 rotation) {
    checked(engine.meshes, mesh, "mesh").rotation = rotation;
}

void set_rotation_axis(Engine& engine, MeshHandle mesh, int axis, float value) {
    auto& rotation = checked(engine.meshes, mesh, "mesh").rotation;
    if (axis == 0) {
        rotation.x = value;
    } else if (axis == 1) {
        rotation.y = value;
    } else if (axis == 2) {
        rotation.z = value;
    } else {
        throw std::runtime_error("Invalid rotation axis.");
    }
}

void set_scaling(Engine& engine, MeshHandle mesh, Vec3 scaling) {
    checked(engine.meshes, mesh, "mesh").scaling = scaling;
}

void set_material(Engine& engine, MeshHandle mesh, MaterialHandle material) {
    checked(engine.materials, material, "material");
    checked(engine.meshes, mesh, "mesh").material = material;
}

void set_diffuse_color(Engine& engine, MaterialHandle material, Color3 color) {
    checked(engine.materials, material, "material").diffuse_color = color;
}

void set_camera_alpha(Engine& engine, CameraHandle camera, float alpha) {
    checked(engine.cameras, camera, "camera").alpha = alpha;
}

void set_camera_beta(Engine& engine, CameraHandle camera, float beta) {
    checked(engine.cameras, camera, "camera").beta = beta;
}

void set_camera_radius(Engine& engine, CameraHandle camera, float radius) {
    checked(engine.cameras, camera, "camera").radius = radius;
}

} // namespace bbl

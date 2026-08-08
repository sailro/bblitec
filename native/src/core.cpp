#include <bblite/runtime.hpp>

#include <filesystem>
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

Scene create_scene_context(Engine& engine) {
    Scene scene;
    scene.engine = &engine;
    return scene;
}

std::string asset_path(const std::string& relative_path) {
    return (std::filesystem::path(BBLITE_ASSET_DIR) / relative_path).lexically_normal().string();
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

void add_to_scene(Scene& scene, MeshHandle mesh) {
    require_scene_engine(scene);
    checked(scene.engine->meshes, mesh, "mesh");
    scene.meshes.push_back(mesh);
}

void add_to_scene(Scene& scene, LightHandle light) {
    require_scene_engine(scene);
    checked(scene.engine->lights, light, "light");
    scene.lights.push_back(light);
}

void add_to_scene(Scene& scene, AssetHandle asset) {
    require_scene_engine(scene);
    const auto& record = checked(scene.engine->assets, asset, "asset");
    for (const MeshHandle mesh : record.meshes) {
        add_to_scene(scene, mesh);
    }
}

void attach_control(Engine& engine, CameraHandle camera, Scene& scene) {
    auto& record = checked(engine.cameras, camera, "camera");
    record.controls_enabled = true;
    set_camera(scene, camera);
}

void register_scene(Scene& scene) {
    require_scene_engine(scene);
    scene.engine->registered_scenes.push_back(&scene);
}

} // namespace bbl

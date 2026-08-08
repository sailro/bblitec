#pragma once

#include <array>
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

namespace bbl {

inline constexpr float pi = 3.14159265358979323846f;
inline constexpr std::uint32_t invalid_handle = std::numeric_limits<std::uint32_t>::max();

struct Vec3 {
    float x = 0.0f;
    float y = 0.0f;
    float z = 0.0f;
};

struct Vec2 {
    float x = 0.0f;
    float y = 0.0f;
};

struct Vec4 {
    float x = 0.0f;
    float y = 0.0f;
    float z = 0.0f;
    float w = 0.0f;
};

struct Color3 {
    float r = 1.0f;
    float g = 1.0f;
    float b = 1.0f;
};

struct Color4 {
    float r = 0.05f;
    float g = 0.06f;
    float b = 0.09f;
    float a = 1.0f;
};

struct EngineOptions {
    std::string title = "Babylon Lite Native";
    int width = 1280;
    int height = 720;
};

struct MeshHandle {
    std::uint32_t value = invalid_handle;
};

struct MaterialHandle {
    std::uint32_t value = invalid_handle;
};

struct LightHandle {
    std::uint32_t value = invalid_handle;
};

struct CameraHandle {
    std::uint32_t value = invalid_handle;
};

struct AssetHandle {
    std::uint32_t value = invalid_handle;
};

enum class PrimitiveKind {
    box,
    gltf,
    ground,
};

struct TextureData {
    std::vector<std::uint8_t> bytes;
    std::string mime_type;
};

struct ModelVertex {
    Vec3 position{};
    Vec3 normal{0.0f, 1.0f, 0.0f};
    Vec4 tangent{1.0f, 0.0f, 0.0f, 1.0f};
    Vec2 uv{};
};

struct ModelGeometry {
    std::vector<ModelVertex> vertices;
    std::vector<std::uint32_t> indices;
    Vec3 bounds_min{};
    Vec3 bounds_max{};
};

struct MeshRecord {
    PrimitiveKind primitive = PrimitiveKind::box;
    Vec3 position{};
    Vec3 rotation{};
    Vec3 scaling{1.0f, 1.0f, 1.0f};
    Vec3 dimensions{1.0f, 1.0f, 1.0f};
    MaterialHandle material{};
    std::uint32_t geometry = invalid_handle;
};

struct MaterialRecord {
    Color3 diffuse_color{};
    Color4 base_color_factor{1.0f, 1.0f, 1.0f, 1.0f};
    Color3 emissive_factor{};
    float metallic_factor = 1.0f;
    float roughness_factor = 1.0f;
    bool double_sided = false;
    TextureData base_color_texture;
    TextureData metallic_roughness_texture;
    TextureData normal_texture;
    TextureData emissive_texture;
};

struct LightRecord {
    Vec3 direction{0.0f, 1.0f, 0.0f};
    float intensity = 1.0f;
    Color3 diffuse_color{};
    Color3 specular_color{};
    Color3 ground_color{0.0f, 0.0f, 0.0f};
    std::array<float, 16> local_matrix{};
};

struct CameraRecord {
    float alpha = -pi / 2.0f;
    float beta = 1.1f;
    float radius = 6.0f;
    Vec3 target{};
    float fov = 0.8f;
    float near_plane = 0.1f;
    float far_plane = 1000.0f;
    float inertia = 0.9f;
    float panning_inertia = 0.9f;
    float angular_sensibility = 1000.0f;
    float panning_sensibility = 50.0f;
    float wheel_precision = 3.0f;
    bool controls_enabled = false;
};

struct Scene;

struct AssetRecord {
    std::vector<MeshHandle> meshes;
    std::vector<LightHandle> lights;
    bool has_clear_color = false;
    Color4 clear_color{};
    bool has_camera = false;
    CameraHandle camera{};
};

struct Engine {
    EngineOptions options{};
    std::vector<MeshRecord> meshes;
    std::vector<MaterialRecord> materials;
    std::vector<LightRecord> lights;
    std::vector<CameraRecord> cameras;
    std::vector<ModelGeometry> geometries;
    std::vector<AssetRecord> assets;
    std::vector<Scene*> registered_scenes;
};

struct EnvironmentState {
    bool enabled = false;
    bool has_irradiance = false;
    std::array<Color3, 9> spherical_harmonics{};
    std::uint32_t specular_width = 0;
    std::uint32_t specular_mip_count = 0;
    std::vector<TextureData> specular_faces;
    TextureData brdf_lut;
    std::string source_url;
};

struct Scene {
    Engine* engine = nullptr;
    Color4 clear_color{};
    CameraHandle camera{};
    std::vector<MeshHandle> meshes;
    std::vector<LightHandle> lights;
    EnvironmentState environment;
};

struct GroundOptions {
    float width = 1.0f;
    float height = 1.0f;
};

struct EnvironmentOptions {
    std::string environment_url;
    std::string ground_texture_url;
    std::string skybox_url;
    float skybox_size = 1000.0f;
    std::string brdf_url;
};

Engine create_engine(EngineOptions options = {});
Scene create_scene_context(Engine& engine);
std::string asset_path(const std::string& relative_path);

MeshHandle create_box(Engine& engine, float size = 1.0f);
MeshHandle create_ground(Engine& engine, GroundOptions options = {});
AssetHandle load_gltf(Engine& engine, const std::string& path);
void load_environment(Scene& scene, EnvironmentOptions options);
MaterialHandle create_standard_material(Engine& engine);
LightHandle create_hemispheric_light(Engine& engine, Vec3 direction, float intensity = 1.0f);
CameraHandle create_arc_rotate_camera(Engine& engine, float alpha, float beta, float radius, Vec3 target);
CameraHandle create_default_camera(Engine& engine, Scene& scene);

void set_clear_color(Scene& scene, Color4 color);
void set_camera(Scene& scene, CameraHandle camera);
void set_position(Engine& engine, MeshHandle mesh, Vec3 position);
void set_rotation(Engine& engine, MeshHandle mesh, Vec3 rotation);
void set_rotation_axis(Engine& engine, MeshHandle mesh, int axis, float value);
void set_scaling(Engine& engine, MeshHandle mesh, Vec3 scaling);
void set_material(Engine& engine, MeshHandle mesh, MaterialHandle material);
void set_diffuse_color(Engine& engine, MaterialHandle material, Color3 color);
void set_camera_alpha(Engine& engine, CameraHandle camera, float alpha);
void set_camera_beta(Engine& engine, CameraHandle camera, float beta);
void set_camera_radius(Engine& engine, CameraHandle camera, float radius);

void add_to_scene(Scene& scene, MeshHandle mesh);
void add_to_scene(Scene& scene, LightHandle light);
void add_to_scene(Scene& scene, AssetHandle asset);
void attach_control(Engine& engine, CameraHandle camera, Scene& scene);
void register_scene(Scene& scene);
void start_engine(Engine& engine);

} // namespace bbl

#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <limits>
#include <memory>
#include <string>
#include <vector>

namespace bbl {

inline constexpr float pi = 3.14159265358979323846f;
inline constexpr std::uint32_t invalid_handle = std::numeric_limits<std::uint32_t>::max();
inline constexpr std::uint32_t material_family_pbr = 1u << 0;
inline constexpr std::uint32_t material_family_standard = 1u << 1;
inline constexpr std::uint32_t material_family_shader = 1u << 2;
inline constexpr std::uint32_t material_family_grid = 1u << 3;

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

struct RenderTargetHandle {
    std::uint32_t value = invalid_handle;
};

struct TaskHandle {
    std::uint32_t value = invalid_handle;
};

enum class PrimitiveKind {
    babylon,
    box,
    gltf,
    ground,
    sphere,
    torus,
};

enum class CameraKind {
    arc_rotate,
    free,
};

enum class LightKind {
    directional,
    hemispheric,
    point,
};

enum class MaterialAlphaMode {
    opaque,
    mask,
    blend,
};

enum class PropertyAnimationPath {
    position,
    position_x,
    scaling,
    rotation_quaternion,
};

enum class PropertyAnimationInterpolation {
    linear,
    step,
};

enum class ShaderMaterialVariant {
    alpha_card,
    circular_cutout,
};

enum class GeometryTextureType {
    irradiance,
    world_position,
    local_position,
    reflectivity,
    view_depth,
    normalized_view_depth,
    screenspace_depth,
    view_normal,
    world_normal,
    albedo,
    linear_velocity,
};

enum class GeometryTextureFormat {
    automatic,
    r16_float,
};

struct GeometryTextureDescription {
    GeometryTextureType type = GeometryTextureType::irradiance;
    GeometryTextureFormat format = GeometryTextureFormat::automatic;
};

struct NormalizedViewport {
    double x = 0.0;
    double y = 0.0;
    double width = 1.0;
    double height = 1.0;
};

struct RenderTargetOptions {
    std::uint32_t samples = 1;
    bool has_color = true;
    bool has_depth = false;
    bool sampled_depth = false;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
};

struct RenderTaskOptions {
    std::string name;
    RenderTargetHandle target{};
    Color4 clear_color{};
    bool clear = false;
    CameraHandle camera{};
    bool has_camera = false;
    bool canvas_size = false;
    bool auto_mirror = true;
};

struct RenderTaskMesh {
    MeshHandle mesh{};
    MaterialHandle material{};
};

struct GeometryTaskOptions {
    std::string name;
    std::uint32_t shader_index = 0;
    std::uint32_t samples = 1;
    std::vector<GeometryTextureDescription> attachments;
    RenderTargetHandle target{};
    bool clear_target = false;
    Color4 target_clear_color{};
};

enum class RenderTextureSource {
    render_target,
    geometry,
    geometry_output,
};

struct RenderTextureRef {
    RenderTextureSource source = RenderTextureSource::render_target;
    RenderTargetHandle target{};
    TaskHandle task{};
    GeometryTextureType geometry_type = GeometryTextureType::irradiance;
};

struct CopyTaskOptions {
    std::string name;
    RenderTextureRef source{};
    RenderTargetHandle target{};
    RenderTargetHandle resolve_target{};
    bool has_viewport = false;
    NormalizedViewport viewport{};
};

enum class FrameTaskKind {
    render,
    geometry,
    copy,
};

struct RenderTargetRecord {
    std::uint32_t samples = 1;
    bool has_color = true;
    bool has_depth = false;
    bool sampled_depth = false;
    bool swapchain = false;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
};

struct FrameTaskRecord {
    FrameTaskKind kind = FrameTaskKind::render;
    RenderTaskOptions render;
    std::vector<RenderTaskMesh> render_meshes;
    GeometryTaskOptions geometry;
    CopyTaskOptions copy;
};

struct RenderTargetTexture {
    RenderTargetHandle rt{};
    RenderTextureRef texture{};
};

struct SolidTexture {
    Color4 color{};
};

struct PbrMaterialOptions {
    SolidTexture base_color{};
    SolidTexture orm{};
    float metallic_factor = 1.0f;
    float roughness_factor = 1.0f;
    float direct_intensity = 1.0f;
    float environment_intensity = 1.0f;
    float alpha = 1.0f;
    float reflectance = 0.04f;
    bool unlit = false;
    bool double_sided = false;
    bool skybox_mode = false;
    float transmission_factor = 0.0f;
    float index_of_refraction = 1.5f;
    float thickness = 0.0f;
    bool use_thickness_as_depth = false;
    bool has_volume = false;
    Color3 attenuation_color{1.0f, 1.0f, 1.0f};
    float attenuation_distance = 1.0f;
};

struct GridMaterialOptions {
    Color3 main_color{0.0f, 0.0f, 0.0f};
    Color3 line_color{0.0f, 0.5f, 0.5f};
    float grid_ratio = 1.0f;
    Vec3 grid_offset{};
    float major_unit_frequency = 10.0f;
    float minor_unit_visibility = 0.33f;
    float opacity = 1.0f;
    float visibility = 1.0f;
    bool antialias = true;
    bool pre_multiply_alpha = false;
    bool use_max_line = false;
    bool back_face_culling = true;
};

enum class TextureFilter {
    nearest,
    linear,
};

enum class TextureMipmapMode {
    nearest,
    linear,
};

enum class TextureAddressMode {
    repeat,
    clamp,
    mirror,
};

struct TextureSamplerState {
    TextureFilter min_filter = TextureFilter::linear;
    TextureFilter mag_filter = TextureFilter::linear;
    TextureMipmapMode mipmap_mode = TextureMipmapMode::linear;
    TextureAddressMode address_u = TextureAddressMode::repeat;
    TextureAddressMode address_v = TextureAddressMode::repeat;
    float max_anisotropy = 1.0f;
    float max_lod = 1000.0f;
};

struct TextureData {
    std::vector<std::uint8_t> bytes;
    TextureSamplerState sampler{};
    bool invert_y = false;
};

struct ModelVertex {
    Vec3 position{};
    Vec3 normal{0.0f, 1.0f, 0.0f};
    Vec4 tangent{1.0f, 0.0f, 0.0f, 1.0f};
    Vec2 uv{};
    Vec2 uv2{};
    Vec3 local_position{};
    Vec4 color{1.0f, 1.0f, 1.0f, 1.0f};
    std::array<std::uint16_t, 4> joints{};
    Vec4 weights{};
};

struct ModelGeometry {
    std::vector<ModelVertex> vertices;
    std::vector<ModelVertex> bind_vertices;
    std::vector<std::vector<Vec3>> morph_positions;
    std::vector<std::vector<Vec3>> morph_normals;
    std::vector<std::vector<Vec3>> morph_tangents;
    std::vector<std::uint32_t> indices;
    bool has_tangents = false;
    bool flat_normals = false;
    Vec3 bounds_min{};
    Vec3 bounds_max{};
};

struct MeshRecord {
    PrimitiveKind primitive = PrimitiveKind::box;
    Vec3 position{};
    Vec3 rotation{};
    Vec4 rotation_quaternion{0.0f, 0.0f, 0.0f, 1.0f};
    Vec3 scaling{1.0f, 1.0f, 1.0f};
    Vec3 dimensions{1.0f, 1.0f, 1.0f};
    MaterialHandle material{};
    std::uint32_t geometry = invalid_handle;
    float baked_world_scale = 1.0f;
    std::uint64_t transform_version = 0;
    bool has_rotation_quaternion = false;
    bool gpu_deformation = false;
    std::vector<std::array<float, 16>> bone_matrices;
    std::array<float, 4> morph_weights{};
};

struct PropertyAnimationKey {
    float time = 0.0f;
    std::array<float, 4> value{};
};

struct PropertyAnimationTrack {
    PropertyAnimationPath path = PropertyAnimationPath::position;
    PropertyAnimationInterpolation interpolation =
        PropertyAnimationInterpolation::linear;
    std::vector<PropertyAnimationKey> keys;
};

struct PropertyAnimationClip {
    std::string name;
    std::vector<PropertyAnimationTrack> tracks;
    float duration = 0.0f;
    float frame_rate = 60.0f;
};

struct PropertyAnimationGroupRecord {
    MeshHandle target{};
    PropertyAnimationClip clip;
    float from_time = 0.0f;
    float to_time = 0.0f;
    float current_time = 0.0f;
    float speed_ratio = 1.0f;
    bool loop = true;
    bool playing = true;
};

using PropertyAnimationGroup =
    std::shared_ptr<PropertyAnimationGroupRecord>;

struct PropertyAnimationManagerRecord {
    std::vector<PropertyAnimationGroup> groups;
    bool started = false;
};

using PropertyAnimationManager =
    std::shared_ptr<PropertyAnimationManagerRecord>;

struct PropertyAnimationGroupOptions {
    float from_time = 0.0f;
    float to_time = 0.0f;
    float speed_ratio = 1.0f;
    bool loop = true;
};

struct MaterialRecord {
    Color3 diffuse_color{};
    Color4 base_color_factor{1.0f, 1.0f, 1.0f, 1.0f};
    Color3 emissive_factor{};
    Color3 specular_color{1.0f, 1.0f, 1.0f};
    Color3 ambient_color{};
    float specular_power = 64.0f;
    float diffuse_level = 1.0f;
    float opacity_level = 1.0f;
    float ambient_level = 1.0f;
    float diffuse_u_scale = 1.0f;
    float diffuse_v_scale = 1.0f;
    std::uint32_t specular_coord_index = 0;
    std::uint32_t ambient_coord_index = 0;
    float metallic_factor = 1.0f;
    float roughness_factor = 1.0f;
    float direct_intensity = 1.0f;
    float environment_intensity = 1.0f;
    float reflectance = 0.04f;
    float normal_texture_scale = 1.0f;
    float transmission_factor = 0.0f;
    float index_of_refraction = 1.5f;
    float thickness = 0.0f;
    bool use_thickness_as_depth = false;
    Color3 attenuation_color{1.0f, 1.0f, 1.0f};
    float attenuation_distance = 1.0f;
    bool has_ior = false;
    bool has_volume = false;
    bool skybox_mode = false;
    bool specular_aa = false;
    bool has_occlusion_texture = false;
    bool unlit = false;
    bool no_color = false;
    bool disable_lighting = false;
    bool has_emissive_render_texture = false;
    bool double_sided = false;
    bool standard_material = false;
    bool shader_material = false;
    bool grid_material = false;
    bool alpha_to_coverage = false;
    bool shader_alpha_testing = false;
    bool shader_depth_write = true;
    ShaderMaterialVariant shader_variant = ShaderMaterialVariant::alpha_card;
    Vec2 shader_center{};
    float shader_angle = 0.0f;
    float shader_depth = 0.5f;
    Color3 shader_color{};
    float shader_opacity = 1.0f;
    Color3 grid_main_color{0.0f, 0.0f, 0.0f};
    Color3 grid_line_color{0.0f, 0.5f, 0.5f};
    Vec4 grid_control{1.0f, 10.0f, 0.33f, 1.0f};
    Vec3 grid_offset{};
    float grid_visibility = 1.0f;
    bool grid_antialias = true;
    bool grid_pre_multiply_alpha = false;
    bool grid_use_max_line = false;
    MaterialAlphaMode alpha_mode = MaterialAlphaMode::opaque;
    float alpha_cutoff = 0.5f;
    TextureData base_color_texture;
    TextureData metallic_roughness_texture;
    TextureData normal_texture;
    TextureData transmission_texture;
    TextureData thickness_texture;
    TextureData emissive_texture;
    TextureData opacity_texture;
    TextureData specular_texture;
    TextureData ambient_texture;
    RenderTextureRef emissive_render_texture{};
    std::uint32_t reflection_cube = invalid_handle;
    float reflection_level = 1.0f;
};

struct LightRecord {
    LightKind kind = LightKind::directional;
    Vec3 position{};
    Vec3 direction{0.0f, 1.0f, 0.0f};
    float intensity = 1.0f;
    float range = std::numeric_limits<float>::max();
    Color3 diffuse_color{};
    Color3 specular_color{};
    Color3 ground_color{0.0f, 0.0f, 0.0f};
    std::array<float, 16> local_matrix{};
};

struct CameraRecord {
    CameraKind kind = CameraKind::arc_rotate;
    Vec3 position{};
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
    float speed = 2.0f;
    float free_yaw = 0.0f;
    float free_pitch = 0.0f;
    float inertial_yaw_offset = 0.0f;
    float inertial_pitch_offset = 0.0f;
    Vec3 inertial_direction{};
    float panning_sensibility = 50.0f;
    float wheel_precision = 3.0f;
    float inertial_alpha_offset = 0.0f;
    float inertial_beta_offset = 0.0f;
    float inertial_radius_offset = 0.0f;
    float inertial_panning_x = 0.0f;
    float inertial_panning_y = 0.0f;
    bool controls_enabled = false;
};

struct Scene;

struct AssetRecord {
    std::vector<MeshHandle> meshes;
    std::vector<LightHandle> lights;
    CameraHandle camera{};
    Color4 clear_color{};
    bool has_camera = false;
    bool has_clear_color = false;
    std::function<void(float)> animation_tick;
    std::function<void(float)> animation_seek;
};

struct Engine {
    EngineOptions options{};
    std::vector<MeshRecord> meshes;
    std::vector<MaterialRecord> materials;
    std::vector<LightRecord> lights;
    std::vector<CameraRecord> cameras;
    std::vector<ModelGeometry> geometries;
    std::vector<std::array<TextureData, 6>> reflection_cubes;
    std::vector<AssetRecord> assets;
    std::vector<RenderTargetRecord> render_targets;
    std::vector<FrameTaskRecord> frame_tasks;
    RenderTargetHandle swapchain_target{};
    std::vector<Scene*> registered_scenes;
};

struct EnvironmentState {
    bool has_irradiance = false;
    float exposure = 1.0f;
    float contrast = 1.0f;
    float lod_generation_scale = 0.8f;
    bool tone_mapping_enabled = false;
    std::array<Color3, 9> spherical_harmonics{};
    std::uint32_t specular_width = 0;
    std::uint32_t specular_mip_count = 0;
    std::vector<TextureData> specular_faces;
    bool specular_rgba16f = false;
    TextureData brdf_lut;
    TextureData ground_texture;
    TextureData skybox_texture;
    bool has_ground = false;
    bool has_skybox = false;
    bool background_enabled_by_default = false;
    bool skybox_uses_environment = false;
    float ground_size = 15.0f;
    float skybox_size = 20.0f;
    std::uint32_t skybox_width = 0;
    std::uint32_t skybox_mip_count = 0;
    std::uint32_t skybox_data_offset = 0;
    Vec3 ground_position{};
    Vec3 skybox_position{};
    Color3 primary_color{0.08697356f, 0.08697356f, 0.21222083f};
};

struct Scene {
    Engine* engine = nullptr;
    Color4 clear_color{};
    CameraHandle camera{};
    std::vector<MeshHandle> meshes;
    std::vector<LightHandle> lights;
    std::vector<TaskHandle> tasks;
    std::vector<std::function<void(float)>> before_render;
    std::vector<std::function<void(float)>> animation_seekers;
    EnvironmentState environment;
    float fixed_delta_ms = 0.0f;
    std::uint64_t mesh_membership_version = 0;
    std::uint32_t material_family_mask = 0;
    bool transmission_enabled = false;
};

struct GroundOptions {
    float width = 1.0f;
    float height = 1.0f;
};

struct PlaneOptions {
    float width = 1.0f;
    float height = 1.0f;
};

struct SphereOptions {
    std::uint32_t segments = 32;
    float diameter = 1.0f;
};

struct TorusOptions {
    float diameter = 1.0f;
    float thickness = 0.5f;
    std::uint32_t tessellation = 16;
};

struct EnvironmentOptions {
    std::string environment_url;
    std::string ground_texture_url;
    std::string skybox_url;
    float skybox_size = 1000.0f;
    std::string brdf_url;
};

struct HdrEnvironmentOptions {
    std::string environment_url;
    std::string brdf_url;
    bool use_cubemap_skybox = false;
    float skybox_size = 0.0f;
    Vec3 skybox_position{};
};

Engine create_engine(EngineOptions options = {});
Scene create_scene_context(Engine& engine);
std::string asset_path(const std::string& relative_path);

MeshHandle create_box(Engine& engine, float size = 1.0f);
MeshHandle create_ground(Engine& engine, GroundOptions options = {});
MeshHandle create_plane(Engine& engine, PlaneOptions options = {});
MeshHandle create_sphere(Engine& engine, SphereOptions options = {});
MeshHandle create_torus(Engine& engine, TorusOptions options = {});
AssetHandle load_gltf(Engine& engine, const std::string& path);
AssetHandle load_babylon(Engine& engine, const std::string& path);
void load_environment(Scene& scene, EnvironmentOptions options);
void load_hdr_environment(Scene& scene, HdrEnvironmentOptions options);
MaterialHandle create_standard_material(Engine& engine);
MaterialHandle create_grid_material(
    Engine& engine,
    GridMaterialOptions options = {});
MaterialHandle create_shader_material(
    Engine& engine,
    ShaderMaterialVariant variant);
void set_shader_center(Engine& engine, MaterialHandle material, Vec2 value);
void set_shader_float(
    Engine& engine,
    MaterialHandle material,
    const std::string& name,
    float value);
void set_shader_vector3(
    Engine& engine,
    MaterialHandle material,
    const std::string& name,
    Color3 value);
void set_alpha_to_coverage(
    Engine& engine,
    MaterialHandle material,
    bool enabled);
SolidTexture create_solid_texture(Engine& engine, float r, float g, float b, float a = 1.0f);
MaterialHandle create_pbr_material(
    Engine& engine,
    PbrMaterialOptions options);
MaterialHandle create_standard_no_color_material_view(
    Engine& engine,
    MaterialHandle source);
MaterialHandle create_pbr_no_color_material_view(
    Engine& engine,
    MaterialHandle source);
void mark_material_ubo_dirty(Engine& engine, MaterialHandle material);
LightHandle create_hemispheric_light(Engine& engine, Vec3 direction, float intensity = 1.0f);
LightHandle create_directional_light(Engine& engine, Vec3 direction, float intensity = 1.0f);
LightHandle create_point_light(Engine& engine, Vec3 position, float intensity = 1.0f);
CameraHandle create_arc_rotate_camera(Engine& engine, float alpha, float beta, float radius, Vec3 target);
CameraHandle create_free_camera(Engine& engine, Vec3 position, Vec3 target);
CameraHandle create_default_camera(Engine& engine, Scene& scene);

RenderTargetHandle create_render_target(
    Engine& engine,
    RenderTargetOptions options);
RenderTargetTexture create_render_target_texture(
    Engine& engine,
    RenderTargetOptions options);
RenderTargetHandle swapchain_render_target(Engine& engine);
TaskHandle create_render_task(
    Engine& engine,
    Scene& scene,
    RenderTaskOptions options);
TaskHandle create_geometry_renderer_task(
    Engine& engine,
    Scene& scene,
    GeometryTaskOptions options);
TaskHandle create_copy_to_texture_task(
    Engine& engine,
    Scene& scene,
    CopyTaskOptions options);
RenderTextureRef render_target_texture(RenderTargetHandle target);
RenderTextureRef geometry_task_texture(
    TaskHandle task,
    GeometryTextureType type);
RenderTextureRef geometry_task_output_texture(TaskHandle task);
void add_task(Scene& scene, TaskHandle task);
void add_task_at_start(Scene& scene, TaskHandle task);
void add_render_task_mesh(
    Engine& engine,
    TaskHandle task,
    MeshHandle mesh,
    MaterialHandle material);

void add_to_scene(Scene& scene, MeshHandle mesh);
void add_to_scene(Scene& scene, LightHandle light);
void add_to_scene(Scene& scene, AssetHandle asset);
void on_before_render(
    Scene& scene,
    std::function<void(float)> callback);
PropertyAnimationManager create_animation_manager();
PropertyAnimationClip create_property_animation_clip(
    std::string name,
    std::vector<PropertyAnimationTrack> tracks,
    float frame_rate);
PropertyAnimationGroup create_property_animation_group(
    PropertyAnimationManager manager,
    MeshHandle target,
    PropertyAnimationClip clip,
    PropertyAnimationGroupOptions options);
void start_animation_manager(
    PropertyAnimationManager manager,
    Scene& scene);
void go_to_frame(
    PropertyAnimationGroup group,
    Engine& engine,
    float frame);
void attach_control(Engine& engine, CameraHandle camera, Scene& scene);
void attach_free_control(Engine& engine, CameraHandle camera, Scene& scene);
void register_scene(Scene& scene);
void enable_scene_transmission(Scene& scene);
void start_engine(Engine& engine);

} // namespace bbl

// SDL implementation of the platform abstraction layer.
#include <bblite/runtime.hpp>
#include <bblite/pal.hpp>
#include <bblite/pal_gpu.hpp>
#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
#include <bblite/pal_image.hpp>
#endif
#if defined(BBLITE_HAS_GLTF) && BBLITE_HAS_GLTF
#include <bblite/pal_gltf.hpp>
#endif
#include <bblite/upstream/camera_controls.hpp>
#include <bblite/upstream/camera_math.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <numeric>
#include <stdexcept>
#include <string>
#include <vector>

#if defined(BBLITE_HAS_SDL) && BBLITE_HAS_SDL
#include <SDL3/SDL.h>
#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
#include <SDL3_image/SDL_image.h>
#endif
#endif

namespace bbl {

#if defined(BBLITE_HAS_SDL) && BBLITE_HAS_SDL
#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
pal::DecodedImage pal::decode_image(const ts::ArrayBuffer& buffer) {
    SDL_IOStream* stream = SDL_IOFromConstMem(buffer.data(), buffer.byte_length());
    if (!stream) throw std::runtime_error(std::string("Unable to open image: ") + SDL_GetError());
    SDL_Surface* source = IMG_Load_IO(stream, true);
    if (!source) throw std::runtime_error(std::string("Unable to decode image: ") + SDL_GetError());
    SDL_Surface* converted = SDL_ConvertSurface(source, SDL_PIXELFORMAT_RGBA32);
    SDL_DestroySurface(source);
    if (!converted) throw std::runtime_error(std::string("Unable to convert image: ") + SDL_GetError());

    pal::DecodedImage result;
    result.width = converted->w;
    result.height = converted->h;
    result.rgba.resize(static_cast<std::size_t>(result.width) * result.height * 4);
    for (int y = 0; y < result.height; ++y) {
        const auto* source_row = static_cast<const std::uint8_t*>(converted->pixels) + y * converted->pitch;
        std::copy_n(
            source_row,
            static_cast<std::size_t>(result.width) * 4,
            result.rgba.data() + static_cast<std::size_t>(y) * result.width * 4);
    }
    SDL_DestroySurface(converted);
    return result;
}
#endif

namespace {

struct Point2 {
    float x = 0.0f;
    float y = 0.0f;
    float depth = 0.0f;
    bool visible = false;
};

struct Projection {
    Vec3 eye{};
    Vec3 forward{};
    Vec3 right{};
    Vec3 up{};
    float focal = 1.0f;
    float near_plane = 0.00001f;
    int width = 1;
    int height = 1;
};

struct CameraPointerState {
    bool orbiting = false;
    bool panning = false;
};

Vec3 add(Vec3 left, Vec3 right) {
    return Vec3{left.x + right.x, left.y + right.y, left.z + right.z};
}

Vec3 subtract(Vec3 left, Vec3 right) {
    return Vec3{left.x - right.x, left.y - right.y, left.z - right.z};
}

Vec3 multiply(Vec3 value, float scalar) {
    return Vec3{value.x * scalar, value.y * scalar, value.z * scalar};
}

float dot(Vec3 left, Vec3 right) {
    return left.x * right.x + left.y * right.y + left.z * right.z;
}

Vec3 cross(Vec3 left, Vec3 right) {
    return Vec3{
        left.y * right.z - left.z * right.y,
        left.z * right.x - left.x * right.z,
        left.x * right.y - left.y * right.x,
    };
}

Vec3 normalize(Vec3 value) {
    const float length = std::sqrt(dot(value, value));
    if (length <= 0.00001f) {
        return Vec3{};
    }
    return multiply(value, 1.0f / length);
}

Projection create_projection(const CameraRecord& camera, int width, int height) {
    Projection projection;
    projection.eye = upstream::arc_rotate_eye_position(camera);
    projection.forward = normalize(subtract(camera.target, projection.eye));
    projection.right = normalize(cross(Vec3{0.0f, 1.0f, 0.0f}, projection.forward));
    projection.up = cross(projection.forward, projection.right);
    projection.focal = static_cast<float>(height) / (2.0f * std::tan(camera.fov * 0.5f));
    projection.near_plane = std::max(camera.near_plane, 0.000001f);
    projection.width = width;
    projection.height = height;
    return projection;
}

Point2 project(Vec3 point, const Projection& projection) {
    const Vec3 relative = subtract(point, projection.eye);
    const float depth = dot(relative, projection.forward);
    if (depth <= projection.near_plane) {
        return {};
    }

    return Point2{
        static_cast<float>(projection.width) * 0.5f + dot(relative, projection.right) * projection.focal / depth,
        static_cast<float>(projection.height) * 0.5f - dot(relative, projection.up) * projection.focal / depth,
        depth,
        true,
    };
}

std::uint8_t color_channel(float value) {
    return static_cast<std::uint8_t>(std::lround(std::clamp(value, 0.0f, 1.0f) * 255.0f));
}

Color3 mesh_color(const Engine& engine, const MeshRecord& mesh) {
    if (mesh.material.value < engine.materials.size()) {
        return engine.materials[mesh.material.value].diffuse_color;
    }
    return Color3{0.75f, 0.78f, 0.82f};
}

void draw_line(SDL_Renderer* renderer, Point2 start, Point2 end) {
    if (start.visible && end.visible) {
        SDL_RenderLine(renderer, start.x, start.y, end.x, end.y);
    }
}

void draw_box(SDL_Renderer* renderer, const MeshRecord& mesh, const Projection& projection) {
    const Vec3 half{
        mesh.dimensions.x * mesh.scaling.x * 0.5f,
        mesh.dimensions.y * mesh.scaling.y * 0.5f,
        mesh.dimensions.z * mesh.scaling.z * 0.5f,
    };
    const std::array<Vec3, 8> local = {
        Vec3{-half.x, -half.y, -half.z},
        Vec3{half.x, -half.y, -half.z},
        Vec3{half.x, half.y, -half.z},
        Vec3{-half.x, half.y, -half.z},
        Vec3{-half.x, -half.y, half.z},
        Vec3{half.x, -half.y, half.z},
        Vec3{half.x, half.y, half.z},
        Vec3{-half.x, half.y, half.z},
    };
    std::array<Point2, 8> points{};
    for (std::size_t index = 0; index < local.size(); ++index) {
        points[index] = project(add(local[index], mesh.position), projection);
    }

    constexpr std::array<std::array<int, 2>, 12> edges = {{
        {{0, 1}}, {{1, 2}}, {{2, 3}}, {{3, 0}},
        {{4, 5}}, {{5, 6}}, {{6, 7}}, {{7, 4}},
        {{0, 4}}, {{1, 5}}, {{2, 6}}, {{3, 7}},
    }};
    for (const auto& edge : edges) {
        draw_line(renderer, points[edge[0]], points[edge[1]]);
    }
}

void draw_ground(SDL_Renderer* renderer, const MeshRecord& mesh, const Projection& projection) {
    const float half_width = mesh.dimensions.x * mesh.scaling.x * 0.5f;
    const float half_height = mesh.dimensions.z * mesh.scaling.z * 0.5f;
    const std::array<Vec3, 4> corners = {
        add(mesh.position, Vec3{-half_width, 0.0f, -half_height}),
        add(mesh.position, Vec3{half_width, 0.0f, -half_height}),
        add(mesh.position, Vec3{half_width, 0.0f, half_height}),
        add(mesh.position, Vec3{-half_width, 0.0f, half_height}),
    };
    std::array<Point2, 4> points{};
    for (std::size_t index = 0; index < corners.size(); ++index) {
        points[index] = project(corners[index], projection);
    }
    for (std::size_t index = 0; index < points.size(); ++index) {
        draw_line(renderer, points[index], points[(index + 1) % points.size()]);
    }
}

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

Vec3 rotate(Vec3 value, Vec4 quaternion) {
    const float length = std::sqrt(
        quaternion.x * quaternion.x +
        quaternion.y * quaternion.y +
        quaternion.z * quaternion.z +
        quaternion.w * quaternion.w);
    if (length <= 0.000001f) return value;
    quaternion.x /= length;
    quaternion.y /= length;
    quaternion.z /= length;
    quaternion.w /= length;
    const Vec3 doubled_cross{
        2.0f * (
            quaternion.y * value.z -
            quaternion.z * value.y),
        2.0f * (
            quaternion.z * value.x -
            quaternion.x * value.z),
        2.0f * (
            quaternion.x * value.y -
            quaternion.y * value.x),
    };
    return Vec3{
        value.x +
            quaternion.w * doubled_cross.x +
            (
                quaternion.y * doubled_cross.z -
                quaternion.z * doubled_cross.y),
        value.y +
            quaternion.w * doubled_cross.y +
            (
                quaternion.z * doubled_cross.x -
                quaternion.x * doubled_cross.z),
        value.z +
            quaternion.w * doubled_cross.z +
            (
                quaternion.x * doubled_cross.y -
                quaternion.y * doubled_cross.x),
    };
}

Vec3 rotate(Vec3 value, const MeshRecord& mesh) {
    return mesh.has_rotation_quaternion
        ? rotate(value, mesh.rotation_quaternion)
        : rotate(value, mesh.rotation);
}

Vec3 transform_position(Vec3 value, const MeshRecord& mesh) {
    value = Vec3{value.x * mesh.scaling.x, value.y * mesh.scaling.y, value.z * mesh.scaling.z};
    return add(rotate(value, mesh), mesh.position);
}

Vec3 transform_normal(Vec3 value, const MeshRecord& mesh) {
    const auto safe_divide = [](float component, float scale) {
        return std::abs(scale) > 0.000001f ? component / scale : component;
    };
    value = Vec3{
        safe_divide(value.x, mesh.scaling.x),
        safe_divide(value.y, mesh.scaling.y),
        safe_divide(value.z, mesh.scaling.z),
    };
    return normalize(rotate(value, mesh));
}

#if defined(BBLITE_HAS_GLTF) && BBLITE_HAS_GLTF
struct MaterialTextures {
    SDL_Texture* base_color = nullptr;
    SDL_Texture* emissive = nullptr;
    SDL_Surface* base_color_surface = nullptr;
    SDL_Surface* metallic_roughness = nullptr;
    SDL_Surface* normal = nullptr;
};

struct PreparedGeometry {
    std::vector<Vec3> normals;
    std::vector<Color3> base_colors;
    std::vector<float> base_luminance;
    std::vector<float> occlusion;
    std::vector<float> roughness;
    std::vector<float> metallic;
};

struct DecodedImage {
    int width = 0;
    int height = 0;
    std::vector<Color3> pixels;
};

struct EnvironmentImages {
    std::vector<DecodedImage> faces;
    DecodedImage brdf_lut;
    std::uint32_t width = 0;
    std::uint32_t mip_count = 0;
};

struct RenderTriangle {
    float depth = 0.0f;
    std::array<SDL_Vertex, 3> vertices{};
    std::array<SDL_Vertex, 3> specular_vertices{};
};

SDL_Surface* load_surface(const TextureData& data) {
    if (data.bytes.empty()) {
        return nullptr;
    }
    pal::DecodedImage image = pal::decode_image(ts::ArrayBuffer(data.bytes));
    SDL_Surface* surface = SDL_CreateSurface(image.width, image.height, SDL_PIXELFORMAT_RGBA32);
    if (!surface) throw std::runtime_error(std::string("Unable to create image surface: ") + SDL_GetError());
    for (int y = 0; y < image.height; ++y) {
        auto* destination = static_cast<std::uint8_t*>(surface->pixels) + y * surface->pitch;
        std::copy_n(
            image.rgba.data() + static_cast<std::size_t>(y) * image.width * 4,
            static_cast<std::size_t>(image.width) * 4,
            destination);
    }
    return surface;
}

SDL_Texture* create_texture(SDL_Renderer* renderer, SDL_Surface* surface, SDL_BlendMode blend_mode) {
    if (!surface) {
        return nullptr;
    }
    SDL_Texture* texture = SDL_CreateTextureFromSurface(renderer, surface);
    if (!texture) {
        throw std::runtime_error(std::string("Unable to upload embedded texture: ") + SDL_GetError());
    }
    if (!SDL_SetTextureScaleMode(texture, SDL_SCALEMODE_LINEAR) || !SDL_SetTextureBlendMode(texture, blend_mode)) {
        const std::string error = SDL_GetError();
        SDL_DestroyTexture(texture);
        throw std::runtime_error("Unable to configure embedded texture: " + error);
    }
    return texture;
}

SDL_Texture* load_texture(SDL_Renderer* renderer, const TextureData& data, SDL_BlendMode blend_mode) {
    SDL_Surface* surface = load_surface(data);
    SDL_Texture* texture = create_texture(renderer, surface, blend_mode);
    if (surface) {
        SDL_DestroySurface(surface);
    }
    return texture;
}

void bake_ambient_occlusion(SDL_Surface* base_color, SDL_Surface* occlusion) {
    if (
        !base_color ||
        !occlusion ||
        base_color->w != occlusion->w ||
        base_color->h != occlusion->h) {
        return;
    }
    const bool lock_base = SDL_MUSTLOCK(base_color);
    const bool lock_occlusion = SDL_MUSTLOCK(occlusion);
    const bool base_locked = !lock_base || SDL_LockSurface(base_color);
    const bool occlusion_locked = !lock_occlusion || SDL_LockSurface(occlusion);
    if (!base_locked || !occlusion_locked) {
        if (base_locked && lock_base) SDL_UnlockSurface(base_color);
        if (occlusion_locked && lock_occlusion) SDL_UnlockSurface(occlusion);
        throw std::runtime_error(std::string("Unable to lock material surfaces: ") + SDL_GetError());
    }

    for (int y = 0; y < base_color->h; ++y) {
        auto* base_row = static_cast<std::uint8_t*>(base_color->pixels) + y * base_color->pitch;
        const auto* occlusion_row = static_cast<const std::uint8_t*>(occlusion->pixels) + y * occlusion->pitch;
        for (int x = 0; x < base_color->w; ++x) {
            std::uint8_t* color = base_row + x * 4;
            const float amount = static_cast<float>(occlusion_row[x * 4]) / 255.0f;
            const float factor = 0.4f + amount * 0.6f;
            color[0] = static_cast<std::uint8_t>(std::lround(static_cast<float>(color[0]) * factor));
            color[1] = static_cast<std::uint8_t>(std::lround(static_cast<float>(color[1]) * factor));
            color[2] = static_cast<std::uint8_t>(std::lround(static_cast<float>(color[2]) * factor));
        }
    }

    if (lock_occlusion) SDL_UnlockSurface(occlusion);
    if (lock_base) SDL_UnlockSurface(base_color);
}

std::vector<MaterialTextures> create_material_textures(SDL_Renderer* renderer, const Engine& engine) {
    std::vector<MaterialTextures> result(engine.materials.size());
    for (std::size_t index = 0; index < engine.materials.size(); ++index) {
        const MaterialRecord& material = engine.materials[index];
        result[index].base_color_surface = load_surface(material.base_color_texture);
        result[index].metallic_roughness = load_surface(material.metallic_roughness_texture);
        result[index].normal = load_surface(material.normal_texture);
        bake_ambient_occlusion(result[index].base_color_surface, result[index].metallic_roughness);
        result[index].base_color = create_texture(renderer, result[index].base_color_surface, SDL_BLENDMODE_BLEND);
        result[index].emissive = load_texture(renderer, material.emissive_texture, SDL_BLENDMODE_ADD);
    }
    return result;
}

void destroy_material_textures(std::vector<MaterialTextures>& materials) {
    for (MaterialTextures& material : materials) {
        if (material.base_color) SDL_DestroyTexture(material.base_color);
        if (material.emissive) SDL_DestroyTexture(material.emissive);
        if (material.base_color_surface) SDL_DestroySurface(material.base_color_surface);
        if (material.metallic_roughness) SDL_DestroySurface(material.metallic_roughness);
        if (material.normal) SDL_DestroySurface(material.normal);
    }
}

DecodedImage decode_rgbd_image(const TextureData& data) {
    SDL_Surface* surface = load_surface(data);
    if (!surface) {
        return {};
    }
    const bool requires_lock = SDL_MUSTLOCK(surface);
    if (requires_lock && !SDL_LockSurface(surface)) {
        const std::string error = SDL_GetError();
        SDL_DestroySurface(surface);
        throw std::runtime_error("Unable to lock RGBD image: " + error);
    }

    DecodedImage result;
    result.width = surface->w;
    result.height = surface->h;
    result.pixels.resize(static_cast<std::size_t>(surface->w) * static_cast<std::size_t>(surface->h));
    for (int y = 0; y < surface->h; ++y) {
        const auto* row = static_cast<const std::uint8_t*>(surface->pixels) + y * surface->pitch;
        for (int x = 0; x < surface->w; ++x) {
            const std::uint8_t* pixel = row + x * 4;
            const float alpha = std::max(static_cast<float>(pixel[3]) / 255.0f, 1.0f / 255.0f);
            result.pixels[static_cast<std::size_t>(y) * surface->w + x] = Color3{
                std::pow(static_cast<float>(pixel[0]) / 255.0f, 2.2f) / alpha,
                std::pow(static_cast<float>(pixel[1]) / 255.0f, 2.2f) / alpha,
                std::pow(static_cast<float>(pixel[2]) / 255.0f, 2.2f) / alpha,
            };
        }
    }

    if (requires_lock) SDL_UnlockSurface(surface);
    SDL_DestroySurface(surface);
    return result;
}

EnvironmentImages create_environment_images(const Scene& scene) {
    EnvironmentImages result;
    result.width = scene.environment.specular_width;
    result.mip_count = scene.environment.specular_mip_count;
    result.faces.reserve(scene.environment.specular_faces.size());
    for (const TextureData& face : scene.environment.specular_faces) {
        DecodedImage image = decode_rgbd_image(face);
        if (image.pixels.empty()) {
            throw std::runtime_error("Environment contains an empty specular face.");
        }
        result.faces.push_back(std::move(image));
    }
    result.brdf_lut = decode_rgbd_image(scene.environment.brdf_lut);
    return result;
}

void destroy_environment_images(EnvironmentImages& environment) {
    environment.faces.clear();
    environment.brdf_lut = {};
}

Color4 sample_surface(SDL_Surface* surface, Vec2 uv, Color4 fallback) {
    if (!surface) {
        return fallback;
    }
    const float wrapped_u = uv.x - std::floor(uv.x);
    const float wrapped_v = uv.y - std::floor(uv.y);
    const int x = std::clamp(static_cast<int>(wrapped_u * static_cast<float>(surface->w)), 0, surface->w - 1);
    const int y = std::clamp(static_cast<int>(wrapped_v * static_cast<float>(surface->h)), 0, surface->h - 1);
    Color4 color;
    if (!SDL_ReadSurfacePixelFloat(surface, x, y, &color.r, &color.g, &color.b, &color.a)) {
        throw std::runtime_error(std::string("Unable to sample embedded texture: ") + SDL_GetError());
    }
    return color;
}

std::vector<PreparedGeometry> prepare_geometries(
    const Engine& engine,
    const std::vector<MaterialTextures>& textures) {
    std::vector<PreparedGeometry> result(engine.geometries.size());
    for (std::size_t geometry_index = 0; geometry_index < engine.geometries.size(); ++geometry_index) {
        const ModelGeometry& geometry = engine.geometries[geometry_index];
        std::uint32_t material_index = invalid_handle;
        for (const MeshRecord& mesh : engine.meshes) {
            if (mesh.primitive == PrimitiveKind::gltf && mesh.geometry == geometry_index) {
                material_index = mesh.material.value;
                break;
            }
        }

        PreparedGeometry& prepared = result[geometry_index];
        prepared.normals.reserve(geometry.vertices.size());
        prepared.base_colors.reserve(geometry.vertices.size());
        prepared.base_luminance.reserve(geometry.vertices.size());
        prepared.occlusion.reserve(geometry.vertices.size());
        prepared.roughness.reserve(geometry.vertices.size());
        prepared.metallic.reserve(geometry.vertices.size());

        const MaterialRecord* material =
            material_index < engine.materials.size() ? &engine.materials[material_index] : nullptr;
        const MaterialTextures* material_textures =
            material_index < textures.size() ? &textures[material_index] : nullptr;

        for (const ModelVertex& vertex : geometry.vertices) {
            Vec3 normal = vertex.normal;
            float roughness = material ? material->roughness_factor : 1.0f;
            float metallic = material ? material->metallic_factor : 0.0f;
            float occlusion = 1.0f;

            if (material_textures) {
                const Color4 base_color = sample_surface(
                    material_textures->base_color_surface,
                    vertex.uv,
                    Color4{1.0f, 1.0f, 1.0f, 1.0f});
                prepared.base_colors.push_back(Color3{base_color.r, base_color.g, base_color.b});
                prepared.base_luminance.push_back(
                    (base_color.r + base_color.g + base_color.b) / 3.0f);

                const Color4 packed = sample_surface(
                    material_textures->metallic_roughness,
                    vertex.uv,
                    Color4{1.0f, 1.0f, 1.0f, 1.0f});
                roughness *= packed.g;
                metallic *= packed.b;
                occlusion = packed.r;

                if (material_textures->normal) {
                    const Color4 sampled = sample_surface(
                        material_textures->normal,
                        vertex.uv,
                        Color4{0.5f, 0.5f, 1.0f, 1.0f});
                    const Vec3 tangent = normalize(Vec3{vertex.tangent.x, vertex.tangent.y, vertex.tangent.z});
                    const Vec3 bitangent = multiply(cross(normal, tangent), vertex.tangent.w);
                    normal = normalize(add(
                        add(multiply(tangent, sampled.r * 2.0f - 1.0f), multiply(bitangent, sampled.g * 2.0f - 1.0f)),
                        multiply(normal, sampled.b * 2.0f - 1.0f)));
                }
            } else {
                prepared.base_colors.push_back(Color3{});
                prepared.base_luminance.push_back(1.0f);
            }

            prepared.normals.push_back(normal);
            prepared.occlusion.push_back(std::clamp(occlusion, 0.0f, 1.0f));
            prepared.roughness.push_back(std::clamp(roughness, 0.04f, 1.0f));
            prepared.metallic.push_back(std::clamp(metallic, 0.0f, 1.0f));
        }
    }
    return result;
}

Color3 add_color(Color3 left, Color3 right) {
    return Color3{left.r + right.r, left.g + right.g, left.b + right.b};
}

Color3 multiply_color(Color3 color, float scalar) {
    return Color3{color.r * scalar, color.g * scalar, color.b * scalar};
}

Color3 multiply_color(Color3 left, Color3 right) {
    return Color3{left.r * right.r, left.g * right.g, left.b * right.b};
}

Color3 mix_color(Color3 left, Color3 right, float amount) {
    return add_color(multiply_color(left, 1.0f - amount), multiply_color(right, amount));
}

Color3 clamp_color(Color3 color, float minimum = 0.0f, float maximum = 1.0f) {
    return Color3{
        std::clamp(color.r, minimum, maximum),
        std::clamp(color.g, minimum, maximum),
        std::clamp(color.b, minimum, maximum),
    };
}

Color3 linearize(Color3 color) {
    return Color3{
        std::pow(std::max(color.r, 0.0f), 2.2f),
        std::pow(std::max(color.g, 0.0f), 2.2f),
        std::pow(std::max(color.b, 0.0f), 2.2f),
    };
}

float display_channel(float value) {
    const float mapped = std::pow(1.0f - std::exp(-std::max(value, 0.0f) * 0.35f), 1.0f / 2.2f);
    return std::clamp(mapped * 0.68f, 0.0f, 0.52f);
}

Color3 display_color(Color3 color) {
    return Color3{
        display_channel(color.r),
        display_channel(color.g),
        display_channel(color.b),
    };
}

Color3 sample_decoded_image(const DecodedImage& image, Vec2 uv) {
    if (image.pixels.empty() || image.width <= 0 || image.height <= 0) {
        return Color3{0.0f, 0.0f, 0.0f};
    }
    const float u = std::clamp(uv.x, 0.0f, 0.999999f);
    const float v = std::clamp(uv.y, 0.0f, 0.999999f);
    const float x = u * static_cast<float>(image.width - 1);
    const float y = v * static_cast<float>(image.height - 1);
    const int x0 = static_cast<int>(std::floor(x));
    const int y0 = static_cast<int>(std::floor(y));
    const int x1 = std::min(x0 + 1, image.width - 1);
    const int y1 = std::min(y0 + 1, image.height - 1);
    const float tx = x - static_cast<float>(x0);
    const float ty = y - static_cast<float>(y0);
    const auto pixel = [&image](int px, int py) -> Color3 {
        return image.pixels[static_cast<std::size_t>(py) * image.width + px];
    };
    const Color3 top = mix_color(pixel(x0, y0), pixel(x1, y0), tx);
    const Color3 bottom = mix_color(pixel(x0, y1), pixel(x1, y1), tx);
    return mix_color(top, bottom, ty);
}

Color3 evaluate_irradiance(const EnvironmentState& environment, Vec3 normal) {
    if (!environment.has_irradiance) {
        return Color3{0.25f, 0.25f, 0.25f};
    }
    const auto& sh = environment.spherical_harmonics;
    Color3 result = sh[0];
    result = add_color(result, multiply_color(sh[1], normal.y));
    result = add_color(result, multiply_color(sh[2], normal.z));
    result = add_color(result, multiply_color(sh[3], normal.x));
    result = add_color(result, multiply_color(sh[4], normal.y * normal.x));
    result = add_color(result, multiply_color(sh[5], normal.y * normal.z));
    result = add_color(result, multiply_color(sh[6], 3.0f * normal.z * normal.z - 1.0f));
    result = add_color(result, multiply_color(sh[7], normal.z * normal.x));
    result = add_color(result, multiply_color(sh[8], normal.x * normal.x - normal.y * normal.y));
    return clamp_color(result, 0.0f, 4.0f);
}

Color3 sample_environment(
    const EnvironmentImages& environment,
    Vec3 direction,
    float roughness) {
    if (environment.faces.empty() || environment.mip_count == 0 || environment.width == 0) {
        return Color3{0.15f, 0.16f, 0.2f};
    }

    direction = normalize(direction);
    const float ax = std::abs(direction.x);
    const float ay = std::abs(direction.y);
    const float az = std::abs(direction.z);
    std::uint32_t face = 0;
    float u = 0.0f;
    float v = 0.0f;

    if (ax >= ay && ax >= az) {
        if (direction.x >= 0.0f) {
            face = 0;
            u = -direction.z / ax;
            v = -direction.y / ax;
        } else {
            face = 1;
            u = direction.z / ax;
            v = -direction.y / ax;
        }
    } else if (ay >= ax && ay >= az) {
        if (direction.y >= 0.0f) {
            face = 2;
            u = direction.x / ay;
            v = direction.z / ay;
        } else {
            face = 3;
            u = direction.x / ay;
            v = -direction.z / ay;
        }
    } else if (direction.z >= 0.0f) {
        face = 4;
        u = direction.x / az;
        v = -direction.y / az;
    } else {
        face = 5;
        u = -direction.x / az;
        v = -direction.y / az;
    }

    const float alpha_g = roughness * roughness;
    const float raw_lod = std::log2(std::max(static_cast<float>(environment.width) * alpha_g, 1.0f)) * 0.8f;
    const std::uint32_t mip = static_cast<std::uint32_t>(std::clamp(
        std::lround(raw_lod),
        0L,
        static_cast<long>(environment.mip_count - 1)));
    const std::size_t image_index = static_cast<std::size_t>(mip) * 6 + face;
    if (image_index >= environment.faces.size()) {
        return Color3{0.15f, 0.16f, 0.2f};
    }

    return sample_decoded_image(
        environment.faces[image_index],
        Vec2{u * 0.5f + 0.5f, 1.0f - (v * 0.5f + 0.5f)});
}

Color3 sample_brdf(const EnvironmentImages& environment, float n_dot_v, float roughness) {
    if (environment.brdf_lut.pixels.empty()) {
        return Color3{0.0f, 0.0f, 0.0f};
    }
    return sample_decoded_image(
        environment.brdf_lut,
        Vec2{std::clamp(n_dot_v, 0.0f, 1.0f), std::clamp(roughness, 0.0f, 1.0f)});
}

Vec3 light_direction(const LightRecord& light) {
    const Vec3 matrix_direction{
        light.local_matrix[8],
        light.local_matrix[9],
        light.local_matrix[10],
    };
    return dot(matrix_direction, matrix_direction) > 0.000001f
        ? normalize(matrix_direction)
        : normalize(light.direction);
}

Color3 diffuse_light_color(
    const Scene& scene,
    const Engine& engine,
    Vec3 normal,
    Color3 base_color,
    float metallic,
    float occlusion) {
    Color3 result = evaluate_irradiance(scene.environment, normal);
    for (const LightHandle handle : scene.lights) {
        if (handle.value >= engine.lights.size()) {
            continue;
        }
        const LightRecord& light = engine.lights[handle.value];
        const float hemisphere = dot(normal, light_direction(light)) * 0.5f + 0.5f;
        result = add_color(
            result,
            multiply_color(
                light.diffuse_color,
                light.intensity * 0.18f * std::clamp(hemisphere, 0.0f, 1.0f)));
    }
    const float brightness = std::max({base_color.r, base_color.g, base_color.b});
    result = multiply_color(
        result,
        (1.0f - metallic * 0.96f) *
            (1.0f - brightness * 0.2f) *
        (0.7f + occlusion * 0.3f));
    return Color3{
        std::pow(std::clamp(result.r, 0.0f, 1.0f), 1.0f / 2.2f),
        std::pow(std::clamp(result.g, 0.0f, 1.0f), 1.0f / 2.2f),
        std::pow(std::clamp(result.b, 0.0f, 1.0f), 1.0f / 2.2f),
    };
}

Color3 specular_light_color(
    const Scene& scene,
    const Engine& engine,
    Vec3 position,
    Vec3 normal,
    Color3 base_color,
    float roughness,
    float metallic,
    float occlusion,
    const Projection& projection,
    const EnvironmentImages& environment) {
    const Vec3 view_direction = normalize(subtract(projection.eye, position));
    const Vec3 incident = multiply(view_direction, -1.0f);
    const Vec3 reflection = subtract(incident, multiply(normal, 2.0f * dot(incident, normal)));
    const float n_dot_v = std::clamp(dot(normal, view_direction), 0.0f, 1.0f);
    const float fresnel_factor = std::pow(1.0f - n_dot_v, 5.0f);
    const Color3 base_linear = linearize(base_color);
    const Color3 f0 = mix_color(Color3{0.04f, 0.04f, 0.04f}, base_linear, metallic);
    const Color3 fresnel = Color3{
        f0.r + (1.0f - f0.r) * fresnel_factor,
        f0.g + (1.0f - f0.g) * fresnel_factor,
        f0.b + (1.0f - f0.b) * fresnel_factor,
    };
    Color3 environment_radiance = sample_environment(environment, reflection, roughness);
    const Color3 irradiance = evaluate_irradiance(scene.environment, normal);
    environment_radiance = mix_color(
        environment_radiance,
        irradiance,
        roughness * roughness);
    const Color3 brdf = sample_brdf(environment, n_dot_v, roughness);
    const Color3 environment_reflectance = !environment.brdf_lut.pixels.empty()
        ? Color3{
              (1.0f - f0.r) * brdf.r + f0.r * brdf.g,
              (1.0f - f0.g) * brdf.r + f0.g * brdf.g,
              (1.0f - f0.b) * brdf.r + f0.b * brdf.g,
          }
        : fresnel;
    Color3 result = multiply_color(environment_radiance, environment_reflectance);
    const float base_luminance = (base_color.r + base_color.g + base_color.b) / 3.0f;
    result = add_color(
        result,
        multiply_color(irradiance, 0.04f + (1.0f - base_luminance) * 0.08f));
    result = multiply_color(result, 0.75f + occlusion * 0.25f);

    const float exponent = 2.0f + (1.0f - roughness) * 126.0f;
    for (const LightHandle handle : scene.lights) {
        if (handle.value >= engine.lights.size()) {
            continue;
        }
        const LightRecord& light = engine.lights[handle.value];
        const Vec3 half_direction = normalize(add(light_direction(light), view_direction));
        const float highlight = std::pow(std::max(dot(normal, half_direction), 0.0f), exponent);
        result = add_color(
            result,
            multiply_color(
                multiply_color(fresnel, light.specular_color),
                highlight * light.intensity * (0.2f + metallic * 0.8f) * (1.0f - roughness * 0.55f)));
    }
    return display_color(result);
}

SDL_Vertex render_vertex(
    const ModelVertex& source,
    Vec3 prepared_normal,
    Color3 base_color,
    float occlusion,
    float roughness,
    float metallic,
    const MeshRecord& mesh,
    const MaterialRecord& material,
    const Scene& scene,
    const Engine& engine,
    const Projection& projection,
    const EnvironmentImages& environment,
    Point2& projected,
    SDL_Vertex& specular_vertex,
    float opacity) {
    const Vec3 position = transform_position(source.position, mesh);
    const Vec3 normal = transform_normal(prepared_normal, mesh);
    projected = project(position, projection);
    const Color3 lighting = diffuse_light_color(scene, engine, normal, base_color, metallic, occlusion);
    const Color3 specular = specular_light_color(
        scene,
        engine,
        position,
        normal,
        base_color,
        roughness,
        metallic,
        occlusion,
        projection,
        environment);
    const SDL_FPoint screen_position{projected.x, projected.y};
    specular_vertex = SDL_Vertex{
        screen_position,
        SDL_FColor{specular.r, specular.g, specular.b, 1.0f},
        SDL_FPoint{},
    };
    return SDL_Vertex{
        screen_position,
        SDL_FColor{
            material.base_color_factor.r * lighting.r,
            material.base_color_factor.g * lighting.g,
            material.base_color_factor.b * lighting.b,
            material.base_color_factor.a * opacity,
        },
        SDL_FPoint{source.uv.x, source.uv.y},
    };
}

void render_models(
    SDL_Renderer* renderer,
    const Scene& scene,
    const Engine& engine,
    const Projection& projection,
    const std::vector<MaterialTextures>& textures,
    const std::vector<PreparedGeometry>& prepared_geometries,
    const EnvironmentImages& environment_images) {
    std::vector<std::vector<RenderTriangle>> batches(engine.materials.size());

    for (const MeshHandle handle : scene.meshes) {
        if (handle.value >= engine.meshes.size()) {
            continue;
        }
        const MeshRecord& mesh = engine.meshes[handle.value];
        if (
            mesh.primitive != PrimitiveKind::gltf ||
            mesh.geometry >= engine.geometries.size() ||
            mesh.material.value >= engine.materials.size()) {
            continue;
        }

        const ModelGeometry& geometry = engine.geometries[mesh.geometry];
        const PreparedGeometry& prepared = prepared_geometries[mesh.geometry];
        const MaterialRecord& material = engine.materials[mesh.material.value];
        auto& triangles = batches[mesh.material.value];
        triangles.reserve(triangles.size() + geometry.indices.size() / 3);

        for (std::size_t index = 0; index + 2 < geometry.indices.size(); index += 3) {
            const std::uint32_t i0 = geometry.indices[index];
            const std::uint32_t i1 = geometry.indices[index + 1];
            const std::uint32_t i2 = geometry.indices[index + 2];
            if (i0 >= geometry.vertices.size() || i1 >= geometry.vertices.size() || i2 >= geometry.vertices.size()) {
                continue;
            }

            Point2 p0;
            Point2 p1;
            Point2 p2;
            RenderTriangle triangle;
            const float height = geometry.bounds_max.y - geometry.bounds_min.y;
            const float normalized_height =
                height > 0.000001f
                    ? (((geometry.vertices[i0].position.y + geometry.vertices[i1].position.y + geometry.vertices[i2].position.y) / 3.0f) -
                       geometry.bounds_min.y) /
                        height
                    : 0.0f;
            const float upward =
                (prepared.normals[i0].y + prepared.normals[i1].y + prepared.normals[i2].y) / 3.0f;
            const float luminance =
                (prepared.base_luminance[i0] + prepared.base_luminance[i1] + prepared.base_luminance[i2]) / 3.0f;
            const float roughness =
                (prepared.roughness[i0] + prepared.roughness[i1] + prepared.roughness[i2]) / 3.0f;
            const bool smoked_glass =
                normalized_height > 0.575f &&
                upward > 0.55f &&
                luminance < 0.16f &&
                roughness < 0.08f;
            const float opacity = smoked_glass ? 0.72f : 1.0f;
            triangle.vertices[0] = render_vertex(
                geometry.vertices[i0],
                prepared.normals[i0],
                prepared.base_colors[i0],
                prepared.occlusion[i0],
                prepared.roughness[i0],
                prepared.metallic[i0],
                mesh,
                material,
                scene,
                engine,
                projection,
                environment_images,
                p0,
                triangle.specular_vertices[0],
                opacity);
            triangle.vertices[1] = render_vertex(
                geometry.vertices[i1],
                prepared.normals[i1],
                prepared.base_colors[i1],
                prepared.occlusion[i1],
                prepared.roughness[i1],
                prepared.metallic[i1],
                mesh,
                material,
                scene,
                engine,
                projection,
                environment_images,
                p1,
                triangle.specular_vertices[1],
                opacity);
            triangle.vertices[2] = render_vertex(
                geometry.vertices[i2],
                prepared.normals[i2],
                prepared.base_colors[i2],
                prepared.occlusion[i2],
                prepared.roughness[i2],
                prepared.metallic[i2],
                mesh,
                material,
                scene,
                engine,
                projection,
                environment_images,
                p2,
                triangle.specular_vertices[2],
                opacity);
            if (!p0.visible || !p1.visible || !p2.visible) {
                continue;
            }
            const float signed_area =
                (p1.x - p0.x) * (p2.y - p0.y) -
                (p1.y - p0.y) * (p2.x - p0.x);
            if (!material.double_sided && signed_area >= 0.0f) {
                continue;
            }
            triangle.depth = (p0.depth + p1.depth + p2.depth) / 3.0f;
            triangles.push_back(triangle);
        }
    }

    for (std::size_t material_index = 0; material_index < batches.size(); ++material_index) {
        auto& triangles = batches[material_index];
        if (triangles.empty()) {
            continue;
        }
        std::sort(
            triangles.begin(),
            triangles.end(),
            [](const RenderTriangle& left, const RenderTriangle& right) { return left.depth > right.depth; });

        std::vector<SDL_Vertex> vertices;
        std::vector<SDL_Vertex> specular_vertices;
        vertices.reserve(triangles.size() * 3);
        specular_vertices.reserve(triangles.size() * 3);
        for (const RenderTriangle& triangle : triangles) {
            vertices.insert(vertices.end(), triangle.vertices.begin(), triangle.vertices.end());
            specular_vertices.insert(
                specular_vertices.end(),
                triangle.specular_vertices.begin(),
                triangle.specular_vertices.end());
        }

        SDL_Texture* base_color = textures[material_index].base_color;
        if (!SDL_RenderGeometry(renderer, base_color, vertices.data(), static_cast<int>(vertices.size()), nullptr, 0)) {
            throw std::runtime_error(std::string("Unable to render glTF geometry: ") + SDL_GetError());
        }

        if (!SDL_SetRenderDrawBlendMode(renderer, SDL_BLENDMODE_ADD)) {
            throw std::runtime_error(std::string("Unable to enable specular blending: ") + SDL_GetError());
        }
        if (!SDL_RenderGeometry(
                renderer,
                nullptr,
                specular_vertices.data(),
                static_cast<int>(specular_vertices.size()),
                nullptr,
                0)) {
            throw std::runtime_error(std::string("Unable to render glTF highlights: ") + SDL_GetError());
        }
        if (!SDL_SetRenderDrawBlendMode(renderer, SDL_BLENDMODE_NONE)) {
            throw std::runtime_error(std::string("Unable to restore opaque blending: ") + SDL_GetError());
        }

        SDL_Texture* emissive = textures[material_index].emissive;
        if (emissive) {
            const Color3 factor = engine.materials[material_index].emissive_factor;
            for (SDL_Vertex& vertex : vertices) {
                vertex.color = SDL_FColor{factor.r * 0.45f, factor.g * 0.45f, factor.b * 0.45f, 1.0f};
            }
            if (!SDL_RenderGeometry(renderer, emissive, vertices.data(), static_cast<int>(vertices.size()), nullptr, 0)) {
                throw std::runtime_error(std::string("Unable to render emissive glTF texture: ") + SDL_GetError());
            }
        }
    }
}
#endif

void update_camera(CameraRecord& camera) {
    if (!camera.controls_enabled) {
        return;
    }
    int key_count = 0;
    const bool* keys = SDL_GetKeyboardState(&key_count);
    const auto pressed = [keys, key_count](SDL_Scancode scancode) {
        const int index = static_cast<int>(scancode);
        return index >= 0 && index < key_count && keys[index];
    };
    if (camera.kind == CameraKind::free) {
        constexpr float nominal_frame_scale = 0.05270463f;
        const float movement = camera.speed * nominal_frame_scale;
        if (pressed(SDL_SCANCODE_W) || pressed(SDL_SCANCODE_UP)) {
            camera.inertial_direction.z += movement;
        }
        if (pressed(SDL_SCANCODE_S) || pressed(SDL_SCANCODE_DOWN)) {
            camera.inertial_direction.z -= movement;
        }
        if (pressed(SDL_SCANCODE_A) || pressed(SDL_SCANCODE_LEFT)) {
            camera.inertial_direction.x -= movement;
        }
        if (pressed(SDL_SCANCODE_D) || pressed(SDL_SCANCODE_RIGHT)) {
            camera.inertial_direction.x += movement;
        }
        if (pressed(SDL_SCANCODE_SPACE) || pressed(SDL_SCANCODE_PAGEUP)) {
            camera.inertial_direction.y += movement;
        }
        if (
            pressed(SDL_SCANCODE_LSHIFT) ||
            pressed(SDL_SCANCODE_RSHIFT) ||
            pressed(SDL_SCANCODE_PAGEDOWN)) {
            camera.inertial_direction.y -= movement;
        }
        upstream::apply_free_camera_inertia(camera);
        return;
    }
    upstream::apply_arc_rotate_inertia(camera);
    if (pressed(SDL_SCANCODE_LEFT)) camera.alpha -= 0.02f;
    if (pressed(SDL_SCANCODE_RIGHT)) camera.alpha += 0.02f;
    if (pressed(SDL_SCANCODE_UP)) camera.beta = std::max(0.1f, camera.beta - 0.02f);
    if (pressed(SDL_SCANCODE_DOWN)) camera.beta = std::min(pi - 0.1f, camera.beta + 0.02f);
    if (pressed(SDL_SCANCODE_W)) camera.radius = std::max(0.25f, camera.radius - 0.08f);
    if (pressed(SDL_SCANCODE_S)) camera.radius += 0.08f;
}

void handle_camera_pointer_event(
    const SDL_Event& event,
    CameraRecord& camera,
    CameraPointerState& state) {
    if (!camera.controls_enabled) {
        return;
    }

    if (event.type == SDL_EVENT_MOUSE_BUTTON_DOWN || event.type == SDL_EVENT_MOUSE_BUTTON_UP) {
        const bool pressed = event.type == SDL_EVENT_MOUSE_BUTTON_DOWN;
        if (event.button.button == SDL_BUTTON_LEFT) {
            state.orbiting = pressed;
        } else if (event.button.button == SDL_BUTTON_RIGHT || event.button.button == SDL_BUTTON_MIDDLE) {
            state.panning = pressed;
        }
        return;
    }

    if (event.type == SDL_EVENT_MOUSE_MOTION) {
        if (camera.kind == CameraKind::free) {
            if (state.orbiting) {
                camera.inertial_yaw_offset +=
                    event.motion.xrel / camera.angular_sensibility;
                camera.inertial_pitch_offset -=
                    event.motion.yrel / camera.angular_sensibility;
            }
            return;
        }
        if (state.orbiting) {
            camera.inertial_alpha_offset -= event.motion.xrel / camera.angular_sensibility;
            camera.inertial_beta_offset -= event.motion.yrel / camera.angular_sensibility;
        }
        if (state.panning) {
            camera.inertial_panning_x += -event.motion.xrel / camera.panning_sensibility;
            camera.inertial_panning_y += event.motion.yrel / camera.panning_sensibility;
        }
        return;
    }

    if (event.type == SDL_EVENT_MOUSE_WHEEL) {
        float delta = event.wheel.y;
        if (event.wheel.direction == SDL_MOUSEWHEEL_FLIPPED) {
            delta = -delta;
        }
        camera.inertial_radius_offset -=
            (delta * camera.radius) / std::max(camera.wheel_precision * 10.0f, 1.0f);
    }
}

long configured_frames(const char* name) {
    const std::string value = pal::environment_variable(name);
    return value.empty() ? 0 : std::strtol(value.c_str(), nullptr, 10);
}

void print_benchmark(const char* renderer_name, std::vector<double> samples) {
    if (samples.empty()) {
        return;
    }
    std::sort(samples.begin(), samples.end());
    const double average =
        std::accumulate(samples.begin(), samples.end(), 0.0) /
        static_cast<double>(samples.size());
    const double median = samples[samples.size() / 2];
    const std::size_t p95_index =
        std::min(samples.size() - 1, static_cast<std::size_t>(std::ceil(samples.size() * 0.95)) - 1);

    std::cout
        << std::fixed
        << std::setprecision(3)
        << "Babylon Lite native benchmark"
        << " | renderer=" << (renderer_name ? renderer_name : "unknown")
        << " | frames=" << samples.size()
        << " | average=" << average << " ms"
        << " | median=" << median << " ms"
        << " | p95=" << samples[p95_index] << " ms"
        << " | min=" << samples.front() << " ms"
        << " | max=" << samples.back() << " ms\n";
}

} // namespace
#endif

void pal::run_engine(Engine& engine) {
    const std::string gpu_backend =
        pal::environment_variable("BBLITE_GPU_BACKEND");
    if (gpu_backend == "dawn") {
        if (pal::run_dawn_engine(engine)) {
            return;
        }
        throw std::runtime_error(
            "BBLITE_GPU_BACKEND=dawn requires a Dawn-enabled native build (BBLITE_DAWN=ON).");
    }
    try {
        if (pal::run_gpu_engine(engine)) {
            return;
        }
    } catch (const std::exception& error) {
        const std::string required = pal::environment_variable("BBLITE_GPU_REQUIRED");
        if (required == "1" || required == "true") {
            throw;
        }
        std::cerr
            << "SDL_GPU unavailable (" << error.what()
            << "); falling back to SDL_Renderer.\n";
    }
    if (engine.registered_scenes.empty() || !engine.registered_scenes.front()) {
        throw std::runtime_error("startEngine requires a registered scene.");
    }

    Scene& scene = *engine.registered_scenes.front();
    const std::string animation_seek =
        pal::environment_variable(
            "BBLITE_ANIMATION_SEEK_SECONDS");
    if (!animation_seek.empty()) {
        const float time =
            std::strtof(animation_seek.c_str(), nullptr);
        for (const auto& seek : scene.animation_seekers) {
            seek(time);
        }
    }

#if defined(BBLITE_HAS_SDL) && BBLITE_HAS_SDL
    if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS)) {
        throw std::runtime_error(std::string("SDL_Init failed: ") + SDL_GetError());
    }

    SDL_Window* window = nullptr;
    SDL_Renderer* renderer = nullptr;
    const bool hidden_test_pass =
        pal::environment_variable("BBLITE_TEST_PASS") == "1";
    if (!SDL_CreateWindowAndRenderer(
            engine.options.title.c_str(),
            engine.options.width,
            engine.options.height,
            hidden_test_pass
                ? SDL_WINDOW_RESIZABLE |
                    SDL_WINDOW_NOT_FOCUSABLE
                : SDL_WINDOW_RESIZABLE,
            &window,
            &renderer)) {
        const std::string error = SDL_GetError();
        SDL_Quit();
        throw std::runtime_error("SDL_CreateWindowAndRenderer failed: " + error);
    }
    const long benchmark_frame_count = configured_frames("BBLITE_BENCHMARK_FRAMES");
    const bool benchmarking = benchmark_frame_count > 0;
    if (benchmarking && !SDL_SetRenderVSync(renderer, 0)) {
        const std::string error = SDL_GetError();
        SDL_DestroyRenderer(renderer);
        SDL_DestroyWindow(window);
        SDL_Quit();
        throw std::runtime_error("Unable to disable vsync for benchmark: " + error);
    }

    CameraRecord fallback_camera;
    CameraRecord* camera =
        scene.camera.value < engine.cameras.size() ? &engine.cameras[scene.camera.value] : &fallback_camera;
    CameraPointerState pointer_state;
#if defined(BBLITE_HAS_GLTF) && BBLITE_HAS_GLTF
    std::vector<MaterialTextures> material_textures = create_material_textures(renderer, engine);
    std::vector<PreparedGeometry> prepared_geometries = prepare_geometries(engine, material_textures);
    EnvironmentImages environment_images = create_environment_images(scene);
#endif
    const long warmup_frames = benchmarking ? std::min(120L, std::max(10L, benchmark_frame_count / 10)) : 0;
    const long frame_limit =
        benchmarking
            ? warmup_frames + benchmark_frame_count
            : configured_frames("BBLITE_MAX_FRAMES");
    const std::string screenshot_path = pal::environment_variable("BBLITE_SCREENSHOT");
    const long screenshot_frame =
        configured_frames("BBLITE_SCREENSHOT_FRAME");
    std::vector<double> benchmark_samples;
    benchmark_samples.reserve(static_cast<std::size_t>(std::max(benchmark_frame_count, 0L)));
    bool screenshot_saved = false;
    long frame_count = 0;
    bool running = true;
    double previous_frame_time = 0.0;

    while (running && (frame_limit <= 0 || frame_count < frame_limit)) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_EVENT_QUIT) {
                running = false;
            }
            if (!hidden_test_pass) {
                handle_camera_pointer_event(
                    event,
                    *camera,
                    pointer_state);
            }
        }

        const double frame_start = pal::monotonic_milliseconds();
        const float real_delta_ms =
            previous_frame_time > 0.0
                ? static_cast<float>(frame_start - previous_frame_time)
                : 0.0f;
        previous_frame_time = frame_start;
        const float delta_ms =
            scene.fixed_delta_ms > 0.0f
                ? scene.fixed_delta_ms
                : real_delta_ms;
        for (const auto& callback : scene.before_render) {
            callback(delta_ms);
        }
        update_camera(*camera);

        int width = engine.options.width;
        int height = engine.options.height;
        SDL_GetRenderOutputSize(renderer, &width, &height);
        const Projection projection = create_projection(*camera, width, height);
        SDL_SetRenderDrawColor(
            renderer,
            color_channel(scene.clear_color.r),
            color_channel(scene.clear_color.g),
            color_channel(scene.clear_color.b),
            color_channel(scene.clear_color.a));
        SDL_RenderClear(renderer);

#if defined(BBLITE_HAS_GLTF) && BBLITE_HAS_GLTF
        render_models(
            renderer,
            scene,
            engine,
            projection,
            material_textures,
            prepared_geometries,
            environment_images);
#endif

        for (const MeshHandle handle : scene.meshes) {
            if (handle.value >= engine.meshes.size()) {
                continue;
            }
            const MeshRecord& mesh = engine.meshes[handle.value];
            if (mesh.primitive == PrimitiveKind::gltf) {
                continue;
            }
            const Color3 color = mesh_color(engine, mesh);
            SDL_SetRenderDrawColor(renderer, color_channel(color.r), color_channel(color.g), color_channel(color.b), 255);
            if (mesh.primitive == PrimitiveKind::ground) {
                draw_ground(renderer, mesh, projection);
            } else {
                draw_box(renderer, mesh, projection);
            }
        }

        if (
            !screenshot_saved &&
            !screenshot_path.empty() &&
            frame_count >= screenshot_frame) {
            SDL_Surface* screenshot = SDL_RenderReadPixels(renderer, nullptr);
            if (!screenshot) {
                throw std::runtime_error(std::string("Unable to read screenshot pixels: ") + SDL_GetError());
            }
#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
            const bool saved = IMG_SavePNG(screenshot, screenshot_path.c_str());
#else
            const bool saved = SDL_SaveBMP(screenshot, screenshot_path.c_str());
#endif
            SDL_DestroySurface(screenshot);
            if (!saved) {
                throw std::runtime_error(std::string("Unable to save screenshot: ") + SDL_GetError());
            }
            screenshot_saved = true;
        }

        if (!SDL_RenderPresent(renderer)) {
            throw std::runtime_error(std::string("Unable to present frame: ") + SDL_GetError());
        }
        if (benchmarking && frame_count >= warmup_frames) {
            benchmark_samples.push_back(pal::monotonic_milliseconds() - frame_start);
        }
        if (!benchmarking) {
            SDL_Delay(1);
        }
        ++frame_count;
    }

    if (benchmarking) {
        print_benchmark(SDL_GetRendererName(renderer), std::move(benchmark_samples));
    }

#if defined(BBLITE_HAS_GLTF) && BBLITE_HAS_GLTF
    destroy_environment_images(environment_images);
    destroy_material_textures(material_textures);
#endif
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
#else
    std::cout << "Babylon Lite native headless scene: "
              << scene.meshes.size() << " meshes, "
              << scene.lights.size() << " lights, "
              << engine.materials.size() << " materials.\n";
#endif
}

} // namespace bbl

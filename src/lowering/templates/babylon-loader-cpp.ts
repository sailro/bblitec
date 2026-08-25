/**
 * The generated `.babylon` loader.
 *
 * `lightMeshLists` mirrors what the asset declares: a light carries
 * `includedOnlyMeshesIds` or `excludedMeshesIds` naming the meshes it lights,
 * which the pinned engine keeps as a per-mesh light set. A file whose lights
 * name neither emits this loader without the resolution.
 */
export function babylonLoaderCpp(
    provenance: string,
    cameraDerivation: string,
    lightMeshLists = false,
    diffuseUv2 = false,
    bumpTexture = false,
): string {
    return `// ${provenance}
#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace bbl {
namespace {

using Json = nlohmann::json;

float number_at(const Json& values, std::size_t index, float fallback) {
    return values.is_array() && index < values.size() && values[index].is_number()
        ? values[index].get<float>()
        : fallback;
}

// The camera derivation's reads: the pinned parseBabylonCamera consumes the
// JSON values as JavaScript numbers, so these stay double up to the record's
// own stores instead of round-tripping through a float lane.
double double_at(
    const Json& object,
    const char* name,
    std::size_t index,
    double fallback) {
    const auto values = object.find(name);
    return values != object.end() &&
            values->is_array() &&
            index < values->size() &&
            (*values)[index].is_number()
        ? (*values)[index].get<double>()
        : fallback;
}

// A .babylon export commonly writes an unused optional field as JSON null
// rather than omitting it -- Sponza writes every unset id, texture slot and
// parent that way -- so reading one has to treat null as absent instead of
// asking nlohmann to convert it.
std::string string_or(
    const Json& object,
    const char* name,
    std::string fallback = std::string{}) {
    const auto found = object.find(name);
    return found != object.end() && found->is_string()
        ? found->get<std::string>()
        : fallback;
}

Vec3 vec3_or(const Json& object, const char* name, Vec3 fallback) {
    const auto found = object.find(name);
    if (found == object.end()) return fallback;
    return Vec3{
        number_at(*found, 0, fallback.x),
        number_at(*found, 1, fallback.y),
        number_at(*found, 2, fallback.z),
    };
}

Color3 color3_or(const Json& object, const char* name, Color3 fallback) {
    const Vec3 value = vec3_or(
        object,
        name,
        Vec3{fallback.r, fallback.g, fallback.b});
    return Color3{value.x, value.y, value.z};
}

TextureAddressMode address_mode(const Json& texture, const char* name) {
    const int value = texture.value(name, 1);
    return value == 0
        ? TextureAddressMode::clamp
        : value == 2
            ? TextureAddressMode::mirror
            : TextureAddressMode::repeat;
}

TextureData texture_data(
    const Json& material,
    const char* name,
    const std::string& base_path) {
    const auto found = material.find(name);
    if (
        found == material.end() ||
        !found->is_object() ||
        found->value("isCube", false)) {
        return {};
    }
    const std::string relative = found->value("name", std::string{});
    if (relative.empty()) return {};
    TextureData result;
    result.bytes = pal::read_binary_file(pal::join_path(base_path, relative));
    result.sampler.address_u = address_mode(*found, "wrapU");
    result.sampler.address_v = address_mode(*found, "wrapV");
    result.sampler.max_anisotropy = 4.0f;
    result.invert_y = true;
    return result;
}

std::array<float, 16> matrix_or_identity(
    const Json& object,
    const char* name) {
    std::array<float, 16> result{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    };
    const auto found = object.find(name);
    if (found == object.end() || !found->is_array()) return result;
    for (std::size_t index = 0;
         index < result.size() && index < found->size();
         ++index) {
        if ((*found)[index].is_number()) {
            result[index] = (*found)[index].get<float>();
        }
    }
    return result;
}

Vec3 transform_point(const std::array<float, 16>& matrix, Vec3 value) {
    return Vec3{
        value.x * matrix[0] + value.y * matrix[4] +
            value.z * matrix[8] + matrix[12],
        value.x * matrix[1] + value.y * matrix[5] +
            value.z * matrix[9] + matrix[13],
        value.x * matrix[2] + value.y * matrix[6] +
            value.z * matrix[10] + matrix[14],
    };
}

Vec3 transform_direction(
    const std::array<float, 16>& matrix,
    Vec3 value) {
    return Vec3{
        value.x * matrix[0] + value.y * matrix[4] + value.z * matrix[8],
        value.x * matrix[1] + value.y * matrix[5] + value.z * matrix[9],
        value.x * matrix[2] + value.y * matrix[6] + value.z * matrix[10],
    };
}

Vec3 rotate(Vec3 value, Vec3 rotation) {
    const float sine_x = std::sin(rotation.x);
    const float cosine_x = std::cos(rotation.x);
    const float sine_y = std::sin(rotation.y);
    const float cosine_y = std::cos(rotation.y);
    const float sine_z = std::sin(rotation.z);
    const float cosine_z = std::cos(rotation.z);
    value = Vec3{
        value.x,
        value.y * cosine_x - value.z * sine_x,
        value.y * sine_x + value.z * cosine_x,
    };
    value = Vec3{
        value.x * cosine_y + value.z * sine_y,
        value.y,
        -value.x * sine_y + value.z * cosine_y,
    };
    return Vec3{
        value.x * cosine_z - value.y * sine_z,
        value.x * sine_z + value.y * cosine_z,
        value.z,
    };
}

Vec3 normalize(Vec3 value) {
    const float length = std::sqrt(
        value.x * value.x + value.y * value.y + value.z * value.z);
    return length > 0.000001f
        ? Vec3{value.x / length, value.y / length, value.z / length}
        : Vec3{0.0f, 1.0f, 0.0f};
}

Vec3 transform_mesh_point(
    Vec3 value,
    Vec3 position,
    Vec3 rotation,
    Vec3 scaling) {
    value = Vec3{
        value.x * scaling.x,
        value.y * scaling.y,
        value.z * scaling.z,
    };
    value = rotate(value, rotation);
    return Vec3{
        value.x + position.x,
        value.y + position.y,
        value.z + position.z,
    };
}

Vec3 transform_mesh_direction(
    Vec3 value,
    Vec3 rotation,
    Vec3 scaling) {
    value = Vec3{
        value.x * scaling.x,
        value.y * scaling.y,
        value.z * scaling.z,
    };
    return normalize(rotate(value, rotation));
}

MaterialHandle load_material(
    Engine& engine,
    const Json& source,
    const std::string& base_path,
    const Color3& scene_ambient,
    std::unordered_map<std::string, std::uint32_t>& reflection_cubes) {
    MaterialRecord material;
    material.standard_material = true;
    material.diffuse_color =
        color3_or(source, "diffuse", Color3{1.0f, 1.0f, 1.0f});
    material.specular_color =
        color3_or(source, "specular", Color3{1.0f, 1.0f, 1.0f});
    material.emissive_factor =
        color3_or(source, "emissive", Color3{0.0f, 0.0f, 0.0f});
    // BJS multiplies material.ambient by scene.ambientColor.
    const Color3 raw_ambient =
        color3_or(source, "ambient", Color3{0.0f, 0.0f, 0.0f});
    material.ambient_color = Color3{
        raw_ambient.r * scene_ambient.r,
        raw_ambient.g * scene_ambient.g,
        raw_ambient.b * scene_ambient.b,
    };
    material.specular_power = source.value("specularPower", 64.0f);
    const float alpha = source.value("alpha", 1.0f);
    material.base_color_factor = Color4{
        material.diffuse_color.r,
        material.diffuse_color.g,
        material.diffuse_color.b,
        alpha,
    };
    material.alpha_cutoff = source.value("alphaCutOff", 0.0f);
    material.double_sided = !source.value("backFaceCulling", true);
    material.base_color_texture =
        texture_data(source, "diffuseTexture", base_path);
    material.specular_texture =
        texture_data(source, "specularTexture", base_path);
    material.opacity_texture =
        texture_data(source, "opacityTexture", base_path);
    material.ambient_texture =
        texture_data(source, "ambientTexture", base_path);
    if (const auto texture = source.find("reflectionTexture");
        texture != source.end() &&
        texture->is_object() &&
        texture->value("isCube", false)) {
        const std::string cube_name =
            texture->value("name", std::string{});
        if (!cube_name.empty()) {
            const auto existing = reflection_cubes.find(cube_name);
            if (existing != reflection_cubes.end()) {
                material.reflection_cube = existing->second;
            } else {
                constexpr std::array<const char*, 6> suffixes{
                    "_px.jpg",
                    "_nx.jpg",
                    "_py.jpg",
                    "_ny.jpg",
                    "_pz.jpg",
                    "_nz.jpg",
                };
                std::array<TextureData, 6> faces;
                for (std::size_t index = 0;
                     index < faces.size();
                     ++index) {
                    faces[index].bytes = pal::read_binary_file(
                        pal::join_path(
                            base_path,
                            cube_name + suffixes[index]));
                }
                engine.reflection_cubes.push_back(std::move(faces));
                material.reflection_cube =
                    static_cast<std::uint32_t>(
                        engine.reflection_cubes.size() - 1);
                reflection_cubes.emplace(
                    cube_name,
                    material.reflection_cube);
            }
            material.reflection_level =
                texture->value("level", 1.0f);
        }
    }
    // The non-cube arm of the same slot, exactly the pin's TEX_SLOTS
    // reflection entry (load-babylon.ts: \`skipIf: (t) => t.isCube === true\`,
    // \`level\` -> reflectionLevel, \`coordinatesMode === 2\` ->
    // reflectionCoordMode = 2 over the createStandardMaterial default 1).
    // texture_data() applies the same cube drop, so the record's
    // reflection_texture carries bytes only for a 2D reflection.
    if (const auto texture = source.find("reflectionTexture");
        texture != source.end() &&
        texture->is_object() &&
        !texture->value("isCube", false)) {
        material.reflection_texture =
            texture_data(source, "reflectionTexture", base_path);
        material.reflection_level = texture->value("level", 1.0f);
        if (texture->value("coordinatesMode", 0) == 2) {
            material.reflection_coord_mode = 2.0f;
        }
    }
    if (const auto texture = source.find("diffuseTexture");
        texture != source.end() && texture->is_object()) {
        material.diffuse_level = texture->value("level", 1.0f);
        material.diffuse_u_scale = texture->value("uScale", 1.0f);
        material.diffuse_v_scale = texture->value("vScale", 1.0f);${diffuseUv2 ? `
        // A diffuse texture selects a UV set the same way the specular and
        // ambient slots below do. Sponza's upper walls are the reached case:
        // their base texture is authored against the second set.
        material.diffuse_coord_index =
            texture->value("coordinatesIndex", 0) == 1 ? 1u : 0u;` : ""}
        if (texture->value("hasAlpha", false)) {
            material.alpha_cutoff = 0.4f;
        }
    }
    if (const auto texture = source.find("specularTexture");
        texture != source.end() && texture->is_object()) {
        material.specular_coord_index =
            texture->value("coordinatesIndex", 0) == 1 ? 1u : 0u;
    }
    if (const auto texture = source.find("opacityTexture");
        texture != source.end() && texture->is_object()) {
        material.opacity_level = texture->value("level", 1.0f);
        // The pin's own conditional write (load-babylon.ts TEX_SLOTS
        // opacity extra: \`if (t.getAlphaFromRGB) m.opacityFromRGB = true\`),
        // which _computeStandardMaterialFeatures turns into
        // OPACITY_FROM_RGB and the composed fragment into the
        // dot(opSample.rgb, ...) luminance arm.
        material.opacity_from_rgb =
            texture->value("getAlphaFromRGB", false);
    }
${bumpTexture ? `    if (const auto texture = source.find("bumpTexture");
        texture != source.end() && texture->is_object()) {
        material.bump_texture =
            texture_data(source, "bumpTexture", base_path);
        // The authored level, one-to-one like the slots above. The pinned
        // writeStdMaterialData derives its bumpScale = 1 / level itself, so
        // the record carries what the pin's own material property carries.
        material.bump_scale = texture->value("level", 1.0f);
    }
` : ""}    if (const auto texture = source.find("ambientTexture");
        texture != source.end() && texture->is_object()) {
        material.ambient_level = texture->value("level", 1.0f);
        material.ambient_coord_index =
            texture->value("coordinatesIndex", 0) == 1 ? 1u : 0u;
    }
    material.alpha_mode =
        alpha < 1.0f || material.opacity_texture.has_image()
            ? MaterialAlphaMode::blend
            : MaterialAlphaMode::opaque;
    engine.materials.push_back(std::move(material));
    return MaterialHandle{
        static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

MaterialHandle default_material(Engine& engine) {
    MaterialRecord material;
    material.standard_material = true;
    material.diffuse_color = Color3{1.0f, 1.0f, 1.0f};
    engine.materials.push_back(std::move(material));
    return MaterialHandle{
        static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

struct SubMesh {
    std::size_t material_index = 0;
    std::size_t index_start = 0;
    std::size_t index_count = 0;
};

} // namespace

AssetHandle load_babylon(Engine& engine, const std::string& path) {
    const std::vector<std::uint8_t> bytes = pal::read_binary_file(path);
    const Json document = Json::parse(std::string(
        reinterpret_cast<const char*>(bytes.data()),
        bytes.size()));
    const std::string base_path = pal::parent_path(path);

    std::unordered_map<std::string, MaterialHandle> materials;
    std::unordered_map<std::string, std::uint32_t> reflection_cubes;
    const Color3 scene_ambient =
        color3_or(document, "ambientColor", Color3{0.0f, 0.0f, 0.0f});
    if (const auto values = document.find("materials");
        values != document.end() && values->is_array()) {
        for (const Json& value : *values) {
            if (!value.is_object()) continue;
            const std::string id = string_or(value, "id");
            if (!id.empty()) {
                materials.emplace(
                    id,
                    load_material(
                        engine,
                        value,
                        base_path,
                        scene_ambient,
                        reflection_cubes));
            }
        }
    }

    std::unordered_map<std::string, std::vector<std::string>>
        multi_materials;
    if (const auto values = document.find("multiMaterials");
        values != document.end() && values->is_array()) {
        for (const Json& value : *values) {
            if (!value.is_object()) continue;
            const std::string id = string_or(value, "id");
            if (id.empty()) continue;
            std::vector<std::string> entries;
            if (const auto source = value.find("materials");
                source != value.end() && source->is_array()) {
                entries.reserve(source->size());
                for (const Json& material : *source) {
                    entries.push_back(
                        material.is_string()
                            ? material.get<std::string>()
                            : std::string{});
                }
            }
            multi_materials.emplace(id, std::move(entries));
        }
    }

    AssetRecord asset;
    MaterialHandle fallback{};
    const auto fallback_material = [&]() {
        if (fallback.value == invalid_handle) {
            fallback = default_material(engine);
        }
        return fallback;
    };

${lightMeshLists ? `    // A light names the meshes it lights, or the ones it skips, by mesh id.
    // Resolving those against the records this loader creates needs the id
    // of each one, and a node with submeshes becomes several records.
    std::unordered_map<std::string, std::vector<std::uint32_t>>
        mesh_records_by_id;
` : ""}    if (const auto meshes = document.find("meshes");
        meshes != document.end() && meshes->is_array()) {
        for (const Json& source : *meshes) {
            if (
                !source.is_object() ||
                !source.value("isVisible", true) ||
                !string_or(source, "parentId").empty()) {
                continue;
            }
            const auto positions_it = source.find("positions");
            const auto normals_it = source.find("normals");
            const auto indices_it = source.find("indices");
            if (
                positions_it == source.end() ||
                normals_it == source.end() ||
                indices_it == source.end() ||
                !positions_it->is_array() ||
                !normals_it->is_array() ||
                !indices_it->is_array() ||
                indices_it->empty()) {
                continue;
            }
            const Json& positions = *positions_it;
            const Json& normals = *normals_it;
            const Json* uvs = nullptr;
            const Json* uvs2 = nullptr;
            if (const auto found = source.find("uvs");
                found != source.end() && found->is_array()) {
                uvs = &*found;
            }
            if (const auto found = source.find("uvs2");
                found != source.end() && found->is_array()) {
                uvs2 = &*found;
            }
            const std::size_t vertex_count = positions.size() / 3;
            const Vec3 mesh_position =
                vec3_or(source, "position", Vec3{});
            const Vec3 mesh_rotation =
                vec3_or(source, "rotation", Vec3{});
            const Vec3 mesh_scaling =
                vec3_or(source, "scaling", Vec3{1.0f, 1.0f, 1.0f});
            const std::array<float, 16> local_matrix =
                matrix_or_identity(source, "localMatrix");

            std::vector<SubMesh> submeshes;
            if (const auto values = source.find("subMeshes");
                values != source.end() && values->is_array()) {
                submeshes.reserve(values->size());
                for (const Json& value : *values) {
                    if (!value.is_object()) continue;
                    submeshes.push_back(SubMesh{
                        value.value("materialIndex", 0u),
                        value.value("indexStart", 0u),
                        value.value("indexCount", 0u),
                    });
                }
            }
            if (submeshes.empty()) {
                submeshes.push_back(SubMesh{
                    0,
                    0,
                    indices_it->size(),
                });
            }

            const std::string material_id =
                string_or(source, "materialId");
            const auto multi = multi_materials.find(material_id);
            for (const SubMesh& submesh : submeshes) {
                if (
                    submesh.index_count == 0 ||
                    submesh.index_start + submesh.index_count >
                        indices_it->size()) {
                    continue;
                }
                ModelGeometry geometry;
                geometry.vertices.resize(vertex_count);
                geometry.bounds_min = Vec3{
                    std::numeric_limits<float>::max(),
                    std::numeric_limits<float>::max(),
                    std::numeric_limits<float>::max(),
                };
                geometry.bounds_max = Vec3{
                    std::numeric_limits<float>::lowest(),
                    std::numeric_limits<float>::lowest(),
                    std::numeric_limits<float>::lowest(),
                };
                for (std::size_t index = 0;
                     index < vertex_count;
                     ++index) {
                    const Vec3 source_position{
                        number_at(positions, index * 3, 0.0f),
                        number_at(positions, index * 3 + 1, 0.0f),
                        number_at(positions, index * 3 + 2, 0.0f),
                    };
                    const Vec3 local_position =
                        transform_point(local_matrix, source_position);
                    const Vec3 source_normal{
                        number_at(normals, index * 3, 0.0f),
                        number_at(normals, index * 3 + 1, 1.0f),
                        number_at(normals, index * 3 + 2, 0.0f),
                    };
                    ModelVertex vertex;
                    vertex.local_position = local_position;
                    vertex.position = transform_mesh_point(
                        local_position,
                        mesh_position,
                        mesh_rotation,
                        mesh_scaling);
                    vertex.normal = transform_mesh_direction(
                        transform_direction(local_matrix, source_normal),
                        mesh_rotation,
                        mesh_scaling);
                    if (uvs) {
                        vertex.uv = Vec2{
                            number_at(*uvs, index * 2, 0.0f),
                            number_at(*uvs, index * 2 + 1, 0.0f),
                        };
                    }
                    if (uvs2) {
                        vertex.uv2 = Vec2{
                            number_at(*uvs2, index * 2, 0.0f),
                            number_at(*uvs2, index * 2 + 1, 0.0f),
                        };
                    }
                    geometry.bounds_min.x =
                        std::min(geometry.bounds_min.x, vertex.position.x);
                    geometry.bounds_min.y =
                        std::min(geometry.bounds_min.y, vertex.position.y);
                    geometry.bounds_min.z =
                        std::min(geometry.bounds_min.z, vertex.position.z);
                    geometry.bounds_max.x =
                        std::max(geometry.bounds_max.x, vertex.position.x);
                    geometry.bounds_max.y =
                        std::max(geometry.bounds_max.y, vertex.position.y);
                    geometry.bounds_max.z =
                        std::max(geometry.bounds_max.z, vertex.position.z);
                    geometry.vertices[index] = vertex;
                }
                geometry.indices.reserve(submesh.index_count);
                for (std::size_t index = 0;
                     index < submesh.index_count;
                     ++index) {
                    const Json& value =
                        (*indices_it)[submesh.index_start + index];
                    geometry.indices.push_back(
                        value.is_number_unsigned()
                            ? value.get<std::uint32_t>()
                            : static_cast<std::uint32_t>(
                                  value.get<double>()));
                }
                if (geometry.indices.size() % 3 != 0) {
                    throw std::runtime_error(
                        ".babylon triangle indices must be divisible by three.");
                }
                engine.geometries.push_back(std::move(geometry));

                MaterialHandle material = fallback_material();
                std::string selected_id = material_id;
                if (
                    multi != multi_materials.end() &&
                    submesh.material_index < multi->second.size()) {
                    selected_id = multi->second[submesh.material_index];
                }
                if (const auto found = materials.find(selected_id);
                    found != materials.end()) {
                    material = found->second;
                }
                MeshRecord mesh;
                mesh.primitive = PrimitiveKind::babylon;
                // The pin's mesh.world keeps this node's TRS — its position
                // attribute carries only localMatrix-applied vertices,
                // measured bit-exact against the browser's uploads — while
                // this loader bakes the same TRS into vertex.position and
                // leaves the record transform the identity. A LOCAL_POSITION
                // geometry variant binds the unbaked local lanes, so its
                // draw needs the pin's world back: record it the way the
                // glTF loader records every node's parent matrix.
                {
                    const Vec3 world_x = rotate(
                        Vec3{mesh_scaling.x, 0.0f, 0.0f},
                        mesh_rotation);
                    const Vec3 world_y = rotate(
                        Vec3{0.0f, mesh_scaling.y, 0.0f},
                        mesh_rotation);
                    const Vec3 world_z = rotate(
                        Vec3{0.0f, 0.0f, mesh_scaling.z},
                        mesh_rotation);
                    mesh.instance_parent_matrix = {
                        world_x.x, world_x.y, world_x.z, 0.0f,
                        world_y.x, world_y.y, world_y.z, 0.0f,
                        world_z.x, world_z.y, world_z.z, 0.0f,
                        mesh_position.x,
                        mesh_position.y,
                        mesh_position.z,
                        1.0f,
                    };
                }
                mesh.geometry = static_cast<std::uint32_t>(
                    engine.geometries.size() - 1);
                mesh.material = material;
                engine.meshes.push_back(mesh);
                asset.meshes.push_back(MeshHandle{
                    static_cast<std::uint32_t>(
                        engine.meshes.size() - 1)});${lightMeshLists ? `
                mesh_records_by_id[string_or(source, "id")].push_back(
                    static_cast<std::uint32_t>(
                        engine.meshes.size() - 1));` : ""}
            }
        }
    }

    if (const auto lights = document.find("lights");
        lights != document.end() && lights->is_array()) {
        for (const Json& source : *lights) {
            if (!source.is_object() || source.value("type", -1) != 0) {
                continue;
            }
            LightRecord light;
            light.kind = LightKind::point;
            light.position = vec3_or(source, "position", Vec3{});
            light.intensity = source.value("intensity", 1.0f);
            light.range = source.value(
                "range",
                std::numeric_limits<float>::max());
            light.diffuse_color =
                color3_or(source, "diffuse", Color3{1.0f, 1.0f, 1.0f});
            light.specular_color =
                color3_or(source, "specular", Color3{1.0f, 1.0f, 1.0f});${lightMeshLists ? `
            const auto resolve_mesh_ids =
                [&](const char* name,
                    std::vector<std::uint32_t>& target) {
                const auto ids = source.find(name);
                if (ids == source.end() || !ids->is_array()) return;
                for (const Json& entry : *ids) {
                    if (!entry.is_string()) continue;
                    const auto found = mesh_records_by_id.find(
                        entry.get<std::string>());
                    if (found == mesh_records_by_id.end()) continue;
                    target.insert(
                        target.end(),
                        found->second.begin(),
                        found->second.end());
                }
            };
            resolve_mesh_ids(
                "includedOnlyMeshesIds",
                light.included_meshes);
            resolve_mesh_ids(
                "excludedMeshesIds",
                light.excluded_meshes);` : ""}
            engine.lights.push_back(light);
            asset.lights.push_back(LightHandle{
                static_cast<std::uint32_t>(engine.lights.size() - 1)});
        }
    }

    if (const auto colors = document.find("clearColor");
        colors != document.end() && colors->is_array()) {
        asset.clear_color = Color4{
            number_at(*colors, 0, 0.2f),
            number_at(*colors, 1, 0.2f),
            number_at(*colors, 2, 0.3f),
            1.0f,
        };
        asset.has_clear_color = true;
    }

    if (const auto cameras = document.find("cameras");
        cameras != document.end() &&
        cameras->is_array() &&
        !cameras->empty()) {
        const std::string active =
            string_or(document, "activeCameraID");
        const Json* selected = &cameras->front();
        for (const Json& candidate : *cameras) {
            if (string_or(candidate, "id") == active) {
                selected = &candidate;
                break;
            }
        }
${cameraDerivation}
        CameraRecord& camera = engine.cameras[asset.camera.value];
        camera.fov = selected->value("fov", camera.fov);
        camera.near_plane =
            selected->value("minZ", camera.near_plane);
        camera.far_plane =
            selected->value("maxZ", camera.far_plane);
        asset.has_camera = true;
    }

    if (asset.meshes.empty()) {
        throw std::runtime_error(
            ".babylon scene contains no supported renderable meshes.");
    }
    engine.assets.push_back(std::move(asset));
    return AssetHandle{
        static_cast<std::uint32_t>(engine.assets.size() - 1)};
}

} // namespace bbl
`;
}

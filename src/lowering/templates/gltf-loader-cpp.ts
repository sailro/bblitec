export function gltfLoaderCpp(provenance: string): string {
    return `// ${provenance}
#include <bblite/pal_gltf.hpp>
#include <bblite/runtime.hpp>
#include <bblite/ts_runtime.hpp>
#include <bblite/upstream/gltf_glb_parser.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace bbl {
namespace {

using JsonArray = ts::JsonValue::Array;
using JsonObject = ts::JsonValue::Object;

const ts::JsonValue& required(const JsonObject& object, const std::string& key) {
    const auto found = object.find(key);
    if (found == object.end()) throw std::runtime_error("glTF is missing '" + key + "'.");
    return found->second;
}

const ts::JsonValue* optional(const JsonObject& object, const std::string& key) {
    const auto found = object.find(key);
    return found == object.end() ? nullptr : &found->second;
}

const JsonArray& array_or_empty(const JsonObject& object, const std::string& key) {
    static const JsonArray empty;
    const ts::JsonValue* value = optional(object, key);
    return value ? value->as_array() : empty;
}

std::size_t unsigned_value(const ts::JsonValue& value) {
    const double number = value.as_number();
    if (number < 0.0 || std::floor(number) != number) throw std::runtime_error("Expected unsigned integer.");
    return static_cast<std::size_t>(number);
}

std::size_t unsigned_or(const JsonObject& object, const std::string& key, std::size_t fallback) {
    const ts::JsonValue* value = optional(object, key);
    return value ? unsigned_value(*value) : fallback;
}

float float_or(const JsonObject& object, const std::string& key, float fallback) {
    const ts::JsonValue* value = optional(object, key);
    return value ? static_cast<float>(value->as_number()) : fallback;
}

bool bool_or(const JsonObject& object, const std::string& key, bool fallback) {
    const ts::JsonValue* value = optional(object, key);
    return value ? value->as_boolean() : fallback;
}

std::string string_or(const JsonObject& object, const std::string& key, std::string fallback = {}) {
    const ts::JsonValue* value = optional(object, key);
    return value ? value->as_string() : std::move(fallback);
}

std::vector<float> float_array(const ts::JsonValue* value) {
    if (!value) return {};
    std::vector<float> result;
    for (const ts::JsonValue& element : value->as_array()) {
        result.push_back(static_cast<float>(element.as_number()));
    }
    return result;
}

struct BufferViewInfo {
    std::size_t offset = 0;
    std::size_t length = 0;
    std::size_t stride = 0;
};

struct AccessorInfo {
    std::size_t buffer_view = 0;
    std::size_t offset = 0;
    std::size_t count = 0;
    std::uint32_t component_type = 0;
    std::string type;
    bool normalized = false;
};

std::size_t component_size(std::uint32_t component_type) {
    switch (component_type) {
        case 5120:
        case 5121:
            return 1;
        case 5122:
        case 5123:
            return 2;
        case 5125:
        case 5126:
            return 4;
        default:
            throw std::runtime_error("Unsupported glTF component type.");
    }
}

std::size_t component_count(const std::string& type) {
    if (type == "SCALAR") return 1;
    if (type == "VEC2") return 2;
    if (type == "VEC3") return 3;
    if (type == "VEC4") return 4;
    if (type == "MAT4") return 16;
    throw std::runtime_error("Unsupported glTF accessor type.");
}

template <typename T>
T read_value(const std::uint8_t* data) {
    T value{};
    std::memcpy(&value, data, sizeof(T));
    return value;
}

float read_component(
    const ts::ArrayBuffer& buffer,
    const upstream::ParsedGlbContainer& container,
    const std::vector<BufferViewInfo>& views,
    const AccessorInfo& accessor,
    std::size_t element,
    std::size_t component) {
    const BufferViewInfo& view = views.at(accessor.buffer_view);
    const std::size_t packed_stride = component_size(accessor.component_type) * component_count(accessor.type);
    const std::size_t stride = view.stride != 0 ? view.stride : packed_stride;
    const std::size_t offset =
        container.bin_offset + view.offset + accessor.offset + element * stride +
        component * component_size(accessor.component_type);
    if (offset + component_size(accessor.component_type) > buffer.byte_length()) {
        throw std::runtime_error("glTF accessor exceeds BIN chunk.");
    }
    const std::uint8_t* data = buffer.data() + offset;
    switch (accessor.component_type) {
        case 5120: {
            const std::int8_t value = read_value<std::int8_t>(data);
            return accessor.normalized ? std::max(-1.0f, static_cast<float>(value) / 127.0f) : value;
        }
        case 5121: {
            const std::uint8_t value = read_value<std::uint8_t>(data);
            return accessor.normalized ? static_cast<float>(value) / 255.0f : value;
        }
        case 5122: {
            const std::int16_t value = read_value<std::int16_t>(data);
            return accessor.normalized ? std::max(-1.0f, static_cast<float>(value) / 32767.0f) : value;
        }
        case 5123: {
            const std::uint16_t value = read_value<std::uint16_t>(data);
            return accessor.normalized ? static_cast<float>(value) / 65535.0f : value;
        }
        case 5125:
            return static_cast<float>(read_value<std::uint32_t>(data));
        case 5126:
            return read_value<float>(data);
        default:
            throw std::runtime_error("Unsupported glTF component type.");
    }
}

std::uint32_t read_index(
    const ts::ArrayBuffer& buffer,
    const upstream::ParsedGlbContainer& container,
    const std::vector<BufferViewInfo>& views,
    const AccessorInfo& accessor,
    std::size_t element) {
    return static_cast<std::uint32_t>(read_component(buffer, container, views, accessor, element, 0));
}

Vec3 normalize(Vec3 value) {
    const float length = std::sqrt(value.x * value.x + value.y * value.y + value.z * value.z);
    return length > 0.000001f
        ? Vec3{value.x / length, value.y / length, value.z / length}
        : Vec3{0.0f, 1.0f, 0.0f};
}

using Matrix = std::array<float, 16>;

Matrix identity_matrix() {
    Matrix result{};
    result[0] = result[5] = result[10] = result[15] = 1.0f;
    return result;
}

Matrix multiply_matrix(const Matrix& left, const Matrix& right) {
    Matrix result{};
    for (int column = 0; column < 4; ++column) {
        for (int row = 0; row < 4; ++row) {
            for (int index = 0; index < 4; ++index) {
                result[column * 4 + row] += left[index * 4 + row] * right[column * 4 + index];
            }
        }
    }
    return result;
}

Matrix local_matrix(const JsonObject& node) {
    if (const ts::JsonValue* matrix_value = optional(node, "matrix")) {
        const std::vector<float> values = float_array(matrix_value);
        if (values.size() != 16) throw std::runtime_error("glTF node matrix must have 16 values.");
        Matrix result{};
        std::copy(values.begin(), values.end(), result.begin());
        return result;
    }
    const std::vector<float> translation = float_array(optional(node, "translation"));
    const std::vector<float> rotation = float_array(optional(node, "rotation"));
    const std::vector<float> scale = float_array(optional(node, "scale"));
    const float tx = translation.size() == 3 ? translation[0] : 0.0f;
    const float ty = translation.size() == 3 ? translation[1] : 0.0f;
    const float tz = translation.size() == 3 ? translation[2] : 0.0f;
    const float x = rotation.size() == 4 ? rotation[0] : 0.0f;
    const float y = rotation.size() == 4 ? rotation[1] : 0.0f;
    const float z = rotation.size() == 4 ? rotation[2] : 0.0f;
    const float w = rotation.size() == 4 ? rotation[3] : 1.0f;
    const float sx = scale.size() == 3 ? scale[0] : 1.0f;
    const float sy = scale.size() == 3 ? scale[1] : 1.0f;
    const float sz = scale.size() == 3 ? scale[2] : 1.0f;
    Matrix result = identity_matrix();
    result[0] = (1.0f - 2.0f * (y * y + z * z)) * sx;
    result[1] = (2.0f * (x * y + z * w)) * sx;
    result[2] = (2.0f * (x * z - y * w)) * sx;
    result[4] = (2.0f * (x * y - z * w)) * sy;
    result[5] = (1.0f - 2.0f * (x * x + z * z)) * sy;
    result[6] = (2.0f * (y * z + x * w)) * sy;
    result[8] = (2.0f * (x * z + y * w)) * sz;
    result[9] = (2.0f * (y * z - x * w)) * sz;
    result[10] = (1.0f - 2.0f * (x * x + y * y)) * sz;
    result[12] = tx;
    result[13] = ty;
    result[14] = tz;
    return result;
}

Vec3 transform_point(const Matrix& matrix, Vec3 value) {
    const Vec3 transformed{
        matrix[0] * value.x + matrix[4] * value.y + matrix[8] * value.z + matrix[12],
        matrix[1] * value.x + matrix[5] * value.y + matrix[9] * value.z + matrix[13],
        matrix[2] * value.x + matrix[6] * value.y + matrix[10] * value.z + matrix[14],
    };
    return Vec3{-transformed.x, transformed.y, transformed.z};
}

Vec3 transform_direction(const Matrix& matrix, Vec3 value) {
    const Vec3 transformed{
        matrix[0] * value.x + matrix[4] * value.y + matrix[8] * value.z,
        matrix[1] * value.x + matrix[5] * value.y + matrix[9] * value.z,
        matrix[2] * value.x + matrix[6] * value.y + matrix[10] * value.z,
    };
    return normalize(Vec3{-transformed.x, transformed.y, transformed.z});
}

TextureData texture_data(
    const ts::ArrayBuffer& buffer,
    const upstream::ParsedGlbContainer& container,
    const std::vector<BufferViewInfo>& views,
    const JsonArray& images,
    const JsonArray& textures,
    const ts::JsonValue* texture_info) {
    TextureData result;
    if (!texture_info) return result;
    const JsonObject& info = texture_info->as_object();
    const std::size_t texture_index = unsigned_value(required(info, "index"));
    const JsonObject& texture = textures.at(texture_index).as_object();
    const std::size_t image_index = unsigned_value(required(texture, "source"));
    const JsonObject& image = images.at(image_index).as_object();
    const BufferViewInfo& view = views.at(unsigned_value(required(image, "bufferView")));
    const std::size_t start = container.bin_offset + view.offset;
    const std::size_t end = start + view.length;
    if (end > buffer.byte_length()) throw std::runtime_error("glTF image exceeds BIN chunk.");
    const std::string mime_type = string_or(image, "mimeType");
    if (mime_type != "image/png") {
        throw std::runtime_error("Only embedded PNG glTF images are supported.");
    }
    result.bytes.assign(buffer.bytes().begin() + start, buffer.bytes().begin() + end);
    return result;
}

MaterialHandle load_material(
    Engine& engine,
    const JsonObject& material_json,
    const ts::ArrayBuffer& buffer,
    const upstream::ParsedGlbContainer& container,
    const std::vector<BufferViewInfo>& views,
    const JsonArray& images,
    const JsonArray& textures) {
    MaterialRecord material;
    material.emissive_factor = Color3{0.0f, 0.0f, 0.0f};
    if (const ts::JsonValue* pbr_value = optional(material_json, "pbrMetallicRoughness")) {
        const JsonObject& pbr = pbr_value->as_object();
        const std::vector<float> base = float_array(optional(pbr, "baseColorFactor"));
        if (base.size() == 4) material.base_color_factor = Color4{base[0], base[1], base[2], base[3]};
        material.metallic_factor = float_or(pbr, "metallicFactor", 1.0f);
        material.roughness_factor = float_or(pbr, "roughnessFactor", 1.0f);
        material.base_color_texture = texture_data(
            buffer, container, views, images, textures, optional(pbr, "baseColorTexture"));
        material.metallic_roughness_texture = texture_data(
            buffer, container, views, images, textures, optional(pbr, "metallicRoughnessTexture"));
    }
    material.normal_texture = texture_data(
        buffer, container, views, images, textures, optional(material_json, "normalTexture"));
    material.emissive_texture = texture_data(
        buffer, container, views, images, textures, optional(material_json, "emissiveTexture"));
    const std::vector<float> emissive = float_array(optional(material_json, "emissiveFactor"));
    if (emissive.size() == 3) material.emissive_factor = Color3{emissive[0], emissive[1], emissive[2]};
    material.double_sided = bool_or(material_json, "doubleSided", false);
    const std::string alpha_mode = string_or(material_json, "alphaMode", "OPAQUE");
    material.alpha_mode =
        alpha_mode == "BLEND"
            ? MaterialAlphaMode::blend
            : alpha_mode == "MASK"
                ? MaterialAlphaMode::mask
                : MaterialAlphaMode::opaque;
    material.alpha_cutoff = float_or(material_json, "alphaCutoff", 0.5f);
    engine.materials.push_back(std::move(material));
    return MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

} // namespace

AssetHandle load_gltf(Engine& engine, const std::string& path) {
    ts::ArrayBuffer buffer = ts::await(pal::fetch_array_buffer(path));
    const upstream::ParsedGlbContainer container = upstream::parse_glb_container(buffer);
    const JsonObject& document = container.json.as_object();
    const JsonArray& view_json = array_or_empty(document, "bufferViews");
    const JsonArray& accessor_json = array_or_empty(document, "accessors");
    const JsonArray& image_json = array_or_empty(document, "images");
    const JsonArray& texture_json = array_or_empty(document, "textures");
    const JsonArray& material_json = array_or_empty(document, "materials");
    const JsonArray& mesh_json = array_or_empty(document, "meshes");
    const JsonArray& node_json = array_or_empty(document, "nodes");

    std::vector<BufferViewInfo> views;
    views.reserve(view_json.size());
    for (const ts::JsonValue& value : view_json) {
        const JsonObject& object = value.as_object();
        views.push_back(BufferViewInfo{
            unsigned_or(object, "byteOffset", 0),
            unsigned_value(required(object, "byteLength")),
            unsigned_or(object, "byteStride", 0),
        });
    }
    std::vector<AccessorInfo> accessors;
    accessors.reserve(accessor_json.size());
    for (const ts::JsonValue& value : accessor_json) {
        const JsonObject& object = value.as_object();
        accessors.push_back(AccessorInfo{
            unsigned_value(required(object, "bufferView")),
            unsigned_or(object, "byteOffset", 0),
            unsigned_value(required(object, "count")),
            static_cast<std::uint32_t>(unsigned_value(required(object, "componentType"))),
            required(object, "type").as_string(),
            bool_or(object, "normalized", false),
        });
    }
    std::vector<MaterialHandle> materials;
    materials.reserve(material_json.size());
    for (const ts::JsonValue& value : material_json) {
        materials.push_back(load_material(
            engine, value.as_object(), buffer, container, views, image_json, texture_json));
    }

    std::vector<int> parents(node_json.size(), -1);
    for (std::size_t index = 0; index < node_json.size(); ++index) {
        for (const ts::JsonValue& child : array_or_empty(node_json[index].as_object(), "children")) {
            const std::size_t child_index = unsigned_value(child);
            if (child_index < parents.size()) parents[child_index] = static_cast<int>(index);
        }
    }
    std::vector<Matrix> world(node_json.size());
    std::vector<bool> computed(node_json.size(), false);
    std::function<const Matrix&(std::size_t)> compute_world = [&](std::size_t index) -> const Matrix& {
        if (computed[index]) return world[index];
        const Matrix local = local_matrix(node_json[index].as_object());
        world[index] = parents[index] >= 0
            ? multiply_matrix(compute_world(static_cast<std::size_t>(parents[index])), local)
            : local;
        computed[index] = true;
        return world[index];
    };

    AssetRecord asset;
    for (std::size_t node_index = 0; node_index < node_json.size(); ++node_index) {
        const JsonObject& node = node_json[node_index].as_object();
        const ts::JsonValue* mesh_value = optional(node, "mesh");
        if (!mesh_value) continue;
        const JsonObject& mesh = mesh_json.at(unsigned_value(*mesh_value)).as_object();
        for (const ts::JsonValue& primitive_value : array_or_empty(mesh, "primitives")) {
            const JsonObject& primitive = primitive_value.as_object();
            if (unsigned_or(primitive, "mode", 4) != 4) {
                throw std::runtime_error("Only triangle-list glTF primitives are supported.");
            }
            const JsonObject& attributes = required(primitive, "attributes").as_object();
            const AccessorInfo& positions = accessors.at(unsigned_value(required(attributes, "POSITION")));
            const AccessorInfo* normals = optional(attributes, "NORMAL")
                ? &accessors.at(unsigned_value(*optional(attributes, "NORMAL")))
                : nullptr;
            const AccessorInfo* tangents = optional(attributes, "TANGENT")
                ? &accessors.at(unsigned_value(*optional(attributes, "TANGENT")))
                : nullptr;
            const AccessorInfo* texcoords = optional(attributes, "TEXCOORD_0")
                ? &accessors.at(unsigned_value(*optional(attributes, "TEXCOORD_0")))
                : nullptr;
            ModelGeometry geometry;
            geometry.vertices.resize(positions.count);
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
            const Matrix& matrix = compute_world(node_index);
            for (std::size_t index = 0; index < positions.count; ++index) {
                ModelVertex vertex;
                vertex.position = transform_point(matrix, Vec3{
                    read_component(buffer, container, views, positions, index, 0),
                    read_component(buffer, container, views, positions, index, 1),
                    read_component(buffer, container, views, positions, index, 2),
                });
                if (normals) {
                    vertex.normal = transform_direction(matrix, Vec3{
                        read_component(buffer, container, views, *normals, index, 0),
                        read_component(buffer, container, views, *normals, index, 1),
                        read_component(buffer, container, views, *normals, index, 2),
                    });
                }
                if (tangents) {
                    const Vec3 tangent = transform_direction(matrix, Vec3{
                        read_component(buffer, container, views, *tangents, index, 0),
                        read_component(buffer, container, views, *tangents, index, 1),
                        read_component(buffer, container, views, *tangents, index, 2),
                    });
                    vertex.tangent = Vec4{
                        tangent.x,
                        tangent.y,
                        tangent.z,
                        -read_component(buffer, container, views, *tangents, index, 3),
                    };
                }
                if (texcoords) {
                    vertex.uv = Vec2{
                        read_component(buffer, container, views, *texcoords, index, 0),
                        read_component(buffer, container, views, *texcoords, index, 1),
                    };
                }
                geometry.bounds_min.x = std::min(geometry.bounds_min.x, vertex.position.x);
                geometry.bounds_min.y = std::min(geometry.bounds_min.y, vertex.position.y);
                geometry.bounds_min.z = std::min(geometry.bounds_min.z, vertex.position.z);
                geometry.bounds_max.x = std::max(geometry.bounds_max.x, vertex.position.x);
                geometry.bounds_max.y = std::max(geometry.bounds_max.y, vertex.position.y);
                geometry.bounds_max.z = std::max(geometry.bounds_max.z, vertex.position.z);
                geometry.vertices[index] = vertex;
            }
            if (const ts::JsonValue* indices_value = optional(primitive, "indices")) {
                const AccessorInfo& indices = accessors.at(unsigned_value(*indices_value));
                geometry.indices.resize(indices.count);
                for (std::size_t index = 0; index < indices.count; ++index) {
                    geometry.indices[index] = read_index(buffer, container, views, indices, index);
                }
            } else {
                geometry.indices.resize(geometry.vertices.size());
                for (std::size_t index = 0; index < geometry.indices.size(); ++index) {
                    geometry.indices[index] = static_cast<std::uint32_t>(index);
                }
            }
            engine.geometries.push_back(std::move(geometry));
            MeshRecord record;
            record.primitive = PrimitiveKind::gltf;
            record.geometry = static_cast<std::uint32_t>(engine.geometries.size() - 1);
            const std::size_t material_index = unsigned_or(primitive, "material", 0);
            if (material_index < materials.size()) record.material = materials[material_index];
            engine.meshes.push_back(record);
            asset.meshes.push_back(MeshHandle{static_cast<std::uint32_t>(engine.meshes.size() - 1)});
        }
    }
    if (asset.meshes.empty()) throw std::runtime_error("glTF contains no renderable meshes.");
    engine.assets.push_back(std::move(asset));
    return AssetHandle{static_cast<std::uint32_t>(engine.assets.size() - 1)};
}

} // namespace bbl
`;
}

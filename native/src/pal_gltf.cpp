#include <bblite/runtime.hpp>
#include <bblite/pal.hpp>
#include <bblite/pal_gltf.hpp>
#include <bblite/upstream/gltf_glb_parser.hpp>

#define CGLTF_IMPLEMENTATION
#include <cgltf.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>

namespace bbl::pal {
namespace {

struct CgltfDeleter {
    void operator()(cgltf_data* data) const {
        cgltf_free(data);
    }
};

using CgltfData = std::unique_ptr<cgltf_data, CgltfDeleter>;

[[noreturn]] void fail(const std::string& message, cgltf_result result) {
    throw std::runtime_error(message + " (cgltf result " + std::to_string(static_cast<int>(result)) + ").");
}

Vec3 normalize(Vec3 value) {
    const float length = std::sqrt(value.x * value.x + value.y * value.y + value.z * value.z);
    if (length <= 0.000001f) {
        return Vec3{0.0f, 1.0f, 0.0f};
    }
    return Vec3{value.x / length, value.y / length, value.z / length};
}

Vec3 transform_point(const cgltf_float* matrix, Vec3 value) {
    const Vec3 transformed{
        matrix[0] * value.x + matrix[4] * value.y + matrix[8] * value.z + matrix[12],
        matrix[1] * value.x + matrix[5] * value.y + matrix[9] * value.z + matrix[13],
        matrix[2] * value.x + matrix[6] * value.y + matrix[10] * value.z + matrix[14],
    };
    return Vec3{-transformed.x, transformed.y, transformed.z};
}

Vec3 transform_direction(const cgltf_float* matrix, Vec3 value) {
    const Vec3 transformed{
        matrix[0] * value.x + matrix[4] * value.y + matrix[8] * value.z,
        matrix[1] * value.x + matrix[5] * value.y + matrix[9] * value.z,
        matrix[2] * value.x + matrix[6] * value.y + matrix[10] * value.z,
    };
    return normalize(Vec3{-transformed.x, transformed.y, transformed.z});
}

TextureData copy_texture(const cgltf_texture_view& view) {
    TextureData result;
    if (!view.texture || !view.texture->image) {
        return result;
    }
    const cgltf_image& image = *view.texture->image;
    if (!image.buffer_view) {
        throw std::runtime_error("Only embedded glTF images are supported.");
    }
    const std::uint8_t* data = cgltf_buffer_view_data(image.buffer_view);
    if (!data) {
        throw std::runtime_error("Embedded glTF image data is unavailable.");
    }
    result.bytes.assign(data, data + image.buffer_view->size);
    result.mime_type = image.mime_type ? image.mime_type : "";
    return result;
}

MaterialHandle load_material(Engine& engine, const cgltf_material* source) {
    MaterialRecord material;
    if (source) {
        if (source->has_pbr_metallic_roughness) {
            const auto& pbr = source->pbr_metallic_roughness;
            material.base_color_factor = Color4{
                pbr.base_color_factor[0],
                pbr.base_color_factor[1],
                pbr.base_color_factor[2],
                pbr.base_color_factor[3],
            };
            material.metallic_factor = pbr.metallic_factor;
            material.roughness_factor = pbr.roughness_factor;
            material.base_color_texture = copy_texture(pbr.base_color_texture);
            material.metallic_roughness_texture = copy_texture(pbr.metallic_roughness_texture);
        }
        material.normal_texture = copy_texture(source->normal_texture);
        material.emissive_texture = copy_texture(source->emissive_texture);
        material.emissive_factor = Color3{
            source->emissive_factor[0],
            source->emissive_factor[1],
            source->emissive_factor[2],
        };
        material.double_sided = source->double_sided != 0;
    }
    engine.materials.push_back(std::move(material));
    return MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

const cgltf_accessor* required_accessor(const cgltf_primitive& primitive, cgltf_attribute_type type, const char* name) {
    const cgltf_accessor* accessor = cgltf_find_accessor(&primitive, type, 0);
    if (!accessor) {
        throw std::runtime_error(std::string("glTF primitive is missing ") + name + ".");
    }
    return accessor;
}

} // namespace

ts::Promise<ts::ArrayBuffer> fetch_array_buffer(const std::string& path) {
    return ts::Promise<ts::ArrayBuffer>(ts::ArrayBuffer(read_binary_file(path)));
}

AssetHandle load_glb(Engine& engine, const ts::ArrayBuffer& buffer, const std::string& path) {
    cgltf_options options{};
    cgltf_data* raw_data = nullptr;
    const std::vector<std::uint8_t>& source_bytes = buffer.bytes();
    const upstream::ParsedGlbContainer container =
        upstream::parse_glb_container(buffer);
    if (container.bin_length == 0) {
        throw std::runtime_error("GLB contains an empty BIN chunk.");
    }
    cgltf_result result = cgltf_parse(&options, source_bytes.data(), source_bytes.size(), &raw_data);
    if (result != cgltf_result_success) {
        fail("Unable to parse glTF file '" + path + "'", result);
    }
    CgltfData data(raw_data);

    result = cgltf_load_buffers(&options, data.get(), path.c_str());
    if (result != cgltf_result_success) {
        fail("Unable to load glTF buffers from '" + path + "'", result);
    }
    result = cgltf_validate(data.get());
    if (result != cgltf_result_success) {
        fail("Invalid glTF file '" + path + "'", result);
    }

    AssetRecord asset;
    std::unordered_map<const cgltf_material*, MaterialHandle> materials;

    for (cgltf_size node_index = 0; node_index < data->nodes_count; ++node_index) {
        const cgltf_node& node = data->nodes[node_index];
        if (!node.mesh) {
            continue;
        }

        cgltf_float world[16];
        cgltf_node_transform_world(&node, world);

        for (cgltf_size primitive_index = 0; primitive_index < node.mesh->primitives_count; ++primitive_index) {
            const cgltf_primitive& primitive = node.mesh->primitives[primitive_index];
            if (primitive.type != cgltf_primitive_type_triangles) {
                throw std::runtime_error("Only triangle-list glTF primitives are supported.");
            }

            const cgltf_accessor* positions = required_accessor(primitive, cgltf_attribute_type_position, "POSITION");
            const cgltf_accessor* normals = cgltf_find_accessor(&primitive, cgltf_attribute_type_normal, 0);
            const cgltf_accessor* tangents = cgltf_find_accessor(&primitive, cgltf_attribute_type_tangent, 0);
            const cgltf_accessor* texcoords = cgltf_find_accessor(&primitive, cgltf_attribute_type_texcoord, 0);

            ModelGeometry geometry;
            geometry.vertices.resize(positions->count);
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

            for (cgltf_size vertex_index = 0; vertex_index < positions->count; ++vertex_index) {
                cgltf_float values[4]{};
                if (!cgltf_accessor_read_float(positions, vertex_index, values, 3)) {
                    throw std::runtime_error("Unable to read glTF POSITION data.");
                }
                ModelVertex vertex;
                vertex.position = transform_point(world, Vec3{values[0], values[1], values[2]});

                if (normals) {
                    cgltf_accessor_read_float(normals, vertex_index, values, 3);
                    vertex.normal = transform_direction(world, Vec3{values[0], values[1], values[2]});
                }
                if (tangents) {
                    cgltf_accessor_read_float(tangents, vertex_index, values, 4);
                    const Vec3 tangent = transform_direction(world, Vec3{values[0], values[1], values[2]});
                    vertex.tangent = Vec4{tangent.x, tangent.y, tangent.z, -values[3]};
                }
                if (texcoords) {
                    cgltf_accessor_read_float(texcoords, vertex_index, values, 2);
                    vertex.uv = Vec2{values[0], values[1]};
                }

                geometry.bounds_min.x = std::min(geometry.bounds_min.x, vertex.position.x);
                geometry.bounds_min.y = std::min(geometry.bounds_min.y, vertex.position.y);
                geometry.bounds_min.z = std::min(geometry.bounds_min.z, vertex.position.z);
                geometry.bounds_max.x = std::max(geometry.bounds_max.x, vertex.position.x);
                geometry.bounds_max.y = std::max(geometry.bounds_max.y, vertex.position.y);
                geometry.bounds_max.z = std::max(geometry.bounds_max.z, vertex.position.z);
                geometry.vertices[vertex_index] = vertex;
            }

            if (primitive.indices) {
                geometry.indices.resize(primitive.indices->count);
                for (cgltf_size index = 0; index < primitive.indices->count; ++index) {
                    geometry.indices[index] = static_cast<std::uint32_t>(cgltf_accessor_read_index(primitive.indices, index));
                }
            } else {
                geometry.indices.resize(geometry.vertices.size());
                for (std::size_t index = 0; index < geometry.vertices.size(); ++index) {
                    geometry.indices[index] = static_cast<std::uint32_t>(index);
                }
            }
            MaterialHandle material;
            const auto material_it = materials.find(primitive.material);
            if (material_it == materials.end()) {
                material = load_material(engine, primitive.material);
                materials.emplace(primitive.material, material);
            } else {
                material = material_it->second;
            }

            engine.geometries.push_back(std::move(geometry));
            MeshRecord mesh;
            mesh.primitive = PrimitiveKind::gltf;
            mesh.geometry = static_cast<std::uint32_t>(engine.geometries.size() - 1);
            mesh.material = material;
            engine.meshes.push_back(mesh);
            asset.meshes.push_back(MeshHandle{static_cast<std::uint32_t>(engine.meshes.size() - 1)});
        }
    }

    if (asset.meshes.empty()) {
        throw std::runtime_error("glTF file contains no renderable triangle meshes.");
    }

    engine.assets.push_back(std::move(asset));
    return AssetHandle{static_cast<std::uint32_t>(engine.assets.size() - 1)};
}

} // namespace bbl::pal

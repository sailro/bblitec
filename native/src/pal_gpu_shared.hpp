// Vertex packing shared by the SDL_GPU and Dawn render backends.
// Moved verbatim from pal_sdl_gpu.cpp so both backends upload
// byte-identical vertex data.
#pragma once

#include <bblite/pal_image.hpp>
#include <bblite/runtime.hpp>
#include <bblite/ts_runtime.hpp>
#include <bblite/upstream/render_capabilities.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <vector>

namespace bbl::pal {

struct GpuVertex {
    float position[3];
    float normal[3];
    float tangent[4];
    float uv[2];
    float local_position[3];
    float uv2[2];
    float color[4];
    float local_normal[3];
#if BBLITE_GPU_DEFORMATION
    float joints[4];
    float weights[4];
    float morph_position_0[3];
    float morph_position_1[3];
    float morph_normal_0[3];
    float morph_normal_1[3];
    float morph_tangent_0[3];
    float morph_tangent_1[3];
#endif
};
#if BBLITE_GPU_DEFORMATION
static_assert(sizeof(GpuVertex) == 200);
#else
static_assert(sizeof(GpuVertex) == 96);
#endif

#if BBLITE_GPU_DEFORMATION
// Vertex deformation uniforms shared by both render backends (moved
// verbatim from pal_sdl_gpu.cpp).
struct DeformationUniforms {
    std::array<std::array<float, 16>, 64> bone_matrices{};
    float morph_weights[4]{};
    float options[4]{};
};

inline DeformationUniforms build_deformation_uniforms(
    const MeshRecord& mesh,
    bool flat_normals) {
    DeformationUniforms result;
    for (std::array<float, 16>& matrix : result.bone_matrices) {
        matrix[0] = 1.0f;
        matrix[5] = 1.0f;
        matrix[10] = 1.0f;
        matrix[15] = 1.0f;
    }
    if (!mesh.gpu_deformation) return result;
    if (mesh.bone_matrices.size() > result.bone_matrices.size()) {
        throw std::runtime_error(
            "GPU deformation bone palette exceeds 64 matrices.");
    }
    const std::size_t count = std::min(
        mesh.bone_matrices.size(),
        result.bone_matrices.size());
    std::copy_n(
        mesh.bone_matrices.begin(),
        count,
        result.bone_matrices.begin());
    std::copy(
        mesh.morph_weights.begin(),
        mesh.morph_weights.end(),
        result.morph_weights);
    result.options[0] = 1.0f;
    result.options[1] = flat_normals ? 1.0f : 0.0f;
    return result;
}
#endif

inline Vec3 rotate_euler(Vec3 value, const Vec3& rotation) {
    // The pinned Euler proxy converts through eulerToQuat's intrinsic
    // XYZ order (src/math/quat-euler.ts), which applies Z, then Y,
    // then X to a vector; single-axis rotations are unaffected by the
    // ordering.
    const float sin_z = std::sin(rotation.z);
    const float cos_z = std::cos(rotation.z);
    value = Vec3{
        value.x * cos_z - value.y * sin_z,
        value.x * sin_z + value.y * cos_z,
        value.z,
    };
    const float sin_y = std::sin(rotation.y);
    const float cos_y = std::cos(rotation.y);
    value = Vec3{
        value.x * cos_y + value.z * sin_y,
        value.y,
        -value.x * sin_y + value.z * cos_y,
    };
    const float sin_x = std::sin(rotation.x);
    const float cos_x = std::cos(rotation.x);
    return Vec3{
        value.x,
        value.y * cos_x - value.z * sin_x,
        value.y * sin_x + value.z * cos_x,
    };
}

inline Vec3 rotate_quaternion(Vec3 value, const Vec4& quaternion) {
    const float length = std::sqrt(
        quaternion.x * quaternion.x +
        quaternion.y * quaternion.y +
        quaternion.z * quaternion.z +
        quaternion.w * quaternion.w);
    if (length <= 0.000001f) return value;
    const float x = quaternion.x / length;
    const float y = quaternion.y / length;
    const float z = quaternion.z / length;
    const float w = quaternion.w / length;
    const Vec3 doubled_cross{
        2.0f * (y * value.z - z * value.y),
        2.0f * (z * value.x - x * value.z),
        2.0f * (x * value.y - y * value.x),
    };
    return Vec3{
        value.x +
            w * doubled_cross.x +
            (y * doubled_cross.z - z * doubled_cross.y),
        value.y +
            w * doubled_cross.y +
            (z * doubled_cross.x - x * doubled_cross.z),
        value.z +
            w * doubled_cross.z +
            (x * doubled_cross.y - y * doubled_cross.x),
    };
}

inline Vec3 rotate_mesh(Vec3 value, const MeshRecord& mesh) {
    return mesh.has_rotation_quaternion
        ? rotate_quaternion(value, mesh.rotation_quaternion)
        : rotate_euler(value, mesh.rotation);
}

inline Vec3 normalize_vec3(Vec3 value) {
    const float length = std::sqrt(
        value.x * value.x +
        value.y * value.y +
        value.z * value.z);
    return length > 0.000001f
        ? Vec3{
              value.x / length,
              value.y / length,
              value.z / length,
          }
        : Vec3{};
}

inline std::vector<GpuVertex> transformed_vertices(
    const ModelGeometry& geometry,
    const MeshRecord& mesh) {
    // Thin-instanced meshes keep local-space vertices: the pinned vertex
    // stage composes mesh.world * instanceWorld, so the record transform
    // reaches the shader through the instance parent-world uniform
    // instead of the baked vertex positions. Baking through an identity
    // transform keeps the exact byte path older instanced scenes
    // validated (including the normal renormalization).
    static const MeshRecord identity_transform{};
    const MeshRecord& trs =
        mesh.thin_instanced ? identity_transform : mesh;
    const std::vector<ModelVertex>& source_vertices =
        mesh.gpu_deformation &&
                geometry.bind_vertices.size() ==
                    geometry.vertices.size()
            ? geometry.bind_vertices
            : geometry.vertices;
    std::vector<GpuVertex> result;
    result.reserve(source_vertices.size());
    for (
        std::size_t vertex_index = 0;
        vertex_index < source_vertices.size();
        ++vertex_index) {
        const ModelVertex& vertex =
            source_vertices[vertex_index];
        const ModelVertex& normal_vertex =
            mesh.gpu_deformation && geometry.flat_normals
                ? geometry.vertices[vertex_index]
                : vertex;
        Vec3 position{
            vertex.position.x * trs.scaling.x,
            vertex.position.y * trs.scaling.y,
            vertex.position.z * trs.scaling.z,
        };
        position = rotate_mesh(position, trs);
        position.x += trs.position.x;
        position.y += trs.position.y;
        position.z += trs.position.z;
        const Vec3 normal = normalize_vec3(
            rotate_mesh(
                Vec3{
                    trs.scaling.x != 0.0f
                        ? normal_vertex.normal.x / trs.scaling.x
                        : 0.0f,
                    trs.scaling.y != 0.0f
                        ? normal_vertex.normal.y / trs.scaling.y
                        : 0.0f,
                    trs.scaling.z != 0.0f
                        ? normal_vertex.normal.z / trs.scaling.z
                        : 0.0f,
                },
                trs));
        const Vec3 tangent = normalize_vec3(
            rotate_mesh(
                Vec3{
                    vertex.tangent.x * trs.scaling.x,
                    vertex.tangent.y * trs.scaling.y,
                    vertex.tangent.z * trs.scaling.z,
                },
                trs));
        result.push_back(GpuVertex{
            {position.x, position.y, position.z},
            {normal.x, normal.y, normal.z},
            {
                tangent.x,
                tangent.y,
                tangent.z,
                vertex.tangent.w,
            },
            {vertex.uv.x, vertex.uv.y},
            {
                vertex.local_position.x,
                vertex.local_position.y,
                vertex.local_position.z,
            },
            {vertex.uv2.x, vertex.uv2.y},
            {
                vertex.color.x,
                vertex.color.y,
                vertex.color.z,
                vertex.color.w,
            },
            {
                vertex.normal.x,
                vertex.normal.y,
                vertex.normal.z,
            },
#if BBLITE_GPU_DEFORMATION
            {
                static_cast<float>(vertex.joints[0]),
                static_cast<float>(vertex.joints[1]),
                static_cast<float>(vertex.joints[2]),
                static_cast<float>(vertex.joints[3]),
            },
            {
                mesh.gpu_deformation &&
                        vertex.weights.x +
                                vertex.weights.y +
                                vertex.weights.z +
                                vertex.weights.w <=
                            0.0f
                    ? 1.0f
                    : vertex.weights.x,
                vertex.weights.y,
                vertex.weights.z,
                vertex.weights.w,
            },
            {
                geometry.morph_positions.size() > 0
                    ? -geometry.morph_positions[0][vertex_index].x
                    : 0.0f,
                geometry.morph_positions.size() > 0
                    ? geometry.morph_positions[0][vertex_index].y
                    : 0.0f,
                geometry.morph_positions.size() > 0
                    ? geometry.morph_positions[0][vertex_index].z
                    : 0.0f,
            },
            {
                geometry.morph_positions.size() > 1
                    ? -geometry.morph_positions[1][vertex_index].x
                    : 0.0f,
                geometry.morph_positions.size() > 1
                    ? geometry.morph_positions[1][vertex_index].y
                    : 0.0f,
                geometry.morph_positions.size() > 1
                    ? geometry.morph_positions[1][vertex_index].z
                    : 0.0f,
            },
            {
                geometry.morph_normals.size() > 0
                    ? -geometry.morph_normals[0][vertex_index].x
                    : 0.0f,
                geometry.morph_normals.size() > 0
                    ? geometry.morph_normals[0][vertex_index].y
                    : 0.0f,
                geometry.morph_normals.size() > 0
                    ? geometry.morph_normals[0][vertex_index].z
                    : 0.0f,
            },
            {
                geometry.morph_normals.size() > 1
                    ? -geometry.morph_normals[1][vertex_index].x
                    : 0.0f,
                geometry.morph_normals.size() > 1
                    ? geometry.morph_normals[1][vertex_index].y
                    : 0.0f,
                geometry.morph_normals.size() > 1
                    ? geometry.morph_normals[1][vertex_index].z
                    : 0.0f,
            },
            {
                geometry.morph_tangents.size() > 0
                    ? -geometry.morph_tangents[0][vertex_index].x
                    : 0.0f,
                geometry.morph_tangents.size() > 0
                    ? geometry.morph_tangents[0][vertex_index].y
                    : 0.0f,
                geometry.morph_tangents.size() > 0
                    ? geometry.morph_tangents[0][vertex_index].z
                    : 0.0f,
            },
            {
                geometry.morph_tangents.size() > 1
                    ? -geometry.morph_tangents[1][vertex_index].x
                    : 0.0f,
                geometry.morph_tangents.size() > 1
                    ? geometry.morph_tangents[1][vertex_index].y
                    : 0.0f,
                geometry.morph_tangents.size() > 1
                    ? geometry.morph_tangents[1][vertex_index].z
                    : 0.0f,
            },
#endif
        });
    }
    return result;
}

// Inverse image processing for the linear-frame clear color shared by
// both render backends (moved verbatim from pal_sdl_gpu.cpp).
inline float inverse_image_processed_channel(
    float value,
    float exposure,
    float contrast,
    bool tone_mapping) {
    float color = std::clamp(value, 0.0f, 1.0f);
    if (contrast < 1.0f) {
        color = contrast > 0.0f
            ? std::clamp(
                  (color - 0.5f * (1.0f - contrast)) / contrast,
                  0.0f,
                  1.0f)
            : 0.5f;
    } else if (contrast > 1.0f) {
        const float mix_amount = contrast - 1.0f;
        float low = 0.0f;
        float high = 1.0f;
        for (std::uint32_t index = 0; index < 16; ++index) {
            const float middle = (low + high) * 0.5f;
            const float smooth =
                middle * middle * (3.0f - 2.0f * middle);
            const float output =
                middle + (smooth - middle) * mix_amount;
            if (output < color) {
                low = middle;
            } else {
                high = middle;
            }
        }
        color = (low + high) * 0.5f;
    }
    color = std::pow(color, 2.2f);
    if (tone_mapping) {
        color =
            -std::log2(std::max(1.0f - color, 0.000001f)) /
            1.59057903289794921875f;
    }
    return exposure > 0.0f ? color / exposure : color;
}

#if BBLITE_GPU_MORPH_STORAGE
// Storage-buffer morph payloads shared by both render backends (moved
// verbatim from the two upload paths). Both backends must pack these
// byte-identically: the deltas are indexed by the shader as
// (target * vertexCount + vertex) * 6, and the weights blob carries a
// 16-byte header the shader reads before the float array.
inline std::vector<float> pack_morph_deltas(
    const ModelGeometry& geometry) {
    // Flat 6-float deltas indexed
    // (target * vertexCount + vertex) * 6, packed with the
    // same x negation as the vertex attributes.
    const std::size_t target_count = geometry.morph_positions.size();
    const std::size_t vertex_count = geometry.vertices.size();
    std::vector<float> deltas(
        target_count * vertex_count * 6,
        0.0f);
    for (
        std::size_t target = 0;
        target < target_count;
        ++target) {
        const std::vector<Vec3>& positions =
            geometry.morph_positions[target];
        for (
            std::size_t vertex = 0;
            vertex < vertex_count;
            ++vertex) {
            const std::size_t offset =
                (target * vertex_count + vertex) * 6;
            const Vec3 position =
                vertex < positions.size()
                    ? positions[vertex]
                    : Vec3{};
            const Vec3 normal =
                target < geometry.morph_normals.size() &&
                vertex <
                    geometry.morph_normals[target].size()
                    ? geometry.morph_normals[target][vertex]
                    : Vec3{};
            deltas[offset] = -position.x;
            deltas[offset + 1] = position.y;
            deltas[offset + 2] = position.z;
            deltas[offset + 3] = -normal.x;
            deltas[offset + 4] = normal.y;
            deltas[offset + 5] = normal.z;
        }
    }
    return deltas;
}

inline std::vector<std::uint8_t> pack_morph_weights(
    const ModelGeometry& geometry,
    const MeshRecord& mesh_record) {
    const std::size_t target_count = geometry.morph_positions.size();
    const std::size_t vertex_count = geometry.vertices.size();
    std::vector<std::uint8_t> weights_blob(
        16 + target_count * sizeof(float),
        0);
    const std::uint32_t header[2] = {
        static_cast<std::uint32_t>(target_count),
        static_cast<std::uint32_t>(vertex_count),
    };
    std::memcpy(
        weights_blob.data(),
        header,
        sizeof(header));
    for (
        std::size_t target = 0;
        target < target_count;
        ++target) {
        const float weight =
            target < mesh_record.morph_storage_weights.size()
                ? mesh_record.morph_storage_weights[target]
                : 0.0f;
        std::memcpy(
            weights_blob.data() + 16 +
                target * sizeof(float),
            &weight,
            sizeof(float));
    }
    return weights_blob;
}
#endif

// RGBD decode and half-float packing shared by both render
// backends (moved verbatim from pal_sdl_gpu.cpp).
inline std::vector<float> decode_rgbd(const TextureData& texture_data, int& width, int& height) {
    if (texture_data.bytes.empty()) {
        width = height = 1;
        return {0.0f, 0.0f, 0.0f, 1.0f};
    }
    const DecodedImage image = decode_image(ts::ArrayBuffer(texture_data.bytes));
    width = image.width;
    height = image.height;
    std::vector<float> result(static_cast<std::size_t>(width) * height * 4);
    for (std::size_t index = 0; index < image.rgba.size(); index += 4) {
        const float alpha = std::max(static_cast<float>(image.rgba[index + 3]) / 255.0f, 1.0f / 255.0f);
        result[index] = std::pow(static_cast<float>(image.rgba[index]) / 255.0f, 2.2f) / alpha;
        result[index + 1] = std::pow(static_cast<float>(image.rgba[index + 1]) / 255.0f, 2.2f) / alpha;
        result[index + 2] = std::pow(static_cast<float>(image.rgba[index + 2]) / 255.0f, 2.2f) / alpha;
        result[index + 3] = 1.0f;
    }
    return result;
}

// The PBR diagnostic buffers both backends write, in the order the
// comparison tool reads them (src/compare-lite-diagnostics.ts).
inline constexpr std::array<const char*, 9> pbr_diagnostic_names{
    "normal-gpu.png",
    "reflectivity-gpu.png",
    "irradiance-gpu.png",
    "ibl-gpu.png",
    "normalized-depth-gpu.png",
    "albedo-gpu.png",
    "direct-light-gpu.png",
    "base-color-gpu.png",
    "pre-tone-hdr-gpu.png",
};

// The readback inverse of float_to_half below, shared by both backends'
// screenshot and diagnostic-buffer paths: a half-float channel decoded
// and quantized to the byte a PNG stores.
inline std::uint8_t half_to_byte(std::uint16_t value) {
    const bool negative = (value & 0x8000u) != 0;
    const std::uint16_t exponent = (value >> 10) & 0x1fu;
    const std::uint16_t mantissa = value & 0x03ffu;
    float decoded = 0.0f;
    if (exponent == 0) {
        decoded = std::ldexp(static_cast<float>(mantissa), -24);
    } else if (exponent == 31) {
        decoded = mantissa == 0
            ? std::numeric_limits<float>::infinity()
            : std::numeric_limits<float>::quiet_NaN();
    } else {
        decoded = std::ldexp(
            1.0f + static_cast<float>(mantissa) / 1024.0f,
            static_cast<int>(exponent) - 15);
    }
    if (negative) decoded = -decoded;
    return static_cast<std::uint8_t>(
        std::lround(std::clamp(decoded, 0.0f, 1.0f) * 255.0f));
}

inline std::uint16_t float_to_half(float value) {
    std::uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    const std::uint16_t sign =
        static_cast<std::uint16_t>((bits >> 16) & 0x8000u);
    const std::uint32_t exponent = (bits >> 23) & 0xffu;
    const std::uint32_t mantissa = bits & 0x7fffffu;
    if (exponent == 0xffu) {
        return static_cast<std::uint16_t>(
            sign | (mantissa == 0 ? 0x7c00u : 0x7e00u));
    }
    const int half_exponent =
        static_cast<int>(exponent) - 127 + 15;
    if (half_exponent >= 0x1f) {
        return static_cast<std::uint16_t>(sign | 0x7c00u);
    }
    if (half_exponent <= 0) {
        if (half_exponent < -10) return sign;
        const std::uint32_t normalized = mantissa | 0x800000u;
        const int shift = 14 - half_exponent;
        const std::uint32_t rounded =
            (
                normalized +
                (1u << (shift - 1)) -
                1u +
                ((normalized >> shift) & 1u)) >>
            shift;
        return static_cast<std::uint16_t>(sign | rounded);
    }
    const std::uint32_t rounded =
        mantissa + 0xfffu + ((mantissa >> 13) & 1u);
    if ((rounded & 0x800000u) != 0) {
        const int next_exponent = half_exponent + 1;
        return static_cast<std::uint16_t>(
            next_exponent >= 0x1f
                ? sign | 0x7c00u
                : sign |
                    static_cast<std::uint16_t>(
                        next_exponent << 10));
    }
    return static_cast<std::uint16_t>(
        sign |
        static_cast<std::uint16_t>(half_exponent << 10) |
        static_cast<std::uint16_t>(rounded >> 13));
}

} // namespace bbl::pal

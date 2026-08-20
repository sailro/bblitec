// Vertex packing shared by the SDL_GPU and Dawn render backends.
// Moved verbatim from pal_sdl_gpu.cpp so both backends upload
// byte-identical vertex data.
#pragma once

#include <bblite/pal.hpp>
#include <bblite/pal_image.hpp>
#include <bblite/runtime.hpp>
#include <bblite/ts_runtime.hpp>
#include <bblite/upstream/render_capabilities.hpp>
// The generated material texture-slot table both render backends execute:
// which record field fills each slot, its sRGB rule, its fallback texel and
// the pinned binding names it serves. Emitted for every scene beside the
// capability defines, so the include is unconditional.
#include <bblite/upstream/material_texture_slots.hpp>
// The render plan is generated only for scenes that register a
// SceneContext; a sprite-only scene has none, and reaches this header for
// the frame options, capture gate and clock alone.
#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
#include <bblite/upstream/renderer_plan.hpp>
#endif
// Babylon Lite's own composed PBR variants: one entry per material feature
// set the scene's assets reach, each naming its compiled stages and the byte
// size of the per-variant material UBO the pin declares for it. Included here
// because both backends will bind them; a scene with no glTF materials
// reaches none and emits no header.
#if BBLITE_PBR_VARIANTS > 0
#include <bblite/upstream/pbr_variants.hpp>
#endif
// The Standard family's composed variants: the same shape, one entry per
// feature word the scene's materials and meshes reach, plus the selector and
// lowered UBO writers its support block appends. When no pbr_variants.hpp is
// emitted the header hoists the shared scene/lights/mesh mirrors itself, so
// the include order here (after the PBR header) is what keeps one definition.
#if BBLITE_STANDARD_VARIANTS > 0
#include <bblite/upstream/standard_variants.hpp>
#endif
// The node family's compiled graphs: one entry per graph the scene parsed,
// each naming its stages, its vertex inputs and its uniform block. It hoists
// the shared scene/lights mirrors when neither header above is emitted, so
// the include order continues the same one-definition rule.
#if BBLITE_NODE_VARIANTS > 0
#include <bblite/upstream/node_variants.hpp>
#endif

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace bbl::pal {

/**
 * Whether another task binds this geometry task's depth.
 *
 * The pin hands that depth over as an eager wrapper target, so the borrowing
 * pass loads it — which only works if the task that wrote it stored it. The
 * answer belongs to the frame graph, so it is settled once with the task's
 * textures rather than re-scanned per frame.
 */
inline bool geometry_depth_is_borrowed(
    const Engine& engine,
    std::size_t task) {
    for (const FrameTaskRecord& record : engine.frame_tasks) {
        if (
            record.kind == FrameTaskKind::render &&
            record.render.depth.source ==
                RenderTextureSource::geometry_depth &&
            record.render.depth.task.value == task) {
            return true;
        }
    }
    return false;
}


/**
 * The pin's `gpUniforms` block, declared by a geometry-output variant whose
 * attachments include NORMALIZED_VIEW_DEPTH or LINEAR_VELOCITY
 * (`pbr-geometry-output-shader.ts` createPbrGeometryParamsFragment):
 * the task's previous-frame view-projection and the camera's near/far.
 * Unguarded because the geometry encode names it in both backends whatever
 * the variant count.
 */
struct PinnedGeometryParams {
    std::array<float, 16> previousViewProjection{};
    std::array<float, 4> cameraNearFar{};
};

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
#if BBLITE_PBR_VARIANTS > 0
    // The pin's own skinned vertex stage takes joint indices as integers where
    // the transcribed one takes them as floats. Both are carried while the two
    // paths coexist, and this sits last so no existing attribute offset moves;
    // the float pair goes away with the transcription.
    std::uint32_t joint_indices[4];
#endif
#endif
};
#if BBLITE_GPU_DEFORMATION && BBLITE_PBR_VARIANTS > 0
static_assert(sizeof(GpuVertex) == 216);
#elif BBLITE_GPU_DEFORMATION
static_assert(sizeof(GpuVertex) == 200);
#else
static_assert(sizeof(GpuVertex) == 96);
#endif

// The generated `material_texture_slots` table's enums, translated against
// the record once for both backends. Everything a slot *means* — which
// field, which sRGB view, which fallback texel, which pinned names — is
// table data; what stays per backend is upload mechanics and the
// enum→API residue.

/** The record field one slot reads, or nullptr when the family has none. */
inline const TextureData* material_slot_texture(
    const MaterialRecord& material,
    upstream::MaterialTextureSource source,
    bool standard_material) {
    using Source = upstream::MaterialTextureSource;
    switch (source) {
        case Source::base_color:
            return &material.base_color_texture;
        case Source::specular_or_metallic_roughness:
            return standard_material
                ? &material.specular_texture
                : &material.metallic_roughness_texture;
        case Source::opacity_or_normal:
            return standard_material
                ? &material.opacity_texture
                : &material.normal_texture;
        case Source::ambient_or_emissive:
            return standard_material
                ? &material.ambient_texture
                : &material.emissive_texture;
        case Source::standard_emissive:
            return standard_material ? &material.emissive_texture : nullptr;
        case Source::spec_gloss:
            return standard_material ? nullptr : &material.spec_gloss_texture;
        case Source::transmission:
            return standard_material
                ? nullptr
                : &material.transmission_texture;
        case Source::thickness:
            return standard_material ? nullptr : &material.thickness_texture;
        case Source::clearcoat:
            return standard_material ? nullptr : &material.clearcoat_texture;
        case Source::clearcoat_roughness:
            return standard_material
                ? nullptr
                : &material.clearcoat_roughness_texture;
        case Source::clearcoat_normal:
            return standard_material
                ? nullptr
                : &material.clearcoat_normal_texture;
        case Source::sheen_color:
            return standard_material
                ? nullptr
                : &material.sheen_color_texture;
        case Source::sheen_roughness:
            return standard_material
                ? nullptr
                : &material.sheen_roughness_texture;
        case Source::iridescence:
            return standard_material
                ? nullptr
                : &material.iridescence_texture;
        case Source::iridescence_thickness:
            return standard_material
                ? nullptr
                : &material.iridescence_thickness_texture;
        case Source::occlusion_uv2:
            return !standard_material && material.occlusion_texture_uv2
                ? &material.occlusion_texture
                : nullptr;
        case Source::standard_bump:
            return standard_material ? &material.bump_texture : nullptr;
        case Source::standard_reflection:
            return standard_material
                ? &material.reflection_texture
                : nullptr;
        // Scene-owned resources carry no record field.
        case Source::environment_cube:
        case Source::brdf_lut:
        case Source::scene_color:
        case Source::bone_palette:
            return nullptr;
    }
    return nullptr;
}

/** Whether one slot uploads through an sRGB view, per the table's rule. */
inline bool material_slot_srgb(
    upstream::MaterialTextureSrgb rule,
    const TextureData* data,
    const MaterialRecord* material,
    bool standard_material) {
    switch (rule) {
        case upstream::MaterialTextureSrgb::linear:
            return false;
        case upstream::MaterialTextureSrgb::srgb:
            return true;
        case upstream::MaterialTextureSrgb::srgb_unless_standard:
            return !standard_material;
        case upstream::MaterialTextureSrgb::base_color:
            // A slot with image bytes keeps the sRGB contract; a bare
            // fallback texel takes the material's own encoding -- the pin's
            // scene-code solid textures are rgba8unorm, sampled without
            // decode.
            return !standard_material &&
                (data && !data->bytes.empty()
                     ? true
                     : material == nullptr ||
                         material->base_color_fallback_srgb);
    }
    return false;
}

/** The 1x1 texel an image-less slot uploads, per the table's rule. */
inline std::array<std::uint8_t, 4> material_slot_fallback(
    upstream::MaterialTextureFallback rule,
    const MaterialRecord* material,
    bool standard_material) {
    constexpr std::array<std::uint8_t, 4> white_texel{255, 255, 255, 255};
    constexpr std::array<std::uint8_t, 4> black_texel{0, 0, 0, 255};
    // A flat tangent-space normal, so a material with no map reads
    // (0, 0, 1) out of the sample and keeps its interpolated normal.
    constexpr std::array<std::uint8_t, 4> flat_normal_texel{
        128, 128, 255, 255};
    switch (rule) {
        case upstream::MaterialTextureFallback::white:
            return white_texel;
        case upstream::MaterialTextureFallback::black:
            return black_texel;
        case upstream::MaterialTextureFallback::flat_normal:
            return flat_normal_texel;
        case upstream::MaterialTextureFallback::white_or_flat_normal:
            return standard_material ? white_texel : flat_normal_texel;
        case upstream::MaterialTextureFallback::base_color_record:
            return !standard_material && material
                ? material->base_color_fallback
                : white_texel;
        case upstream::MaterialTextureFallback::orm_record:
            // The pinned ORM factor texel, so an animated metallic or
            // roughness factor multiplies the authored value rather than
            // white. Standard materials never carry one.
            return !standard_material && material
                ? material->orm_fallback
                : white_texel;
        case upstream::MaterialTextureFallback::white_or_emissive_factor: {
            if (standard_material) return white_texel;
            const bool has_emissive_factor = material &&
                (material->emissive_factor.r != 0.0f ||
                 material->emissive_factor.g != 0.0f ||
                 material->emissive_factor.b != 0.0f);
            return has_emissive_factor ? white_texel : black_texel;
        }
    }
    return white_texel;
}

/**
 * The table row serving one of the pin's own binding names, or nullptr.
 *
 * The names are Babylon's, the rows are generated, and this is where the
 * two meet for both backends' pinned bind paths. A variant that declares a
 * resource the table does not know fails by name rather than sampling
 * whatever sat at that index.
 */
inline const upstream::MaterialTextureSlot* material_slot_for_binding(
    std::string_view name) {
    for (
        const upstream::MaterialTextureSlot& slot :
        upstream::material_texture_slots) {
        if (slot.texture_name.empty()) continue;
        if (name == slot.texture_name || name == slot.sampler_name) {
            return &slot;
        }
    }
    return nullptr;
}

/**
 * The table row serving one slot source, or nullptr.
 *
 * The Standard family's generated `standard_binding_resources` rows carry
 * the pin's own std binding names (`dT`, `oT`, `rT`, ...) while the slot
 * table's names are the PBR pinned bindings, so a Standard row cannot be
 * resolved by name -- its declared `source` is the join key (the row
 * comment in pinned-standard-variants.ts says exactly that: a
 * "material_texture_slots row source").
 */
inline const upstream::MaterialTextureSlot* material_slot_for_source(
    upstream::MaterialTextureSource source) {
    for (
        const upstream::MaterialTextureSlot& slot :
        upstream::material_texture_slots) {
        if (slot.source == source) {
            return &slot;
        }
    }
    return nullptr;
}

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
#if BBLITE_PBR_VARIANTS > 0
            {
                static_cast<std::uint32_t>(vertex.joints[0]),
                static_cast<std::uint32_t>(vertex.joints[1]),
                static_cast<std::uint32_t>(vertex.joints[2]),
                static_cast<std::uint32_t>(vertex.joints[3]),
            },
#endif
#endif
        });
    }
    return result;
}

/**
 * One background-plan vertex (the skybox and ground quads) in GpuVertex
 * layout: the local-normal lane mirrors the normal and every deformation
 * lane stays zero. Both backends upload the plan quads from this one
 * packing, so the vertex bytes cannot differ between them.
 */
inline GpuVertex gpu_vertex_from(const ModelVertex& vertex) {
    return GpuVertex{
        {vertex.position.x, vertex.position.y, vertex.position.z},
        {vertex.normal.x, vertex.normal.y, vertex.normal.z},
        {
            vertex.tangent.x,
            vertex.tangent.y,
            vertex.tangent.z,
            vertex.tangent.w,
        },
        {vertex.uv.x, vertex.uv.y},
        {
            vertex.local_position.x,
            vertex.local_position.y,
            vertex.local_position.z,
        },
        {vertex.uv2.x, vertex.uv2.y},
        {vertex.color.x, vertex.color.y, vertex.color.z, vertex.color.w},
        {vertex.normal.x, vertex.normal.y, vertex.normal.z},
    };
}

#if BBLITE_PBR_VARIANTS > 0
/**
 * The same vertices in Babylon's own convention.
 *
 * Two facts make this necessary rather than cosmetic. The loader stores a glTF
 * mesh through the native X mirror and reconciles `tangent.w` against it, where
 * Babylon keeps position, normal and tangent unmirrored and carries the mirror
 * in the mesh block's world matrix -- the browser's own block for Scene 7 is
 * `diag(-1, 1, 1, 1)`, not the identity. And a mirror flips handedness, so a
 * bitangent built with `cross()` inside the pin's own vertex stage comes out
 * negated when it is fed pre-mirrored data. Undoing the mirror here, and pairing
 * it with the mirroring world matrix, is what lets the pin's stage run unedited.
 *
 * The morph deltas carry the same mirror and are undone with it.
 */
inline std::vector<GpuVertex> pinned_convention_vertices(
    const std::vector<GpuVertex>& source,
    bool mirrored_x) {
    std::vector<GpuVertex> result = source;
    for (GpuVertex& vertex : result) {
        vertex.position[0] = -vertex.position[0];
        vertex.normal[0] = -vertex.normal[0];
        vertex.tangent[0] = -vertex.tangent[0];
        // The local lanes stay untouched: the loader stores them RAW from
        // the glTF (no native mirror), which is exactly the pin's own
        // convention -- the LOCAL_POSITION geometry arm reads them as the
        // browser reads its unmirrored attribute.
        // `gltf-loader` multiplies the authored sign by -1 for a right-handed
        // node and by +1 for a mirrored one; the pin's stage wants the authored
        // value, so the same factor undoes it.
        vertex.tangent[3] *= mirrored_x ? 1.0f : -1.0f;
#if BBLITE_GPU_DEFORMATION
        vertex.morph_position_0[0] = -vertex.morph_position_0[0];
        vertex.morph_position_1[0] = -vertex.morph_position_1[0];
        vertex.morph_normal_0[0] = -vertex.morph_normal_0[0];
        vertex.morph_normal_1[0] = -vertex.morph_normal_1[0];
        vertex.morph_tangent_0[0] = -vertex.morph_tangent_0[0];
        vertex.morph_tangent_1[0] = -vertex.morph_tangent_1[0];
#endif
    }
    return result;
}

/**
 * The record's instance matrices in Babylon's own convention. The glTF
 * loader stores EXT_mesh_gpu_instancing matrices through `native_matrix`
 * -- the X-mirror conjugation M*A*M -- where the pin uploads the authored
 * values and carries the mirror in the mesh block's world; the conjugation
 * is involutive, so applying it again recovers them. Scene-code thin
 * instances adopt the caller's floats verbatim -- the same floats the
 * pin's own setThinInstances receives -- so they pass through untouched.
 * `thin_instanced` is stamped by both, so the discriminator is
 * `instance_source`, which only the scene-code setter fills.
 */
inline std::vector<std::array<float, 16>> pinned_instance_matrices(
    const MeshRecord& record) {
    std::vector<std::array<float, 16>> result = record.instance_matrices;
    if (record.instance_source != nullptr) return result;
    for (std::array<float, 16>& matrix : result) {
        for (std::size_t column = 0; column < 4; ++column) {
            for (std::size_t row = 0; row < 4; ++row) {
                if ((row == 0) != (column == 0)) {
                    matrix[column * 4 + row] =
                        -matrix[column * 4 + row];
                }
            }
        }
    }
    return result;
}

#endif

#if BBLITE_PINNED_MATERIALS
/**
 * Where one of Babylon Lite's own vertex-input names sits in our vertex.
 *
 * All three composed families declare their inputs by the pin's names, and
 * the pin numbers the locations densely per variant — an unskinned stage puts
 * nothing where a skinned one puts `joints`. So a PAL resolves each declared
 * name against the vertex we pack, and the table that answers it is a
 * property of `GpuVertex` rather than of a family or a backend.
 *
 * `lane` is the shape, which each backend maps to its own format enum;
 * `instance_stream` marks the thin-instance matrix columns, which come from a
 * second, instance-stepped buffer rather than from the vertex.
 */
enum class VertexInputLane {
    float2,
    float3,
    float4,
    uint4,
};

struct PinnedVertexInput {
    VertexInputLane lane = VertexInputLane::float3;
    std::uint64_t offset = 0;
    bool instance_stream = false;
    /** False when this vertex carries nothing under that name. */
    bool mapped = false;
};

/**
 * Resolve one declared input. `local_position` is the arm a LOCAL_POSITION
 * geometry variant takes: its varying reads the raw attribute, so the draw
 * binds the vertex's local lanes and its mesh block carries the real node
 * world.
 */
inline PinnedVertexInput pinned_vertex_input(
    std::string_view name,
    bool uses_local_position) {
    const auto at = [](VertexInputLane lane, std::size_t offset) {
        return PinnedVertexInput{
            lane,
            static_cast<std::uint64_t>(offset),
            false,
            true,
        };
    };
    if (name == "position") {
        return at(
            VertexInputLane::float3,
            uses_local_position ? offsetof(GpuVertex, local_position)
                                : offsetof(GpuVertex, position));
    }
    if (name == "normal") {
        return at(VertexInputLane::float3, offsetof(GpuVertex, normal));
    }
    if (name == "tangent") {
        return at(VertexInputLane::float4, offsetof(GpuVertex, tangent));
    }
    if (name == "uv") {
        return at(VertexInputLane::float2, offsetof(GpuVertex, uv));
    }
    if (name == "uv2") {
        return at(VertexInputLane::float2, offsetof(GpuVertex, uv2));
    }
    if (name == "color") {
        return at(VertexInputLane::float4, offsetof(GpuVertex, color));
    }
    // The pin's thin-instance arm reads the per-instance matrix as four vec4
    // columns from its own stream, so the offset is into that buffer.
    if (
        name == "world0" || name == "world1" || name == "world2" ||
        name == "world3") {
        return PinnedVertexInput{
            VertexInputLane::float4,
            static_cast<std::uint64_t>(16 * (name.back() - '0')),
            true,
            true,
        };
    }
#if BBLITE_GPU_DEFORMATION
    if (name == "weights") {
        return at(VertexInputLane::float4, offsetof(GpuVertex, weights));
    }
#if BBLITE_PBR_VARIANTS > 0
    // The pin takes joint indices as integers; the transcribed stage takes
    // them as floats, so the vertex carries both while the two coexist.
    if (name == "joints") {
        return at(VertexInputLane::uint4, offsetof(GpuVertex, joint_indices));
    }
#endif
#endif
    return PinnedVertexInput{};
}
#endif

#if BBLITE_PINNED_MATERIAL_VARIANTS
/** Whether a record draws through the pin's thin-instance arm: stamped by
 *  the scene setter or filled by the glTF EXT_mesh_gpu_instancing pool. */
inline bool pinned_record_instanced(const MeshRecord& record) {
    return record.thin_instanced || !record.instance_matrices.empty();
}

/**
 * Whether a task's draw lists contain a draw the pinned path owns — a PBR
 * draw, or a Standard one now that both families run Babylon's own composed
 * stages. A geometry task with none writes no pinned blocks at all. It lives
 * here rather than in the backend that asks: SDL_GPU stopped needing it when
 * the depth convention collapsed and the matrix seam went with it, and the
 * question is the backends' shared one whenever either asks it again.
 */
inline bool pinned_lists_have_pinned_draws(
    const upstream::RenderDrawLists& lists) {
    for (const upstream::RenderDrawList* list :
         {&lists.opaque, &lists.transparent}) {
        for (const upstream::RenderDrawCommand& draw : list->commands) {
            if (
                draw.item.material_kind ==
                    upstream::RenderMaterialKind::pbr ||
                draw.item.material_kind ==
                    upstream::RenderMaterialKind::standard) {
                return true;
            }
        }
    }
    return false;
}
#endif

#if BBLITE_PINNED_MATERIALS

/** The identity, for a skinned draw whose palette already carries everything,
 *  and for the two families whose vertices are baked with their world. */
inline std::array<float, 16> pinned_identity_world() {
    return {
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    };
}

#endif

#if BBLITE_PBR_VARIANTS > 0
/** The pin's own per-mesh world matrix: the mirror its vertices do not carry. */
inline std::array<float, 16> pinned_mesh_world() {
    return {
        -1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    };
}

/**
 * The pin's mesh world for a thin-instanced draw: the instanced node's own
 * world in Babylon's convention.
 *
 * The pin composes `finalWorld = mesh.world * instanceWorld`, and its
 * `mesh.world` is the root mirror times the node matrix -- Scene 247's
 * instanced node carries a y-scale of 1.3 that way. The record stores the
 * node world through `native_matrix` (the mirror conjugation), so the
 * mirror-times-node product is the stored matrix times the mirror: with
 * column vectors that is the parent matrix with its first column negated.
 * An identity node collapses this to `pinned_mesh_world()`.
 */
inline std::array<float, 16> pinned_instanced_world(
    const MeshRecord& record) {
    std::array<float, 16> world = record.instance_parent_matrix;
    world[0] = -world[0];
    world[1] = -world[1];
    world[2] = -world[2];
    world[3] = -world[3];
    return world;
}

/**
 * The pin's mesh-block world for one draw, whichever convention arm it rides.
 *
 * Skinned draws take the identity (the palette carries everything), an
 * animated no-skin mesh takes its single palette entry as the pin's
 * finalWorld, a thin-instanced or LOCAL_POSITION draw takes the real node
 * world beside unbaked position data, and everything else takes the bare
 * mirror over baked vertices. Shared because the same chain decides the
 * block in the SDL draw and both of Dawn's write sites.
 */
inline std::array<float, 16> pinned_draw_world(
    bool skeleton_draw,
    bool world_from_palette,
    bool uses_local_position,
    const MeshRecord& record) {
    if (skeleton_draw) return pinned_identity_world();
    if (world_from_palette) return record.bone_matrices[0];
    if (uses_local_position || pinned_record_instanced(record)) {
        return pinned_instanced_world(record);
    }
    return pinned_mesh_world();
}
#endif

#if BBLITE_PINNED_MATERIALS
/**
 * The pin's per-pass scene block.
 *
 * Every member is the one the pin's own declaration names; the fragment reads
 * its view direction from `vEyePosition` and its reflection path from `view`,
 * both from the camera the pass renders with. Shared, because the block is the
 * pin's rather than either backend's: Dawn uploads it to a buffer and SDL_GPU
 * pushes it at a uniform slot, and neither should decide what is in it.
 */
inline upstream::SceneUniforms pinned_scene_block(
    const Scene& scene,
    const Engine& engine,
    const CameraRecord& camera,
    const std::array<float, 16>& view_projection) {
    upstream::SceneUniforms scene_block{};
    scene_block.viewProjection = view_projection;
    // The pin's fragment reads the view direction from `vEyePosition`, and its
    // reflection path from `view`. Both come from the camera the pass renders
    // with, the same one `build_pbr_uniforms` reads.
    const std::array<float, 16> camera_world =
        upstream::camera_world_matrix(camera);
    scene_block.vEyePosition = {
        camera_world[12],
        camera_world[13],
        camera_world[14],
        1.0f,
    };
    scene_block.view = upstream::build_view_matrix(camera_world);
    scene_block.envRotationY = scene.environment.rotation_y;
    // `vImageInfos` is documented in the pin's own declaration as
    // exposureLinear, contrast, lodGenerationScale, toneMappingEnabled.
    scene_block.vImageInfos = {
        scene.environment.exposure,
        scene.environment.contrast,
        scene.environment.lod_generation_scale,
        // The pin's executeRenderTaskLinear stamps toneMappingEnabled = -1
        // while a transmission scene's retargeted linear passes run; every
        // composed fragment then skips its processing tail
        // (`if(scene.vImageInfos.w>=0.0)`) and the trailing
        // image-processing pass applies it once. The captured browser block
        // carries the same -1 (scene30 buffer#1).
        scene.transmission_enabled
            ? -1.0f
            : scene.environment.tone_mapping_enabled ? 1.0f : 0.0f,
    };
    scene_block.vFogInfos = {
        scene.fog_mode,
        scene.fog_start,
        scene.fog_end,
        scene.fog_density,
    };
    // `_packSceneUniforms` writes the canvas size into the block's two spare
    // lanes -- `vFogColor.w` and `_envPad0` -- for every scene, and a node
    // graph's ScreenSizeBlock is what reads them back. The size is the
    // engine's configured one, which is what `eng.canvas` reports.
    scene_block.vFogColor = {
        scene.fog_color.r,
        scene.fog_color.g,
        scene.fog_color.b,
        static_cast<float>(engine.options.width),
    };
    scene_block._envPad0 = static_cast<float>(engine.options.height);
    const std::array<std::array<float, 4>*, 9> harmonics{
        &scene_block.vSphericalL00,
        &scene_block.vSphericalL1_1,
        &scene_block.vSphericalL10,
        &scene_block.vSphericalL11,
        &scene_block.vSphericalL2_2,
        &scene_block.vSphericalL2_1,
        &scene_block.vSphericalL20,
        &scene_block.vSphericalL21,
        &scene_block.vSphericalL22,
    };
    for (std::size_t index = 0; index < harmonics.size(); ++index) {
        const Color3& band = scene.environment.spherical_harmonics[index];
        *harmonics[index] = {band.r, band.g, band.b, 0.0f};
    }
    return scene_block;
}

/**
 * The pin's per-pass lights block: a u32 count, three words of padding, then
 * MAX_LIGHTS entries.
 *
 * `fillLightsData` writes that count through a Float32Array view of the same
 * buffer, so it lands in the first four bytes. Returned as bytes because that is
 * what both a buffer upload and a uniform push take.
 */
inline std::vector<std::uint8_t> pinned_lights_block(
    const Scene& scene,
    const Engine& engine) {
    std::array<std::uint32_t, 4> header{};
    std::vector<upstream::LightEntry> entries(upstream::pinned_max_lights);
    std::uint32_t count = 0;
    for (const LightHandle handle : scene.lights) {
        if (count >= upstream::pinned_max_lights) break;
        if (handle.value >= engine.lights.size()) continue;
        const LightRecord& light = engine.lights[handle.value];
        // Which writer each kind takes is generated: the scene compiles arms
        // only for the kinds it reaches, so the mapping cannot be restated here.
        upstream::write_pinned_light(light, entries[count]);
        ++count;
    }
    header[0] = count;
    std::vector<std::uint8_t> bytes(
        sizeof(header) + entries.size() * sizeof(upstream::LightEntry));
    std::memcpy(bytes.data(), header.data(), sizeof(header));
    std::memcpy(
        bytes.data() + sizeof(header),
        entries.data(),
        entries.size() * sizeof(upstream::LightEntry));
    return bytes;
}

// The pin's per-draw mesh block.
//
// `writeMeshLightSelection` decides its shape: the world matrix, the count of
// lights affecting this mesh, then their indices. Which lights those are comes
// from the generated `light_affects_mesh`, lowered from the pin's own
// `affectsMesh`, so this walks exactly the set the Standard slot writer walks.
/**
 * The pin's own per-mesh light selection (`writeMeshLightSelection`).
 *
 * Shared because the mesh block is not one struct: the material families
 * declare `MeshUniforms` and a node graph declares its own `MeshU` with a
 * shadow lane between the world matrix and the count. What they agree on is
 * this walk, so it is written once over whichever block's lanes.
 */
template <typename Block>
inline void pinned_mesh_light_selection(
    const Scene& scene,
    const Engine& engine,
    std::uint32_t mesh_index,
    Block& block) {
    std::uint32_t count = 0;
    std::uint32_t light_index = 0;
    for (const LightHandle handle : scene.lights) {
        if (light_index >= upstream::pinned_max_lights) break;
        if (handle.value >= engine.lights.size()) continue;
        if (
            upstream::light_affects_mesh(
                engine.lights[handle.value],
                mesh_index)) {
            block.li[count / 4][count % 4] = light_index;
            ++count;
        }
        ++light_index;
    }
    block.lc = count;
}

#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_VARIANTS > 0
inline upstream::MeshUniforms pinned_mesh_block(
    const Scene& scene,
    const Engine& engine,
    const std::array<float, 16>& world,
    std::uint32_t mesh_index) {
    upstream::MeshUniforms block{};
    block.world = world;
    pinned_mesh_light_selection(scene, engine, mesh_index, block);
    // The velocity geometry arm's tail. The native worlds are constant
    // frame to frame (node motion re-bakes vertices), so the previous
    // world is the world itself and the flag stays on: the composed
    // vertex then measures camera motion, which is what the pin's
    // tracked previous clip reduces to for a static world. The generic
    // lambda makes the access dependent: outside a template, both
    // `if constexpr` branches must compile, and most scenes' mirrored
    // MeshUniforms carries no velocity tail.
    [&](auto& dependent) {
        if constexpr (
            requires {
                dependent.previousWorld;
                dependent.velocityEnabled;
            }) {
            dependent.previousWorld = world;
            dependent.velocityEnabled = 1.0f;
        }
    }(block);
    return block;
}
#endif

#if BBLITE_NODE_VARIANTS > 0
/**
 * A node graph's per-draw mesh block (`node-renderable.ts`).
 *
 * The pin packs the mesh's world matrix, `receiveShadows ? 1 : 0` in the
 * shadow lane, and the same light selection every family uses. The world is
 * the identity because our vertices are baked with it, exactly as the
 * Standard family's are — `receiveShadows` has no lowered setter, so the
 * lane is the pin's own default.
 */
inline upstream::NodeMeshUniforms node_mesh_block(
    const Scene& scene,
    const Engine& engine,
    std::uint32_t mesh_index) {
    upstream::NodeMeshUniforms block{};
    block.world = pinned_identity_world();
    pinned_mesh_light_selection(scene, engine, mesh_index, block);
    return block;
}
#endif
#endif

#if BBLITE_PBR_VARIANTS > 0

/**
 * The variant a draw composes, or `npos` when this scene cannot resolve one.
 *
 * The key is the pin's own: the material, the mesh's attributes, the light mode
 * with its single-light kind, and whether tone mapping is on. Two halves come
 * from generation because a PAL cannot recover them — the glTF material index,
 * which is a MaterialHandle only while every material comes from the composed
 * asset, and the attribute set, because our geometry record does not carry uv2
 * or vertex-colour presence. Both are checked rather than assumed: an
 * unresolved draw returns `npos` and takes the transcribed path.
 */
/**
 * Whether a composed variant has been measured to match, by property.
 *
 * The whole point of executing Babylon's own stages is that a difference is a
 * difference in inputs, not in a formula -- so a variant runs here only once the
 * inputs it needs have been measured against the browser's own buffers. Every
 * disqualifier below names an open measurement rather than a scene:
 *
 *  - an extension arm: each contributes its own material-UBO fields through a
 *    lowered writer that no capture has been diffed against.
 *  - `skeleton`: measured, not resolved. The browser's own palette for Scene 7 is
 *    `diag(100, 100, 100, 1)` (its bone texture upload in
 *    `artifacts/capture/scene7/tex-uploads.json`, rgba32float 48x1), so it
 *    carries no mirror and the loader's `native_matrix` conjugation is a no-op on
 *    it; the mesh block carries the mirror instead. Both vertex conventions were
 *    tried against that -- unmirrored 2.522 MAD, mirrored 1.954, against 0.056
 *    transcribed -- so neither the palette nor the mirror is the remaining
 *    difference. The next measurement is our own palette and mesh block dumped
 *    and diffed against those two captured buffers, not more algebra.
 *  - refraction: needs the scene-colour grab bound through the pin's own
 *    mid-pass break rather than our slot order.
 *  - skeleton or morph: the palette and the morph deltas both carry the mirror.
 *
 * Everything else takes the transcribed path, so widening this list is a
 * measurement rather than a rewrite.
 *
 * Shared by both backends: which draws Babylon's own stages can run is a
 * property of the scene and the variant, not of the API binding them, so a
 * second copy could only drift.
 */
/** Whether a variant's vertex stage samples the bone palette. */
inline bool pinned_variant_skeleton(std::size_t variant) {
    return upstream::pbr_variants[variant].key.find("skeleton") !=
        std::string_view::npos;
}

inline std::size_t pinned_variant_for_draw(
    const Scene& scene,
    const Engine& engine,
    const upstream::RenderDrawCommand& draw,
    // The geometry-output task the draw belongs to, npos for the colour
    // passes: the selector table keys on it, so a geometry draw resolves
    // its own MRT arm and never a colour variant.
    std::size_t geometry_task = std::numeric_limits<std::size_t>::max()) {
    if (upstream::pbr_variants.empty()) {
        return std::numeric_limits<std::size_t>::max();
    }
    if (draw.item.material_kind != upstream::RenderMaterialKind::pbr) {
        return std::numeric_limits<std::size_t>::max();
    }
    // Scene code that creates its own material shifts every handle away from
    // the glTF index the table is keyed by, so the correspondence is only used
    // when the engine holds exactly the asset's materials.
    if (engine.materials.size() != upstream::pbr_variant_material_count) {
        return std::numeric_limits<std::size_t>::max();
    }
    // A mesh whose node transform is not baked into its vertices carries it
    // in the record's parent matrix, which the composed stages consume; a
    // record without it cannot resolve a variant and errors at the draw.
    bool has_bones = false;
    if (draw.item.mesh.value < engine.meshes.size()) {
        const MeshRecord& record = engine.meshes[draw.item.mesh.value];
        // An animated node needs no guard: the PAL re-transforms its vertices
        // on the CPU when `transform_version` moves, so the GPU always sees
        // world space and the pin's `finalWorld` stays the identity. An
        // instanced mesh resolves the pin's own thin-instance arm -- its
        // renderable features carry MSH_HAS_THIN_INSTANCES -- and the draw
        // binds the per-instance matrix buffer as the arm's second stream.
        // `bone_matrices` is not only a skin: the glTF loader pushes the mesh's
        // own world matrix into it for an *animated* mesh with no skin at all,
        // and the transcribed vertex stage takes the transform from there. A
        // non-skeleton variant reads no palette, so such a draw would lose its
        // animation — Scenes 39, 242 and 254 measured 4.2 to 11.9 MAD that way
        // against 0.000 transcribed. A skeleton variant reads the palette the
        // pin's own stage samples, so the check keys on the resolved variant
        // below rather than refusing every mesh that carries bones. Skins need
        // no `transform_version` guard either, animated node or not: the
        // pin's updater conjugates `invMeshWorld` into the palette at bind
        // time and excludes skinned-mesh nodes from scene-graph animation, so
        // every node motion a skin can see arrives through the joint worlds
        // our palette already carries. The 2.5 and 4.5 MAD once filed against
        // node-animated skins were the missing flat-normal fragment arm --
        // Scenes 255 and 245 measure 0.000 on both backends through this path
        // with the arm composed, and Scene 7 measures its pinned 0.047
        // against 0.056 transcribed.
        if (!record.bone_matrices.empty()) {
            has_bones = true;
        }
    }
    const std::uint32_t material_index = draw.item.material.value;
    // The mesh half of the key comes per renderable: generation writes one
    // entry per runtime mesh handle in the loader's own creation order, so a
    // material drawn under two attribute sets resolves each mesh's own
    // variant instead of collapsing to the per-material ambiguity.
    const std::size_t mesh_features =
        draw.item.mesh.value <
            upstream::pbr_renderable_mesh_features.size()
            ? upstream::pbr_renderable_mesh_features[draw.item.mesh.value]
            // Scene code can keep creating meshes after registration, all
            // from the fixed-set builders; a scene whose builders disagree
            // publishes npos here and such a draw refuses.
            : upstream::pbr_runtime_mesh_features;
    if (mesh_features == std::numeric_limits<std::size_t>::max()) {
        return std::numeric_limits<std::size_t>::max();
    }
    // The light mode, walked the way `writeMeshLightSelection` walks it: how
    // many of the scene's lights affect this mesh decides which arm the pin
    // composed. Shadow receivers always take the loop, which the corpus does
    // not reach on this path yet.
    std::uint32_t light_count = 0;
    std::string_view single_light_type;
    for (const LightHandle handle : scene.lights) {
        if (handle.value >= engine.lights.size()) continue;
        const LightRecord& light = engine.lights[handle.value];
        if (!upstream::light_affects_mesh(light, draw.item.mesh.value)) {
            continue;
        }
        ++light_count;
        single_light_type = upstream::pinned_single_light_type(light);
    }
    const std::uint32_t light_mode =
        light_count == 0 ? 0u : light_count == 1 ? 1u : 2u;
    if (light_mode != 1) single_light_type = "";
    // Every light mode. All three read the same lights block, whose writers index
    // the pin's own light world matrix; the block itself was diffed against the
    // browser's (`artifacts/capture/scene7/buffers.json`, 1040 bytes beside the
    // 368-byte scene block).
    // A transmission scene resolves the same table: its materials compose
    // with `_linearImageProcessing` (the pin's markPbrMaterialsLinear), so
    // every fragment guards its processing tail on `vImageInfos.w >= 0` and
    // the linear main pass runs with the lane at -1; the refraction arms
    // bind the existing 1024x1024 scene-colour grab through the variant's
    // own `refractionTexture` slot. The earlier 17.8-MAD refusal here was
    // the guard missing from the composed fragments, not pass structure.
    const std::size_t variant = upstream::pbr_variant_for(
        material_index,
        static_cast<std::uint32_t>(mesh_features),
        light_mode,
        single_light_type,
        scene.environment.tone_mapping_enabled,
        geometry_task);
    if (variant == std::numeric_limits<std::size_t>::max()) {
        return std::numeric_limits<std::size_t>::max();
    }
    // A skeleton variant needs the palette to exist or the deformation is
    // lost. The reverse -- a palette on a non-skeleton variant -- is the
    // animated no-skin mesh, whose single palette entry is the mesh's own
    // world; the draw passes it as the pin's finalWorld against the mirrored
    // buffer, the same convention the skinned draw measured.
    const bool skeleton_variant = pinned_variant_skeleton(variant);
    if (skeleton_variant && !has_bones) {
        return std::numeric_limits<std::size_t>::max();
    }
    return variant;
}

/**
 * The convention arms one pinned draw rides.
 *
 * A skinned draw takes the identity world with the MIRRORED vertex
 * buffer: the loader's palette is the mirror-conjugated
 * `jointWorld * IBM` (`M A M`), so against mirrored vertices the product
 * collapses to the browser's own `M * jointWorld * IBM * v_unmirrored`,
 * and adding the mirror world on top double-applies it -- the finding the
 * Dawn backend's captured mesh blocks localised (world = bare mirror,
 * palette translation 1.66 vs the browser's 0). An animated no-skin mesh
 * rides the same convention with one matrix: its palette entry is
 * `M * world * M`, passed as the pin's finalWorld against the mirrored
 * buffer. Derived once so the backends cannot disagree about which draw
 * takes which arm.
 */
struct PinnedDrawConventions {
    bool skeleton_draw;
    bool world_from_palette;
    bool mirrored_vertices;
};

inline PinnedDrawConventions pinned_draw_conventions(
    std::size_t variant,
    const MeshRecord& record) {
    const bool skeleton_draw = pinned_variant_skeleton(variant);
    const bool world_from_palette =
        !skeleton_draw && !record.bone_matrices.empty();
    return PinnedDrawConventions{
        skeleton_draw,
        world_from_palette,
        skeleton_draw || world_from_palette,
    };
}

/**
 * The pin's bone-palette texture shape: `skeleton-updater.ts` writes
 * `invMeshWorld * jointWorld * IBM` per bone into one rgba32float row,
 * four 16-byte texels per bone. Both backends size and fill their
 * palette texture from this; only the upload mechanics stay per API.
 */
struct BonePaletteLayout {
    std::uint32_t width;
    std::uint32_t height;
    // The whole palette, which for the single row is also the row pitch.
    std::uint32_t bytes;
};

inline BonePaletteLayout bone_palette_layout(std::uint32_t bones) {
    const std::uint32_t width = bones * 4u;
    return BonePaletteLayout{width, 1u, width * 16u};
}
#endif

#if BBLITE_STANDARD_VARIANTS > 0
/** The pair `standard_variant_for` looks a draw up by, or none. */
struct StandardVariantKey {
    std::uint32_t features = 0;
    std::size_t mesh_features = 0;
    bool resolved = false;
};

/**
 * The key a draw composes under.
 *
 * Split from the lookup so a miss can report what it asked for: the two
 * numbers are the whole diagnosis, and recomputing them at the error site
 * would print something subtly different -- the no-color pass bit and the
 * thin-instance and morph mesh bits are ORed on here, after the raw reads.
 */
inline StandardVariantKey standard_variant_key(
    const Engine& engine,
    const upstream::RenderDrawCommand& draw) {
    StandardVariantKey key;
    if (
        draw.item.material_kind !=
            upstream::RenderMaterialKind::standard ||
        draw.item.material.value >= engine.materials.size()) {
        return key;
    }
    const MaterialRecord& material =
        engine.materials[draw.item.material.value];
    key.features = upstream::standard_material_features(material);
    if (material.no_color) {
        key.features |= upstream::standard_no_color_output_flag;
    }
    key.mesh_features =
        draw.item.mesh.value <
            upstream::standard_renderable_mesh_features.size()
            ? upstream::standard_renderable_mesh_features[
                  draw.item.mesh.value]
            : upstream::standard_runtime_mesh_features;
    if (key.mesh_features == std::numeric_limits<std::size_t>::max()) {
        return key;
    }
    if (draw.item.mesh.value < engine.meshes.size()) {
        const MeshRecord& record = engine.meshes[draw.item.mesh.value];
        if (pinned_record_instanced(record)) {
            key.mesh_features |= upstream::std_msh_has_thin_instances;
        }
    }
    if (
        draw.item.geometry < engine.geometries.size() &&
        !engine.geometries[draw.item.geometry].morph_positions.empty()) {
        key.mesh_features |= upstream::std_msh_has_morph_targets;
    }
    key.resolved = true;
    return key;
}

/**
 * What a failed Standard variant lookup was asked for.
 *
 * A miss means the runtime derivation and the composed selector table
 * disagree, which is what an upstream feature-derivation change looks like
 * from here.
 */
inline std::string standard_variant_request(
    const Engine& engine,
    const upstream::RenderDrawCommand& draw) {
    const StandardVariantKey key = standard_variant_key(engine, draw);
    if (!key.resolved) {
        return "no key: the draw names no composable Standard material";
    }
    return "features " + std::to_string(key.features) + ", mesh features " +
        std::to_string(key.mesh_features);
}

/**
 * The Standard variant a draw composes, or `npos` when none was emitted.
 *
 * The key is the pin's own feature word, derived from the record by the
 * generated `standard_material_features` — the same pinned
 * `_computeStandardMaterialFeatures` generation executed to compose — plus
 * the mesh bits: the static per-handle table with the pool and deformation
 * bits ORed on at draw time, because thin instances attach and morph
 * weights arrive after mesh creation. A no-color view's record ORs the
 * pass bit the composition keyed its depth-only rows on.
 */
inline std::size_t standard_variant_for_draw(
    const Scene& scene,
    const Engine& engine,
    const upstream::RenderDrawCommand& draw,
    std::size_t geometry_task = std::numeric_limits<std::size_t>::max()) {
    (void)scene;
    const StandardVariantKey key = standard_variant_key(engine, draw);
    if (!key.resolved) {
        return std::numeric_limits<std::size_t>::max();
    }
    return upstream::standard_variant_for(
        key.features,
        static_cast<std::uint32_t>(key.mesh_features),
        geometry_task);
}

/**
 * The pin's mesh-block world for one Standard draw.
 *
 * The native side bakes a mesh's TRS into its vertices, so the pin's
 * `finalWorld` collapses to the identity — the Standard families carry no
 * glTF X-mirror. A thin-instanced draw keeps local vertices and rides the
 * pin's own `mesh.world * instanceWorld` product, so it takes the record's
 * parent TRS. A LOCAL_POSITION geometry variant reads the raw position
 * attribute, so its draw binds the unbaked local lanes and needs the
 * pin's node world back: the TRS the loader baked away and recorded in
 * `instance_parent_matrix` (the identity for a mesh that never had one —
 * scene 145's browser blocks carry exactly that TRS beside
 * localMatrix-applied vertex uploads, so `world * local` reproduces the
 * baked product). A record whose own transform is live bakes at packing
 * time instead and records no such world, so it is refused by name
 * rather than rendered with a silently-wrong varying.
 */
inline std::array<float, 16> standard_draw_world(
    [[maybe_unused]] const MeshRecord& record,
    bool uses_local_position) {
#if BBLITE_GPU_INSTANCING
    if (pinned_record_instanced(record)) {
        return upstream::build_instance_parent_world(record);
    }
#endif
    if (uses_local_position) {
        const bool identity_transform =
            record.position.x == 0.0f && record.position.y == 0.0f &&
            record.position.z == 0.0f &&
            record.scaling.x == 1.0f && record.scaling.y == 1.0f &&
            record.scaling.z == 1.0f &&
            !record.has_rotation_quaternion &&
            record.rotation.x == 0.0f && record.rotation.y == 0.0f &&
            record.rotation.z == 0.0f;
        if (!identity_transform) {
            throw std::runtime_error(
                "A LOCAL_POSITION geometry variant over a transformed "
                "Standard mesh is not wired: the baked vertices and the "
                "raw position attribute disagree.");
        }
        return record.instance_parent_matrix;
    }
    return std::array<float, 16>{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    };
}

/**
 * The Standard material block for one draw: the pin's own writer over the
 * record-filled props. A material-less item keeps the pin's defaults, the
 * way `createStandardMaterial` seeds them.
 */
inline upstream::StandardMaterialUniforms standard_material_block(
    const MaterialRecord* material,
    std::uint32_t features) {
    const upstream::StandardMaterialProps props = material
        ? upstream::standard_material_props(*material)
        : upstream::StandardMaterialProps{};
    upstream::StandardMaterialUniforms block{};
    upstream::write_standard_material(
        props,
        upstream::standard_texture_level(features),
        block);
    return block;
}

/** The vertex-stage UV block for one draw, by the pin's own writer. */
inline upstream::StandardUvTransformUniforms standard_uv_block(
    const MaterialRecord* material,
    std::uint32_t features) {
    const upstream::StandardMaterialProps props = material
        ? upstream::standard_material_props(*material)
        : upstream::StandardMaterialProps{};
    upstream::StandardUvTransformUniforms block{};
    upstream::write_standard_uv_transform(
        props,
        material != nullptr &&
            upstream::standard_uv_inverted(features, *material),
        block);
    return block;
}
#endif

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

/**
 * The float array behind the weights blob's 16-byte header: one weight
 * per target, zero past the record's stored values. Split out because a
 * version-gated re-upload may rewrite just this span (the header is
 * constant after creation), and both backends must fill it identically.
 */
inline std::vector<float> morph_weight_values(
    const ModelGeometry& geometry,
    const MeshRecord& mesh_record) {
    const std::size_t target_count = geometry.morph_positions.size();
    std::vector<float> weights(target_count, 0.0f);
    for (
        std::size_t target = 0;
        target < target_count;
        ++target) {
        weights[target] =
            target < mesh_record.morph_storage_weights.size()
                ? mesh_record.morph_storage_weights[target]
                : 0.0f;
    }
    return weights;
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
    const std::vector<float> weights =
        morph_weight_values(geometry, mesh_record);
    if (target_count > 0) {
        std::memcpy(
            weights_blob.data() + 16,
            weights.data(),
            target_count * sizeof(float));
    }
    return weights_blob;
}
#endif

// The no-environment fallback face — the ported pinned contract both
// backends must agree on: a compiled-PBR scene with no environment binds a
// 1x1 cube of this colour, never zeros. (Dawn used to keep its
// zero-initialized startup cube here while SDL_GPU uploaded this face — a
// silent backend delta on any environment-less PBR scene.)
inline constexpr float environment_fallback_face[4] = {0.15f, 0.16f, 0.2f, 1.0f};

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

/**
 * The warmup every renderer's benchmark discards before sampling: a
 * tenth of the requested frames, clamped to [10, 120]. One policy for
 * the GPU frame loops, their sprite variants and the SDL_Renderer CPU
 * fallback, so the published numbers of any two renderers cover the
 * same measured span of a run.
 */
[[nodiscard]] inline long benchmark_warmup_frames(long benchmark_frames) {
    return benchmark_frames > 0
        ? std::min(120L, std::max(10L, benchmark_frames / 10))
        : 0;
}

// How a measured run is driven, parsed once for whichever backend runs
// it.
//
// Both frame loops used to read this matrix themselves, and the copies
// drifted: BBLITE_MSAA and BBLITE_COPY_TASK were honored by SDL_GPU and
// silently ignored by Dawn. A divergence in these decisions surfaces as a
// backend delta, which the differential attributes to the GPU side, so
// the flags a run is given have to reach both backends the same way.
struct FrameOptions {
    std::string screenshot_path;
    std::string id_buffer_path;
    std::string cluster_buffer_path;
    std::string shader_directory;
    std::string copy_task_filter;
    std::string deformation_dump;
    // Where to write the frame's full CPU-side description
    // (pal_render_capture.hpp), for diffing against the browser's
    // instrumented capture.
    std::string render_capture_path;
    // Kept as written rather than pre-interpreted: the background and
    // ground flags accept "1"/"true" as well as "0"/"false", and the
    // methods below hold the differing defaults (a requested background
    // is off unless asked for, a requested ground is on unless refused).
    std::string background_flag;
    std::string ground_flag;
    bool gpu_debug = false;
    bool test_pass = false;
    bool single_sample = false;
    long screenshot_frame = 0;
    long max_frames = 0;
    long benchmark_frames = 0;
    double animation_seek_seconds = 0.0;

    /** Frames to run: a benchmark adds its warmup to the request. */
    [[nodiscard]] long frame_budget() const {
        return benchmark_frames > 0
            ? benchmark_frames + benchmark_warmup()
            : max_frames;
    }
    [[nodiscard]] bool benchmarking() const {
        return benchmark_frames > 0;
    }
    /**
     * Whether a benchmark was asked for at all. Present mode keys on the
     * request rather than the count, because the recorded frame-time
     * numbers depend on immediate present being selected before the
     * count is known to be positive.
     */
    bool benchmark_requested = false;
    [[nodiscard]] long benchmark_warmup() const {
        return benchmark_warmup_frames(benchmark_frames);
    }

    /**
     * Whether the run draws the environment background: only when asked
     * for, or when the scene enables it by default and the flag says
     * nothing. Both frame loops read the flags through these three
     * methods, so a run's flags cannot mean different draws per backend.
     */
    [[nodiscard]] bool background_enabled(
        const EnvironmentState& environment) const {
        return background_flag == "1" ||
            background_flag == "true" ||
            (background_flag.empty() &&
             environment.background_enabled_by_default);
    }
    /** The skybox draws with the background when the scene carries one. */
    [[nodiscard]] bool skybox_enabled(
        const EnvironmentState& environment) const {
        return background_enabled(environment) &&
            environment.has_skybox;
    }
    /** The scene's ground draws unless the flag refuses it. */
    [[nodiscard]] bool ground_enabled(
        const EnvironmentState& environment) const {
        return environment.has_ground &&
            ground_flag != "0" &&
            ground_flag != "false";
    }
};

inline long frame_option_number(const char* name) {
    const std::string value = environment_variable(name);
    return value.empty()
        ? 0L
        : std::strtol(value.c_str(), nullptr, 10);
}

inline FrameOptions read_frame_options() {
    FrameOptions options;
    options.screenshot_path = environment_variable("BBLITE_SCREENSHOT");
    options.id_buffer_path = environment_variable("BBLITE_ID_BUFFER");
    options.cluster_buffer_path =
        environment_variable("BBLITE_CLUSTER_BUFFER");
    options.shader_directory =
        environment_variable("BBLITE_GPU_SHADER_DIR");
    options.copy_task_filter = environment_variable("BBLITE_COPY_TASK");
    options.deformation_dump =
        environment_variable("BBLITE_DEFORMATION_DUMP");
    options.render_capture_path =
        environment_variable("BBLITE_RENDER_CAPTURE");
    options.gpu_debug = environment_variable("BBLITE_GPU_DEBUG") == "1";
    options.test_pass = environment_variable("BBLITE_TEST_PASS") == "1";
    options.single_sample = environment_variable("BBLITE_MSAA") == "1";
    options.background_flag = environment_variable("BBLITE_BACKGROUND");
    options.ground_flag = environment_variable("BBLITE_GROUND");
    options.screenshot_frame =
        frame_option_number("BBLITE_SCREENSHOT_FRAME");
    options.max_frames = frame_option_number("BBLITE_MAX_FRAMES");
    options.benchmark_frames =
        frame_option_number("BBLITE_BENCHMARK_FRAMES");
    options.benchmark_requested =
        !environment_variable("BBLITE_BENCHMARK_FRAMES").empty();
    const std::string seek =
        environment_variable("BBLITE_ANIMATION_SEEK_SECONDS");
    options.animation_seek_seconds =
        seek.empty() ? 0.0 : std::strtod(seek.c_str(), nullptr);
    return options;
}

/**
 * A measured seek runs every registered animation seeker to the
 * requested time before the first frame; both frame loops apply the same
 * request so a seeked capture renders the same pose on either backend.
 */
inline void apply_animation_seek(
    const FrameOptions& options,
    const Scene& scene) {
    if (options.animation_seek_seconds == 0.0) return;
    const float time =
        static_cast<float>(options.animation_seek_seconds);
    for (const auto& seek : scene.animation_seekers) {
        seek(time);
    }
}

/**
 * A scene that also registers sprite renderers composes two rendering
 * contexts in one frame (the pinned HUD-on-3D shape, corpus scene 52).
 * The sprite pass is recordable into any open render pass for exactly
 * that, but neither backend records it yet, and drawing the scene while
 * silently dropping the sprites would be measured as a parity residual
 * rather than a missing feature.
 */
inline void reject_uncomposed_sprites(const Engine& engine) {
    if (!engine.registered_sprite_renderers.empty()) {
        throw std::runtime_error(
            "A sprite renderer registered alongside a scene is not "
            "composed into the scene's frame yet.");
    }
}

/**
 * A sprite renderer's layers in draw order: `spriteRendererUpdate` sorts
 * the renderer's layers by `order` every frame, so registration order is
 * not the draw order -- `layer.order` is. The sort is stable, which is
 * what decides equal orders. Returned as indices into `renderer.layers`
 * because each backend keeps its per-layer GPU state in registration
 * order; both used to carry this walk verbatim.
 */
inline std::vector<std::size_t> sprite_layer_draw_order(
    const Engine& engine,
    const SpriteRendererRecord& renderer) {
    std::vector<std::size_t> draw_order(renderer.layers.size());
    for (std::size_t index = 0; index < draw_order.size(); ++index) {
        draw_order[index] = index;
    }
    std::stable_sort(
        draw_order.begin(),
        draw_order.end(),
        [&](std::size_t left, std::size_t right) {
            return engine.sprite_layers[renderer.layers[left].value].order <
                engine.sprite_layers[renderer.layers[right].value].order;
        });
    return draw_order;
}

/**
 * The delta a scene's before-render callbacks advance by.
 *
 * A scene that sets `fixedDeltaMs` pins it, which is how the measured
 * animated scenes stay deterministic. Everything else advances by the
 * time the previous frame actually took, so an interactive run animates
 * at real speed. The first frame has no previous time and reports zero,
 * matching the pinned engine's first callback.
 *
 * Both backends drive callbacks from this: SDL_GPU measured the elapsed
 * time while Dawn passed a hardcoded 16 ms and never read the clock, so
 * a scene that integrated over the delta would have animated at a
 * different rate on each backend -- a divergence the differential would
 * have reported as a GPU-side difference.
 */
class FrameClock {
public:
    [[nodiscard]] float advance(float fixed_delta_ms) {
        const double now = monotonic_milliseconds();
        const float measured = previous_ > 0.0
            ? static_cast<float>(now - previous_)
            : 0.0f;
        previous_ = now;
        return fixed_delta_ms > 0.0f ? fixed_delta_ms : measured;
    }

private:
    double previous_ = 0.0;
};

/**
 * Decode a texture's bytes to RGBA, substituting a 1x1 fallback texel
 * when the scene carries none, and apply the pinned `invertY` flip. The
 * result is what both backends upload, so it is produced once.
 */
inline DecodedImage decode_uploadable_image(
    const TextureData& texture_data,
    const std::array<std::uint8_t, 4>& fallback) {
    DecodedImage image;
    if (texture_data.bytes.empty()) {
        image.width = image.height = 1;
        image.rgba.assign(fallback.begin(), fallback.end());
    } else {
        image = decode_image(ts::ArrayBuffer(texture_data.bytes));
    }
    if (texture_data.invert_y && image.height > 1) {
        const std::size_t row_bytes =
            static_cast<std::size_t>(image.width) * 4;
        std::vector<std::uint8_t> row(row_bytes);
        for (int y = 0; y < image.height / 2; ++y) {
            std::uint8_t* top =
                image.rgba.data() +
                static_cast<std::size_t>(y) * row_bytes;
            std::uint8_t* bottom =
                image.rgba.data() +
                static_cast<std::size_t>(image.height - 1 - y) *
                    row_bytes;
            std::memcpy(row.data(), top, row_bytes);
            std::memcpy(top, bottom, row_bytes);
            std::memcpy(bottom, row.data(), row_bytes);
        }
    }
    return image;
}

/**
 * Mip levels for a full chain over a base level:
 * 1 + floor(log2(max(width, height))), computed through double exactly as
 * both backends always have, so the same image sizes the same chain
 * everywhere. (The transmission grab's shortened chain is derived from
 * this by `transmission_grab_mip_count` below.)
 */
inline std::uint32_t full_mip_chain(
    std::uint32_t width,
    std::uint32_t height) {
    return 1u + static_cast<std::uint32_t>(
        std::floor(
            std::log2(
                static_cast<double>(std::max(width, height)))));
}

// ---------------------------------------------------------------------------
// The pin's transmission scene-colour grab, stated once for both backends
// (frame-graph/transmission.ts): a fixed 1024x1024 rgba16float texture
// whatever the surface size, its full mip chain shortened by the fixed
// 4-mip LOD bias, sampled through getTrilinearAnisotropicSampler (repeat
// addressing, trilinear filtering, anisotropy 4). Pass mechanics — how the
// grab is blitted and when the chain regenerates — stay per backend.

/** The grab's fixed extent; both its width and its height. */
inline constexpr std::uint32_t transmission_grab_size = 1024;

/**
 * The shortened chain: the full chain over the fixed extent minus the
 * pin's 4-mip bias, never below one level. (Dawn used to hardcode 11-4
 * while SDL_GPU derived the same 7 from the extent — one derivation now.)
 */
inline std::uint32_t transmission_grab_mip_count() {
    const std::uint32_t full = full_mip_chain(
        transmission_grab_size,
        transmission_grab_size);
    return std::max(1u, full > 4u ? full - 4u : 1u);
}

/** getTrilinearAnisotropicSampler's anisotropy; the filters are trilinear
 *  and the addressing repeat, translated to each API where the sampler is
 *  created. */
inline constexpr std::uint32_t transmission_sampler_max_anisotropy = 4;

/**
 * Whether one draw's material is transmissive — the predicate behind the
 * pinned mid-pass break: `executePassWithTransmission` grabs the scene
 * colour before the FIRST draw this returns true for. The once-per-frame
 * latch and the pass surgery around it stay per backend.
 */
inline bool transmissive_draw_material(const MaterialRecord* material) {
    return material != nullptr &&
        (material->transmission_factor > 0.0f ||
         !material->transmission_texture.bytes.empty());
}


/**
 * The pixels a target scaled from another occupies, by the pin's own rule:
 * `max(1, floor(extent * ratio))`, evaluated against whatever the source
 * resolved to this build.
 */
inline std::uint32_t scaled_target_extent(
    std::uint32_t source,
    double ratio) {
    return static_cast<std::uint32_t>(std::max(
        1.0,
        std::floor(static_cast<double>(source) * ratio)));
}

inline TextureFormatClass geometry_format_class(
    const GeometryTextureDescription& description) {
    if (description.format == GeometryTextureFormat::r16_float) {
        return TextureFormatClass::r16_float;
    }
    switch (description.type) {
        case GeometryTextureType::reflectivity:
        case GeometryTextureType::albedo:
            return TextureFormatClass::rgba8_unorm;
        case GeometryTextureType::view_depth:
            return TextureFormatClass::r32_float;
        case GeometryTextureType::normalized_view_depth:
        case GeometryTextureType::screenspace_depth:
            return TextureFormatClass::r16_float;
        case GeometryTextureType::irradiance:
        case GeometryTextureType::world_position:
        case GeometryTextureType::local_position:
        case GeometryTextureType::view_normal:
        case GeometryTextureType::world_normal:
        case GeometryTextureType::linear_velocity:
            return TextureFormatClass::rgba16_float;
    }
    return TextureFormatClass::rgba16_float;
}

/**
 * All four channels of a geometry attachment clear to this value: the
 * pinned NORMALIZED_VIEW_DEPTH lane clears to one (its far plane), every
 * other lane to zero.
 */
inline float geometry_clear_component(GeometryTextureType type) {
    return type == GeometryTextureType::normalized_view_depth
        ? 1.0f
        : 0.0f;
}

/**
 * The two blend-factor tuples the corpus reaches, stated once. A
 * transparent draw blends colour src-alpha over one-minus-src-alpha and
 * accumulates alpha at one; the pinned background ground rides one over
 * one-minus-src-alpha on both lanes. The operation is always add. Every
 * blending pipeline in either backend translates one of these instances
 * to its API's enums; `BlendFactors` itself lives in the runtime records,
 * because generated code names it too.
 */
inline constexpr BlendFactors transparent_blend{
    BlendFactor::src_alpha,
    BlendFactor::one_minus_src_alpha,
    BlendFactor::one,
    BlendFactor::one_minus_src_alpha,
};

inline constexpr BlendFactors ground_blend{
    BlendFactor::one,
    BlendFactor::one_minus_src_alpha,
    BlendFactor::one,
    BlendFactor::one_minus_src_alpha,
};

/**
 * The skybox stage in sub-draw order: load-env.ts pushes the solid cube
 * before the DDS and .env arms, every background renderable carries
 * order 0, and the image-skybox cube draws after the environment arm.
 * Both backends walk this one array, so the stage cannot reorder on one
 * of them.
 */
enum class SkyboxLayer {
    solid,
    environment,
    image,
};

inline constexpr std::array<SkyboxLayer, 3> skybox_stage_order{
    SkyboxLayer::solid,
    SkyboxLayer::environment,
    SkyboxLayer::image,
};

/**
 * The pinned background skyboxes (DDS, HDR and solid) build their
 * pipeline through createDefaultPipelineDescriptor without a `_cullMode`,
 * so they take its "back" default; only the image skybox asks for "none"
 * explicitly. Drawing the cube unculled leaves both the entry and the
 * exit face rasterized once the camera is outside it, and depth writes
 * are off, so the later face in index order wins instead of the nearer
 * one.
 */
inline constexpr bool skybox_layer_culls_back(SkyboxLayer layer) {
    return layer != SkyboxLayer::image;
}

/**
 * Cluster ids advance in fixed 128-triangle groups, and the id and
 * cluster buffers are compared against the browser's, so both backends
 * have to number them identically.
 */
struct ClusterRange {
    std::uint32_t triangle_count;
    std::uint32_t id_start;
};

inline ClusterRange advance_cluster_range(
    std::uint32_t index_count,
    std::uint32_t& cluster_id_base) {
    const std::uint32_t triangle_count = index_count / 3;
    const std::uint32_t id_start = cluster_id_base;
    cluster_id_base += (triangle_count + 127u) / 128u;
    return ClusterRange{triangle_count, id_start};
}

#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
/**
 * The alpha state the diagnostic shaders read: the bucket as a mode, the
 * cutoff, and the material alpha. A material-less item renders opaque at
 * full alpha.
 */
inline std::array<float, 4> diagnostic_alpha_options(
    const upstream::RenderItem& item,
    const MaterialRecord* material) {
    std::array<float, 4> options{};
    if (!material) {
        options[2] = 1.0f;
        return options;
    }
    options[0] =
        item.bucket == upstream::RenderBucket::alpha_blend
            ? 2.0f
            : item.bucket == upstream::RenderBucket::alpha_mask
                ? 1.0f
                : 0.0f;
    options[1] = material->alpha_cutoff;
    options[2] = material->base_color_factor.a;
    return options;
}

/**
 * The id and cluster diagnostic uniform blocks. The draw-id RGB packing
 * (one little-endian byte per channel over 255) and the
 * {cluster base, 128 triangles per cluster} pair are diffed against the
 * browser's buffers, so both backends fill the blocks here.
 */
struct DiagnosticIdUniforms {
    float id_color[4];
    float alpha_options[4];
};

struct DiagnosticClusterUniforms {
    std::uint32_t cluster_options[4];
    float alpha_options[4];
};

inline DiagnosticIdUniforms diagnostic_id_uniforms(
    std::uint32_t draw_id,
    const std::array<float, 4>& alpha_options) {
    DiagnosticIdUniforms uniforms{};
    uniforms.id_color[0] =
        static_cast<float>(draw_id & 0xffu) / 255.0f;
    uniforms.id_color[1] =
        static_cast<float>((draw_id >> 8) & 0xffu) / 255.0f;
    uniforms.id_color[2] =
        static_cast<float>((draw_id >> 16) & 0xffu) / 255.0f;
    uniforms.id_color[3] = 1.0f;
    std::copy_n(alpha_options.begin(), 4, uniforms.alpha_options);
    return uniforms;
}

inline DiagnosticClusterUniforms diagnostic_cluster_uniforms(
    std::uint32_t cluster_base,
    const std::array<float, 4>& alpha_options) {
    DiagnosticClusterUniforms uniforms{};
    uniforms.cluster_options[0] = cluster_base;
    uniforms.cluster_options[1] = 128;
    std::copy_n(alpha_options.begin(), 4, uniforms.alpha_options);
    return uniforms;
}

/**
 * One custom-shader stage block, filled from the generated variant
 * table: [optional 16-float scene worldViewProjection][the reflected
 * gathers from the material's flat value storage]. The same floats reach
 * an SDL_GPU push, a Dawn buffer write and the render capture, so the
 * packing lives here. `system_matrix` is null on the arm that binds the
 * shared scene-matrix buffer instead (the Dawn backend, which refuses
 * combined matrix-plus-gather blocks before calling).
 */
inline std::vector<float> shader_stage_block_floats(
    const upstream::ShaderVariantStageBlock& block,
    const float* system_matrix,
    const MaterialRecord& material) {
    std::vector<float> floats(block.float_size, 0.0f);
    if (block.system_matrix && system_matrix) {
        std::copy_n(system_matrix, 16, floats.begin());
    }
    for (const std::array<std::uint32_t, 3>& gather : block.gather) {
        for (std::uint32_t index = 0; index < gather[2]; ++index) {
            floats[gather[0] + index] =
                material.shader_uniform_values[gather[1] + index];
        }
    }
    return floats;
}
#endif

/**
 * Which requested captures have landed, and whether the loop may stop.
 *
 * A measured run ends when the frame budget is spent, except that a
 * capture can still be outstanding: a topology update defers it by a
 * frame, and a null swapchain acquisition advances scene callbacks
 * without consuming one. Both backends therefore extend the loop by a
 * bounded grace period, and both used to carry their own copy of the
 * rule -- including the comment saying it matched the other one.
 */
class CaptureGate {
public:
    CaptureGate(const FrameOptions& options, long limit)
        : options_(&options), limit_(limit) {}

    bool screenshot_saved = false;
    bool id_buffer_saved = false;
    bool cluster_buffer_saved = false;
    bool render_capture_saved = false;

    [[nodiscard]] bool pending() const {
        return (!options_->screenshot_path.empty() &&
                !screenshot_saved) ||
            (!options_->id_buffer_path.empty() &&
             !id_buffer_saved) ||
            (!options_->cluster_buffer_path.empty() &&
             !cluster_buffer_saved) ||
            (!options_->render_capture_path.empty() &&
             !render_capture_saved);
    }

    /** Whether the loop should run another frame. */
    [[nodiscard]] bool keep_running(bool running, long frame) const {
        return running &&
            (limit_ <= 0 || frame < limit_ ||
             (pending() && frame < limit_ + grace_frames));
    }

    static constexpr long grace_frames = 8;

private:
    const FrameOptions* options_;
    long limit_;
};

/**
 * The benchmark summary every renderer prints -- the GPU frame loops,
 * their sprite variants and the SDL_Renderer CPU fallback. The numbers
 * are compared across backends, so both the shape of the line and the
 * statistics behind it are produced in exactly one place. The contract:
 * one line opening with the "Babylon Lite <backend> benchmark |
 * driver=<driver>" identity prefix that names the renderer, then
 * `frames=` and the average / median / p95 / min / max frame CPU times
 * in milliseconds, fixed three-decimal precision. Samples are the
 * post-warmup frames (`benchmark_warmup_frames` above holds the shared
 * warmup policy); an empty run prints nothing.
 */
inline void report_benchmark(
    std::vector<double> samples,
    const char* backend,
    const std::string& driver) {
    if (samples.empty()) return;
    std::sort(samples.begin(), samples.end());
    double sum = 0.0;
    for (const double sample : samples) sum += sample;
    const std::size_t p95_index = std::min(
        samples.size() - 1,
        static_cast<std::size_t>(
            std::ceil(samples.size() * 0.95)) - 1);
    const std::ios_base::fmtflags flags = std::cout.flags();
    const std::streamsize precision = std::cout.precision();
    std::cout
        << std::fixed
        << std::setprecision(3)
        << "Babylon Lite " << backend << " benchmark | driver="
        << driver
        << " | frames=" << samples.size()
        << " | average=" << (sum / samples.size())
        << " ms | median=" << samples[samples.size() / 2]
        << " ms | p95=" << samples[p95_index]
        << " ms | min=" << samples.front()
        << " ms | max=" << samples.back()
        << " ms\n";
    std::cout.flags(flags);
    std::cout.precision(precision);
}

/**
 * Refuse a flag this backend does not implement rather than rendering
 * something else: a silent no-op would be measured as a backend delta.
 * `supported_backend` names the backend the refusal redirects to, so the
 * error text cannot claim SDL_GPU support from a backend that has none.
 */
inline void reject_unsupported_frame_options(
    const FrameOptions& options,
    const char* backend,
    bool supports_single_sample,
    bool supports_copy_task,
    const char* supported_backend = "SDL_GPU") {
    if (options.single_sample && !supports_single_sample) {
        throw std::runtime_error(
            std::string("BBLITE_MSAA is not supported by the ") +
            backend +
            " backend; run the single-sample diagnostic through " +
            supported_backend + ".");
    }
    if (!options.copy_task_filter.empty() && !supports_copy_task) {
        throw std::runtime_error(
            std::string("BBLITE_COPY_TASK is not supported by the ") +
            backend +
            " backend; the geometry copy-task diagnostic runs through " +
            supported_backend + ".");
    }
}

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

// ---------------------------------------------------------------------------
// Readback row conversion, shared by both backends' screenshot and
// diagnostic-buffer paths. The copy/map mechanics stay per backend; what a
// row of readback bytes MEANS as PNG pixels is decided once: rgba16float
// decodes through the manual half conversion (clamped to bytes), r16float
// lands in the red channel, 8-bit rows copy through with an optional
// BGRA swap. Rows arrive 256-byte aligned, the way both APIs return them.

enum class ReadbackFormatClass {
    rgba16_float,
    r16_float,
    rgba8,
    bgra8,
};

inline std::vector<std::uint8_t> convert_readback_rows(
    const std::uint8_t* mapped,
    std::uint32_t width,
    std::uint32_t height,
    std::uint32_t aligned_row_bytes,
    ReadbackFormatClass format) {
    const std::uint32_t output_row_bytes = width * 4;
    std::vector<std::uint8_t> rgba(
        static_cast<std::size_t>(output_row_bytes) * height);
    for (std::uint32_t y = 0; y < height; ++y) {
        const std::uint8_t* source_row =
            mapped + static_cast<std::size_t>(y) * aligned_row_bytes;
        std::uint8_t* destination_row =
            rgba.data() + static_cast<std::size_t>(y) * output_row_bytes;
        if (format == ReadbackFormatClass::rgba16_float) {
            const auto* source_pixels =
                reinterpret_cast<const std::uint16_t*>(source_row);
            for (std::uint32_t x = 0; x < width; ++x) {
                for (std::uint32_t channel = 0; channel < 4; ++channel) {
                    destination_row[x * 4 + channel] =
                        half_to_byte(source_pixels[x * 4 + channel]);
                }
            }
        } else if (format == ReadbackFormatClass::r16_float) {
            const auto* source_pixels =
                reinterpret_cast<const std::uint16_t*>(source_row);
            for (std::uint32_t x = 0; x < width; ++x) {
                destination_row[x * 4] = half_to_byte(source_pixels[x]);
                destination_row[x * 4 + 1] = 0;
                destination_row[x * 4 + 2] = 0;
                destination_row[x * 4 + 3] = 255;
            }
        } else {
            std::memcpy(destination_row, source_row, output_row_bytes);
            if (format == ReadbackFormatClass::bgra8) {
                for (std::uint32_t x = 0; x < width; ++x) {
                    std::swap(
                        destination_row[x * 4],
                        destination_row[x * 4 + 2]);
                }
            }
        }
    }
    return rgba;
}

/**
 * The HDR diagnostic sidecar: the unpadded rgba16float rows, written to a
 * stream the caller opened (opening — and cleaning up its own GPU
 * resources when the open fails — stays per backend).
 */
inline void write_readback_raw_rows(
    std::ostream& raw,
    const std::uint8_t* mapped,
    std::uint32_t height,
    std::uint32_t aligned_row_bytes,
    std::uint32_t source_row_bytes) {
    for (std::uint32_t y = 0; y < height; ++y) {
        raw.write(
            reinterpret_cast<const char*>(
                mapped + static_cast<std::size_t>(y) * aligned_row_bytes),
            source_row_bytes);
    }
}

} // namespace bbl::pal

// Native render capture: everything the CPU decided about one frame,
// written as JSON so it can be diffed field by field against the
// browser's instrumented capture (`scene -- capture <id>`).
//
// The browser side records what Babylon Lite uploaded to WebGPU. This
// side records what our renderer would upload for the same frame: the
// same generated `build_*_uniforms` functions the backends call, over
// the same render plan, plus the scene model those functions read from.
// Pairing the two answers "did our CPU compute the same numbers?"
// directly, instead of by inference from a pixel residual.
//
// What this is NOT: an interception of the graphics API. The uniform
// blocks here are rebuilt from (scene, engine, camera, item) rather than
// read back from the command stream, because that is the tuple both
// backends pass to the same builder. A backend that uploaded the right
// bytes to the wrong slot would still look correct here -- that failure
// mode is what the SDL_GPU-versus-Dawn differential covers, so the two
// tools are complementary and neither replaces the other.
#pragma once

#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>
#include <bblite/upstream/render_capabilities.hpp>

#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER

#include <bblite/upstream/build_stamp.hpp>
#include <bblite/upstream/renderer_plan.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iomanip>
#include <limits>
#include <ostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace bbl::pal {

/**
 * A minimal streaming JSON writer.
 *
 * Hand-rolled rather than nlohmann, because the capture has to survive
 * the minimal-size configurations too, and because the only shapes it
 * emits are objects, arrays, strings and numbers.
 *
 * Floats print with nine significant digits, which is the shortest
 * precision that round-trips every `float` exactly, so a value compared
 * against the browser's upload is compared at full precision rather than
 * at printing precision. Non-finite values become strings, since JSON
 * has no spelling for them; the reader distinguishes them by type.
 */
class JsonWriter {
public:
    explicit JsonWriter(std::ostream& stream) : stream_(&stream) {}

    void begin_object() {
        separate();
        *stream_ << '{';
        first_ = true;
    }
    void end_object() {
        *stream_ << '}';
        first_ = false;
    }
    void begin_array() {
        separate();
        *stream_ << '[';
        first_ = true;
    }
    void end_array() {
        *stream_ << ']';
        first_ = false;
    }

    void key(const char* name) {
        separate();
        write_string(name);
        *stream_ << ':';
        first_ = true;
    }

    void value(const char* text) {
        separate();
        write_string(text);
        first_ = false;
    }
    void value(const std::string& text) { value(text.c_str()); }
    void value(bool flag) {
        separate();
        *stream_ << (flag ? "true" : "false");
        first_ = false;
    }
    void value(std::uint32_t number) {
        separate();
        *stream_ << number;
        first_ = false;
    }
    /**
     * A record index, where the unassigned sentinel means "none".
     *
     * Printed as `null` rather than as four billion, so a reader can
     * distinguish "this draw has no material" from a real index without
     * knowing what `invalid_handle` is.
     */
    void handle(const char* name, std::uint32_t index) {
        key(name);
        separate();
        if (index == invalid_handle) {
            *stream_ << "null";
        } else {
            *stream_ << index;
        }
        first_ = false;
    }
    void value(std::size_t number) {
        separate();
        *stream_ << number;
        first_ = false;
    }
    void value(int number) {
        separate();
        *stream_ << number;
        first_ = false;
    }
    void value(float number) {
        separate();
        if (std::isfinite(number)) {
            std::ostringstream text;
            text << std::setprecision(9) << number;
            *stream_ << text.str();
        } else if (std::isnan(number)) {
            *stream_ << "\"nan\"";
        } else {
            *stream_ << (number > 0.0f ? "\"inf\"" : "\"-inf\"");
        }
        first_ = false;
    }
    // The camera scalars are doubles, and printing them through the
    // float overload would hide exactly the digits this capture exists
    // to compare against the browser's.
    void value(double number) {
        separate();
        if (std::isfinite(number)) {
            std::ostringstream text;
            text << std::setprecision(17) << number;
            *stream_ << text.str();
        } else if (std::isnan(number)) {
            *stream_ << "\"nan\"";
        } else {
            *stream_ << (number > 0.0 ? "\"inf\"" : "\"-inf\"");
        }
        first_ = false;
    }

    // Named shorthands. Every one of these is a "field: value" pair, and
    // writing them as one call each is what keeps the dumps below
    // readable at the scale of ninety material fields.
    template <typename T>
    void field(const char* name, T number) {
        key(name);
        value(number);
    }
    void field(const char* name, const std::string& text) {
        key(name);
        value(text);
    }
    void field(const char* name, const Vec2& vector) {
        key(name);
        begin_array();
        value(vector.x);
        value(vector.y);
        end_array();
    }
    void field(const char* name, const Vec3& vector) {
        key(name);
        begin_array();
        value(vector.x);
        value(vector.y);
        value(vector.z);
        end_array();
    }
    void field(const char* name, const Vec3d& vector) {
        key(name);
        begin_array();
        value(vector.x);
        value(vector.y);
        value(vector.z);
        end_array();
    }
    void field(const char* name, const Vec4& vector) {
        key(name);
        begin_array();
        value(vector.x);
        value(vector.y);
        value(vector.z);
        value(vector.w);
        end_array();
    }
    void field(const char* name, const Color3& color) {
        key(name);
        begin_array();
        value(color.r);
        value(color.g);
        value(color.b);
        end_array();
    }
    void field(const char* name, const Color4& color) {
        key(name);
        begin_array();
        value(color.r);
        value(color.g);
        value(color.b);
        value(color.a);
        end_array();
    }
    void field(const char* name, const float* values, std::size_t count) {
        key(name);
        begin_array();
        for (std::size_t index = 0; index < count; ++index) {
            value(values[index]);
        }
        end_array();
    }

private:
    void separate() {
        if (!first_) *stream_ << ',';
        first_ = false;
    }
    void write_string(const char* text) {
        *stream_ << '"';
        for (const char* cursor = text; *cursor; ++cursor) {
            const unsigned char character =
                static_cast<unsigned char>(*cursor);
            switch (character) {
                case '"': *stream_ << "\\\""; break;
                case '\\': *stream_ << "\\\\"; break;
                case '\n': *stream_ << "\\n"; break;
                case '\r': *stream_ << "\\r"; break;
                case '\t': *stream_ << "\\t"; break;
                default:
                    if (character < 0x20) {
                        *stream_
                            << "\\u"
                            << std::hex
                            << std::setw(4)
                            << std::setfill('0')
                            << static_cast<int>(character)
                            << std::dec;
                    } else {
                        *stream_ << *cursor;
                    }
            }
        }
        *stream_ << '"';
    }

    std::ostream* stream_;
    bool first_ = true;
};

/**
 * FNV-1a over a texture payload.
 *
 * Texture bytes are far too large to dump, but "is it the same asset in
 * the same slot?" is answerable from a digest, and an unexpectedly equal
 * digest across two slots is itself a finding (the same texture bound
 * twice is a real defect shape here).
 */
inline std::string payload_digest(const std::vector<std::uint8_t>& bytes) {
    std::uint64_t hash = 0xcbf29ce484222325ull;
    for (const std::uint8_t byte : bytes) {
        hash ^= byte;
        hash *= 0x100000001b3ull;
    }
    std::ostringstream text;
    text << std::hex << std::setw(16) << std::setfill('0') << hash;
    return text.str();
}

inline const char* primitive_name(PrimitiveKind kind) {
    switch (kind) {
        case PrimitiveKind::babylon: return "babylon";
        case PrimitiveKind::box: return "box";
        case PrimitiveKind::gltf: return "gltf";
        case PrimitiveKind::ground: return "ground";
        case PrimitiveKind::sphere: return "sphere";
        case PrimitiveKind::torus: return "torus";
    }
    return "unknown";
}

inline const char* camera_kind_name(CameraKind kind) {
    return kind == CameraKind::free ? "free" : "arcRotate";
}

inline const char* light_kind_name(LightKind kind) {
    switch (kind) {
        case LightKind::directional: return "directional";
        case LightKind::hemispheric: return "hemispheric";
        case LightKind::point: return "point";
        case LightKind::spot: return "spot";
    }
    return "unknown";
}

inline const char* alpha_mode_name(MaterialAlphaMode mode) {
    switch (mode) {
        case MaterialAlphaMode::opaque: return "OPAQUE";
        case MaterialAlphaMode::mask: return "MASK";
        case MaterialAlphaMode::blend: return "BLEND";
    }
    return "unknown";
}

inline const char* material_kind_name(upstream::RenderMaterialKind kind) {
    switch (kind) {
        case upstream::RenderMaterialKind::pbr: return "pbr";
        case upstream::RenderMaterialKind::standard: return "standard";
        case upstream::RenderMaterialKind::grid: return "grid";
        case upstream::RenderMaterialKind::shader: return "shader";
    }
    return "unknown";
}

inline const char* bucket_name(upstream::RenderBucket bucket) {
    switch (bucket) {
        case upstream::RenderBucket::opaque: return "opaque";
        case upstream::RenderBucket::alpha_mask: return "alphaMask";
        case upstream::RenderBucket::alpha_blend: return "alphaBlend";
    }
    return "unknown";
}

inline const char* pipeline_name(upstream::RenderPipelineKind kind) {
    switch (kind) {
        case upstream::RenderPipelineKind::pbr_opaque_back:
            return "pbr_opaque_back";
        case upstream::RenderPipelineKind::pbr_opaque_none:
            return "pbr_opaque_none";
        case upstream::RenderPipelineKind::pbr_opaque_none_clockwise:
            return "pbr_opaque_none_clockwise";
        case upstream::RenderPipelineKind::pbr_transparent_back:
            return "pbr_transparent_back";
        case upstream::RenderPipelineKind::pbr_transparent_none:
            return "pbr_transparent_none";
        case upstream::RenderPipelineKind::pbr_transparent_none_clockwise:
            return "pbr_transparent_none_clockwise";
        case upstream::RenderPipelineKind::standard_opaque_back:
            return "standard_opaque_back";
        case upstream::RenderPipelineKind::standard_opaque_none:
            return "standard_opaque_none";
        case upstream::RenderPipelineKind::standard_transparent_back:
            return "standard_transparent_back";
        case upstream::RenderPipelineKind::standard_transparent_none:
            return "standard_transparent_none";
        case upstream::RenderPipelineKind::grid_opaque_back:
            return "grid_opaque_back";
        case upstream::RenderPipelineKind::grid_opaque_none:
            return "grid_opaque_none";
        case upstream::RenderPipelineKind::grid_transparent_back:
            return "grid_transparent_back";
        case upstream::RenderPipelineKind::grid_transparent_none:
            return "grid_transparent_none";
        case upstream::RenderPipelineKind::shader:
            return "shader";
        case upstream::RenderPipelineKind::shader_a2c:
            return "shader_a2c";
    }
    return "unknown";
}

inline const char* filter_name(TextureFilter filter) {
    return filter == TextureFilter::nearest ? "nearest" : "linear";
}

inline const char* address_name(TextureAddressMode mode) {
    switch (mode) {
        case TextureAddressMode::repeat: return "repeat";
        case TextureAddressMode::clamp: return "clamp";
        case TextureAddressMode::mirror: return "mirror";
    }
    return "unknown";
}

/**
 * A uniform block as the GPU receives it: the generated struct's name
 * plus its bytes read back as floats.
 *
 * Every one of these structs is an aggregate of `std::array<float, 4>`
 * members with no padding, so the flat float view is byte-identical to
 * the upload. The reader recovers the field names by parsing the same
 * struct declaration out of the scene's generated `renderer_plan.hpp`,
 * which is how a diff can say `emissive_factor` instead of `float 41`.
 */
template <typename Uniforms>
inline void write_uniform_block(
    JsonWriter& json,
    const char* stage,
    std::uint32_t slot,
    const char* type_name,
    const Uniforms& uniforms) {
    static_assert(
        sizeof(Uniforms) % sizeof(float) == 0,
        "uniform blocks are float aggregates");
    json.begin_object();
    json.field("stage", stage);
    json.field("slot", slot);
    json.field("type", type_name);
    json.field(
        "floats",
        reinterpret_cast<const float*>(&uniforms),
        sizeof(Uniforms) / sizeof(float));
    json.end_object();
}

inline void write_float_block(
    JsonWriter& json,
    const char* stage,
    std::uint32_t slot,
    const char* type_name,
    const float* values,
    std::size_t count) {
    json.begin_object();
    json.field("stage", stage);
    json.field("slot", slot);
    json.field("type", type_name);
    json.field("floats", values, count);
    json.end_object();
}

inline void write_texture_slot(
    JsonWriter& json,
    const char* slot,
    const TextureData& texture) {
    if (texture.bytes.empty()) return;
    json.begin_object();
    json.field("slot", slot);
    json.field("byteLength", texture.bytes.size());
    json.field("digest", payload_digest(texture.bytes));
    json.field("invertY", texture.invert_y);
    json.key("sampler");
    json.begin_object();
    json.field("minFilter", filter_name(texture.sampler.min_filter));
    json.field("magFilter", filter_name(texture.sampler.mag_filter));
    json.field(
        "mipmapMode",
        texture.sampler.mipmap_mode == TextureMipmapMode::nearest
            ? "nearest"
            : "linear");
    json.field("addressU", address_name(texture.sampler.address_u));
    json.field("addressV", address_name(texture.sampler.address_v));
    json.field("maxAnisotropy", texture.sampler.max_anisotropy);
    json.field("maxLod", texture.sampler.max_lod);
    json.end_object();
    json.end_object();
}

inline void write_texture_transform(
    JsonWriter& json,
    const char* name,
    const TextureTransform& transform) {
    // An identity transform is the overwhelming majority and says
    // nothing; printing only the ones a scene actually set keeps the
    // material record readable enough to scan by eye.
    if (transform.u_scale == 1.0f && transform.v_scale == 1.0f &&
        transform.u_offset == 0.0f && transform.v_offset == 0.0f &&
        transform.rotation == 0.0f) {
        return;
    }
    json.key(name);
    json.begin_array();
    json.value(transform.u_scale);
    json.value(transform.v_scale);
    json.value(transform.u_offset);
    json.value(transform.v_offset);
    json.value(transform.rotation);
    json.end_array();
}

inline void write_material(
    JsonWriter& json,
    std::size_t index,
    const MaterialRecord& material) {
    json.begin_object();
    json.field("index", index);
    json.field("alphaMode", alpha_mode_name(material.alpha_mode));
    json.field("alphaCutoff", material.alpha_cutoff);
    json.field("doubleSided", material.double_sided);
    json.field("standardMaterial", material.standard_material);
    json.field("shaderMaterial", material.shader_material);
    json.field("gridMaterial", material.grid_material);
    json.field("shaderVariant", material.shader_variant);
    json.field("alphaToCoverage", material.alpha_to_coverage);
    json.field("shaderAlphaTesting", material.shader_alpha_testing);
    json.field("shaderDepthWrite", material.shader_depth_write);

    json.field("baseColorFactor", material.base_color_factor);
    json.field("emissiveFactor", material.emissive_factor);
    json.field("emissiveBaseFactor", material.emissive_base_factor);
    json.field("emissiveStrength", material.emissive_strength);
    json.field("metallicFactor", material.metallic_factor);
    json.field("roughnessFactor", material.roughness_factor);
    json.field("directIntensity", material.direct_intensity);
    json.field("environmentIntensity", material.environment_intensity);
    json.field("reflectance", material.reflectance);
    json.field("normalTextureScale", material.normal_texture_scale);
    json.field("unlit", material.unlit);
    json.field("noColor", material.no_color);
    json.field("disableLighting", material.disable_lighting);
    json.field("specularAa", material.specular_aa);
    json.field("skyboxMode", material.skybox_mode);
    json.field("hasOcclusionTexture", material.has_occlusion_texture);
    json.field("occlusionStrength", material.occlusion_strength);
    json.field("occlusionTextureUv2", material.occlusion_texture_uv2);

    json.field("hasMetallicReflectance", material.has_metallic_reflectance);
    json.field("metallicF0Factor", material.metallic_f0_factor);
    json.field("specularWeight", material.specular_weight);
    json.field(
        "metallicReflectanceColor",
        material.metallic_reflectance_color);

    json.field("hasIor", material.has_ior);
    json.field("indexOfRefraction", material.index_of_refraction);
    json.field("transmissionFactor", material.transmission_factor);
    json.field("hasVolume", material.has_volume);
    json.field("thickness", material.thickness);
    json.field("useThicknessAsDepth", material.use_thickness_as_depth);
    json.field("attenuationColor", material.attenuation_color);
    json.field("attenuationDistance", material.attenuation_distance);
    json.field("dispersion", material.dispersion);

    json.field("clearcoatIntensity", material.clearcoat_intensity);
    json.field("clearcoatRoughness", material.clearcoat_roughness);
    json.field(
        "clearcoatIndexOfRefraction",
        material.clearcoat_index_of_refraction);
    json.field("clearcoatNormalScale", material.clearcoat_normal_scale);
    json.field("sheenColor", material.sheen_color);
    json.field("sheenRoughness", material.sheen_roughness);
    json.field("sheenIntensity", material.sheen_intensity);
    json.field("iridescenceIntensity", material.iridescence_intensity);
    json.field(
        "iridescenceIndexOfRefraction",
        material.iridescence_index_of_refraction);
    json.field(
        "iridescenceMinimumThickness",
        material.iridescence_minimum_thickness);
    json.field(
        "iridescenceMaximumThickness",
        material.iridescence_maximum_thickness);

    json.field("diffuseColor", material.diffuse_color);
    json.field("specularColor", material.specular_color);
    json.field("ambientColor", material.ambient_color);
    json.field("specularPower", material.specular_power);
    json.field("diffuseLevel", material.diffuse_level);
    json.field("opacityLevel", material.opacity_level);
    json.field("ambientLevel", material.ambient_level);
    json.field("diffuseUScale", material.diffuse_u_scale);
    json.field("diffuseVScale", material.diffuse_v_scale);
    json.field("diffuseUOffset", material.diffuse_u_offset);
    json.field("diffuseVOffset", material.diffuse_v_offset);
    json.field("diffuseCoordIndex", material.diffuse_coord_index);
    json.field("specularCoordIndex", material.specular_coord_index);
    json.field("ambientCoordIndex", material.ambient_coord_index);
    json.field("bumpScale", material.bump_scale);
    json.field("reflectionLevel", material.reflection_level);

    json.field("gridMainColor", material.grid_main_color);
    json.field("gridLineColor", material.grid_line_color);
    json.field("gridControl", material.grid_control);
    json.field("gridOffset", material.grid_offset);
    json.field("gridVisibility", material.grid_visibility);
    json.field("gridAntialias", material.grid_antialias);
    json.field("gridPreMultiplyAlpha", material.grid_pre_multiply_alpha);
    json.field("gridUseMaxLine", material.grid_use_max_line);
    json.handle("reflectionCubeIndex", material.reflection_cube);

    json.key("baseColorFallback");
    json.begin_array();
    for (const std::uint8_t channel : material.base_color_fallback) {
        json.value(static_cast<std::uint32_t>(channel));
    }
    json.end_array();
    json.key("ormFallback");
    json.begin_array();
    for (const std::uint8_t channel : material.orm_fallback) {
        json.value(static_cast<std::uint32_t>(channel));
    }
    json.end_array();

    if (!material.shader_uniform_values.empty()) {
        json.field(
            "shaderUniformValues",
            material.shader_uniform_values.data(),
            material.shader_uniform_values.size());
    }

    write_texture_transform(
        json, "baseColorTransform", material.base_color_transform);
    write_texture_transform(json, "ormTransform", material.orm_transform);
    write_texture_transform(
        json, "normalTransform", material.normal_transform);
    write_texture_transform(
        json, "emissiveTransform", material.emissive_transform);
    write_texture_transform(
        json, "clearcoatTransform", material.clearcoat_transform);
    write_texture_transform(
        json,
        "clearcoatRoughnessTransform",
        material.clearcoat_roughness_transform);
    write_texture_transform(
        json,
        "clearcoatNormalTransform",
        material.clearcoat_normal_transform);
    write_texture_transform(json, "sheenTransform", material.sheen_transform);
    write_texture_transform(
        json, "sheenRoughnessTransform", material.sheen_roughness_transform);
    write_texture_transform(
        json, "iridescenceTransform", material.iridescence_transform);
    write_texture_transform(
        json,
        "iridescenceThicknessTransform",
        material.iridescence_thickness_transform);
    write_texture_transform(
        json, "transmissionTransform", material.transmission_transform);
    write_texture_transform(
        json, "thicknessTransform", material.thickness_transform);

    json.key("textures");
    json.begin_array();
    write_texture_slot(json, "baseColor", material.base_color_texture);
    write_texture_slot(
        json, "metallicRoughness", material.metallic_roughness_texture);
    write_texture_slot(json, "normal", material.normal_texture);
    write_texture_slot(json, "transmission", material.transmission_texture);
    write_texture_slot(json, "thickness", material.thickness_texture);
    write_texture_slot(json, "clearcoat", material.clearcoat_texture);
    write_texture_slot(
        json, "clearcoatRoughness", material.clearcoat_roughness_texture);
    write_texture_slot(
        json, "clearcoatNormal", material.clearcoat_normal_texture);
    write_texture_slot(json, "sheenColor", material.sheen_color_texture);
    write_texture_slot(
        json, "sheenRoughness", material.sheen_roughness_texture);
    write_texture_slot(json, "iridescence", material.iridescence_texture);
    write_texture_slot(
        json, "iridescenceThickness", material.iridescence_thickness_texture);
    write_texture_slot(json, "emissive", material.emissive_texture);
    write_texture_slot(json, "opacity", material.opacity_texture);
    write_texture_slot(json, "specular", material.specular_texture);
    write_texture_slot(json, "ambient", material.ambient_texture);
    write_texture_slot(json, "bump", material.bump_texture);
    write_texture_slot(json, "occlusion", material.occlusion_texture);
    json.end_array();
    json.end_object();
}

inline void write_mesh(
    JsonWriter& json,
    std::size_t index,
    const MeshRecord& mesh,
    const Engine& engine) {
    json.begin_object();
    json.field("index", index);
    json.field("primitive", primitive_name(mesh.primitive));
    json.field("position", mesh.position);
    json.field("rotation", mesh.rotation);
    json.field("rotationQuaternion", mesh.rotation_quaternion);
    json.field("hasRotationQuaternion", mesh.has_rotation_quaternion);
    json.field("scaling", mesh.scaling);
    json.field("dimensions", mesh.dimensions);
    json.handle("material", mesh.material.value);
    json.handle("geometry", mesh.geometry);
    json.field("visible", mesh.visible);
    json.field("bakedWorldScale", mesh.baked_world_scale);
    json.field("clockwiseFrontFace", mesh.clockwise_front_face);
    json.field("gpuDeformation", mesh.gpu_deformation);
    json.field("boneMatrixCount", mesh.bone_matrices.size());
    json.field("thinInstanced", mesh.thin_instanced);
    json.field("instanceCount", mesh.instance_count);
    json.field("loaderInstanceCount", mesh.instance_matrices.size());
    json.field("morphWeights", mesh.morph_weights.data(), 4);
    if (!mesh.morph_storage_weights.empty()) {
        json.field(
            "morphStorageWeights",
            mesh.morph_storage_weights.data(),
            mesh.morph_storage_weights.size());
    }
    if (mesh.geometry < engine.geometries.size()) {
        const ModelGeometry& geometry = engine.geometries[mesh.geometry];
        json.key("geometryInfo");
        json.begin_object();
        json.field("vertexCount", geometry.vertices.size());
        json.field("indexCount", geometry.indices.size());
        json.field("hasTangents", geometry.has_tangents);
        json.field("flatNormals", geometry.flat_normals);
        json.field("morphTargets", geometry.morph_positions.size());
        json.field("boundsMin", geometry.bounds_min);
        json.field("boundsMax", geometry.bounds_max);
        json.field("worldBoundsMin", geometry.world_bounds_min);
        json.field("worldBoundsMax", geometry.world_bounds_max);
        json.end_object();
    }
    json.end_object();
}

inline void write_light(
    JsonWriter& json,
    std::size_t index,
    const LightRecord& light) {
    json.begin_object();
    json.field("index", index);
    json.field("kind", light_kind_name(light.kind));
    json.field("position", light.position);
    json.field("direction", light.direction);
    json.field("intensity", light.intensity);
    json.field("range", light.range);
    json.field("cosHalfAngle", light.cos_half_angle);
    json.field("exponent", light.exponent);
    json.field("diffuseColor", light.diffuse_color);
    json.field("specularColor", light.specular_color);
    json.field("groundColor", light.ground_color);
    json.field("includedMeshes", light.included_meshes.size());
    json.field("excludedMeshes", light.excluded_meshes.size());
    json.end_object();
}

inline void write_environment(
    JsonWriter& json,
    const EnvironmentState& environment) {
    json.begin_object();
    json.field("hasIrradiance", environment.has_irradiance);
    json.field("exposure", environment.exposure);
    json.field("contrast", environment.contrast);
    json.field("lodGenerationScale", environment.lod_generation_scale);
    json.field("rotationY", environment.rotation_y);
    json.field("toneMappingEnabled", environment.tone_mapping_enabled);
    json.field("specularWidth", environment.specular_width);
    json.field("specularMipCount", environment.specular_mip_count);
    json.field("specularFaces", environment.specular_faces.size());
    json.field("specularRgba16f", environment.specular_rgba16f);
    json.field("brdfLutWidth", environment.brdf_lut_width);
    json.field("brdfLutRgba16f", environment.brdf_lut_rgba16f);
    json.field("hasGround", environment.has_ground);
    json.field("hasSkybox", environment.has_skybox);
    json.field("hasImageSkybox", environment.has_image_skybox);
    json.field(
        "backgroundEnabledByDefault",
        environment.background_enabled_by_default);
    json.field(
        "skyboxUsesEnvironment", environment.skybox_uses_environment);
    json.field("groundSize", environment.ground_size);
    json.field("skyboxSize", environment.skybox_size);
    json.field("imageSkyboxSize", environment.image_skybox_size);
    json.field("skyboxWidth", environment.skybox_width);
    json.field("skyboxMipCount", environment.skybox_mip_count);
    json.field("groundPosition", environment.ground_position);
    json.field("skyboxPosition", environment.skybox_position);
    json.field("primaryColor", environment.primary_color);
    json.key("sphericalHarmonics");
    json.begin_array();
    for (const Color3& harmonic : environment.spherical_harmonics) {
        json.begin_array();
        json.value(harmonic.r);
        json.value(harmonic.g);
        json.value(harmonic.b);
        json.end_array();
    }
    json.end_array();
    json.end_object();
}

/**
 * The uniform blocks one draw uploads, rebuilt through the generated
 * builders both backends call.
 */
inline void write_draw_uniforms(
    JsonWriter& json,
    const Scene& scene,
    const Engine& engine,
    const CameraRecord& camera,
    const upstream::RenderDrawCommand& draw,
    const std::array<float, 16>& view_projection) {
    json.key("uniforms");
    json.begin_array();
    write_float_block(
        json,
        "vertex",
        0,
        "viewProjection",
        view_projection.data(),
        view_projection.size());
    switch (draw.item.material_kind) {
        case upstream::RenderMaterialKind::standard: {
            const upstream::StandardUniforms fragment =
                upstream::build_standard_uniforms(
                    scene, engine, camera, draw.item);
            write_uniform_block(
                json, "fragment", 0, "StandardUniforms", fragment);
            break;
        }
        case upstream::RenderMaterialKind::grid: {
            const upstream::GridUniforms fragment =
                upstream::build_grid_uniforms(engine, draw.item);
            write_uniform_block(
                json, "fragment", 0, "GridUniforms", fragment);
            break;
        }
        case upstream::RenderMaterialKind::shader: {
            // The custom-shader path packs its block from the variant's
            // reflected gathers, so it has no named struct to parse; the
            // floats are reported in block order the same way.
            if (draw.item.material.value < engine.materials.size()) {
                const MaterialRecord& material =
                    engine.materials[draw.item.material.value];
                const upstream::ShaderVariantInfo& info =
                    upstream::shader_variant_info(draw.item.shader_variant);
                const auto emit_block =
                    [&](
                        const upstream::ShaderVariantStageBlock& block,
                        const char* stage) {
                        if (!block.present) return;
                        std::vector<float> floats(block.float_size, 0.0f);
                        if (block.system_matrix) {
                            std::copy_n(
                                view_projection.data(), 16, floats.begin());
                        }
                        for (const std::array<std::uint32_t, 3>& gather :
                             block.gather) {
                            for (std::uint32_t offset = 0;
                                 offset < gather[2];
                                 ++offset) {
                                floats[gather[0] + offset] =
                                    material.shader_uniform_values
                                        [gather[1] + offset];
                            }
                        }
                        write_float_block(
                            json,
                            stage,
                            0,
                            info.name,
                            floats.data(),
                            floats.size());
                    };
                emit_block(info.vertex, "vertex");
                emit_block(info.fragment, "fragment");
            }
            break;
        }
        case upstream::RenderMaterialKind::pbr:
        default: {
            const upstream::PbrUniforms fragment =
                upstream::build_pbr_uniforms(
                    scene, engine, camera, draw.item);
            write_uniform_block(
                json, "fragment", 0, "PbrUniforms", fragment);
            break;
        }
    }
    json.end_array();
}

inline void write_draw_list(
    JsonWriter& json,
    const char* stage,
    const upstream::RenderDrawList& list,
    const Scene& scene,
    const Engine& engine,
    const CameraRecord& camera,
    const std::array<float, 16>& view_projection) {
    for (const upstream::RenderDrawCommand& draw : list.commands) {
        json.begin_object();
        json.field("stage", stage);
        json.handle("itemIndex", draw.item_index);
        json.field("pipeline", pipeline_name(draw.pipeline));
        json.field("materialKind", material_kind_name(draw.item.material_kind));
        json.field("bucket", bucket_name(draw.item.bucket));
        json.field(
            "cullMode",
            draw.item.cull_mode == upstream::RenderCullMode::none
                ? "none"
                : "back");
        json.field("clockwiseFrontFace", draw.item.clockwise_front_face);
        json.field("alphaToCoverage", draw.item.alpha_to_coverage);
        json.field("transmissive", draw.item.transmissive);
        json.field("skyboxMode", draw.item.skybox_mode);
        json.field("order", draw.item.order);
        json.field("sortDistance", draw.sort_distance);
        json.handle("mesh", draw.item.mesh.value);
        json.handle("material", draw.item.material.value);
        json.handle("geometry", draw.item.geometry);
        json.field("shaderVariant", draw.item.shader_variant);
        if (draw.item.geometry < engine.geometries.size()) {
            const ModelGeometry& geometry =
                engine.geometries[draw.item.geometry];
            json.field("indexCount", geometry.indices.size());
            json.field("vertexCount", geometry.vertices.size());
        }
        if (draw.item.mesh.value < engine.meshes.size()) {
            const MeshRecord& mesh = engine.meshes[draw.item.mesh.value];
            json.field(
                "instanceCount",
                mesh.thin_instanced
                    ? mesh.instance_count
                    : static_cast<std::uint32_t>(
                          mesh.instance_matrices.size()));
        }
        write_draw_uniforms(
            json, scene, engine, camera, draw, view_projection);
        json.end_object();
    }
}

/**
 * Write the whole frame.
 *
 * Called from each backend at the frame the screenshot is taken, so the
 * capture describes the image that was measured rather than some other
 * frame of the same run.
 */
inline void write_render_capture(
    const std::string& path,
    const char* backend,
    const Scene& scene,
    const Engine& engine,
    const CameraRecord& camera,
    const upstream::RenderPlan& render_plan,
    const std::array<float, 16>& view_projection,
    int width,
    int height,
    long frame) {
    std::ofstream stream(path, std::ios::binary | std::ios::trunc);
    if (!stream) {
        throw std::runtime_error(
            "Unable to write the render capture to '" + path + "'.");
    }
    JsonWriter json(stream);
    json.begin_object();
    json.field("backend", backend);
    json.field("buildStamp", BBLITE_BUILD_STAMP);
    json.field("frame", static_cast<int>(frame));
    json.key("viewport");
    json.begin_object();
    json.field("width", width);
    json.field("height", height);
    json.end_object();

    json.key("scene");
    json.begin_object();
    json.field("clearColor", scene.clear_color);
    json.field("fixedDeltaMs", scene.fixed_delta_ms);
    json.field("transmissionEnabled", scene.transmission_enabled);
    json.field("materialFamilyMask", scene.material_family_mask);
    json.field("fogMode", scene.fog_mode);
    json.field("fogDensity", scene.fog_density);
    json.field("fogStart", scene.fog_start);
    json.field("fogEnd", scene.fog_end);
    json.field("fogColor", scene.fog_color);
    json.field("meshCount", scene.meshes.size());
    json.field("lightCount", scene.lights.size());
    json.field("taskCount", scene.tasks.size());
    json.end_object();

    json.key("camera");
    json.begin_object();
    json.field("kind", camera_kind_name(camera.kind));
    json.field("position", camera.position);
    json.field("target", camera.target);
    json.field("alpha", camera.alpha);
    json.field("beta", camera.beta);
    json.field("radius", camera.radius);
    json.field("fov", camera.fov);
    json.field("nearPlane", camera.near_plane);
    json.field("farPlane", camera.far_plane);
    json.field("orthographic", camera.orthographic);
    json.field("orthoHalfHeight", camera.ortho_half_height);
    json.field("freeYaw", camera.free_yaw);
    json.field("freePitch", camera.free_pitch);
    json.field(
        "viewProjection", view_projection.data(), view_projection.size());
    json.end_object();

    json.key("environment");
    write_environment(json, scene.environment);

    json.key("lights");
    json.begin_array();
    for (const LightHandle handle : scene.lights) {
        if (handle.value >= engine.lights.size()) continue;
        write_light(json, handle.value, engine.lights[handle.value]);
    }
    json.end_array();

    json.key("meshes");
    json.begin_array();
    for (std::size_t index = 0; index < engine.meshes.size(); ++index) {
        write_mesh(json, index, engine.meshes[index], engine);
    }
    json.end_array();

    json.key("materials");
    json.begin_array();
    for (std::size_t index = 0; index < engine.materials.size(); ++index) {
        write_material(json, index, engine.materials[index]);
    }
    json.end_array();

    json.key("draws");
    json.begin_array();
    write_draw_list(
        json,
        "opaque",
        render_plan.draw_lists.opaque,
        scene,
        engine,
        camera,
        view_projection);
    write_draw_list(
        json,
        "transparent",
        render_plan.draw_lists.transparent,
        scene,
        engine,
        camera,
        view_projection);
    json.end_array();

    json.key("backgroundUniforms");
    json.begin_array();
    if (scene.environment.has_skybox) {
        const upstream::SkyboxUniforms skybox =
            upstream::build_skybox_uniforms(
                scene.environment, scene.transmission_enabled);
        write_uniform_block(json, "fragment", 0, "SkyboxUniforms", skybox);
    }
#if BBLITE_SOLID_SKYBOX
    if (scene.environment.has_solid_skybox) {
        // The pinned 96-byte mesh block, so a capture pairs against the
        // browser's own skybox buffer by size.
        const upstream::SolidSkyboxUniforms solid_skybox =
            upstream::build_solid_skybox_uniforms(scene);
        write_uniform_block(
            json, "fragment", 0, "SolidSkyboxUniforms", solid_skybox);
    }
#endif
    if (scene.environment.has_ground) {
        const upstream::BackgroundUniforms background =
            upstream::build_background_uniforms(scene.environment, camera);
        write_uniform_block(
            json, "fragment", 0, "BackgroundUniforms", background);
    }
    json.end_array();

#if BBLITE_PBR_VARIANTS > 0
    // The material block our writers produce for every (material, variant) the
    // selector table names, straight from the same `write_pbr_variant_material`
    // the draw path calls. `scene -- uniforms <id> --size N` prints the
    // browser's own block field-labelled; this is the native half of that
    // comparison, so a disagreeing field is read off two listings instead of
    // reasoned about. Built on the CPU, so it captures variants the draw gate
    // currently refuses too.
    json.key("pinnedMaterialBlocks");
    json.begin_array();
    {
        std::vector<std::uint64_t> seen;
        for (const upstream::PbrVariantSelector& selector :
             upstream::pbr_variant_selectors) {
            if (selector.material_index >= engine.materials.size()) continue;
            const std::uint64_t pair =
                (static_cast<std::uint64_t>(selector.material_index) << 32) |
                selector.variant;
            if (std::find(seen.begin(), seen.end(), pair) != seen.end()) {
                continue;
            }
            seen.push_back(pair);
            const upstream::PbrVariantEntry& entry =
                upstream::pbr_variants[selector.variant];
            std::vector<float> block(entry.material_ubo_bytes / 4, 0.0f);
            upstream::write_pbr_variant_material(
                selector.variant,
                engine.materials[selector.material_index],
                block.data(),
                entry.material_ubo_bytes);
            json.begin_object();
            json.field("materialIndex", selector.material_index);
            json.field("variant", selector.variant);
            json.field("key", std::string(entry.key));
            json.field("bytes", entry.material_ubo_bytes);
            json.field("values", block.data(), block.size());
            json.end_object();
        }
    }
    json.end_array();
#endif

    json.end_object();
    stream << '\n';
}

} // namespace bbl::pal

#endif // BBLITE_HAS_PBR_RENDERER

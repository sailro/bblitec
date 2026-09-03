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

// The custom-shader stage blocks are reported through the same
// `shader_stage_block_floats` packing both backends push, so a capture
// diff can never disagree with an upload about the block's bytes.
#include "pal_gpu_shared.hpp"

// Two entry points serve two frame-loop families. `write_render_capture`
// is called from the two scene frame loops (pal_sdl_gpu.cpp,
// pal_dawn.cpp): it describes every renderable family a scene's own frame
// composes — meshes, splats, billboards, effect tasks, and the
// sprite/effect rendering contexts the engine records — and everything
// mesh, camera or plan it reads is generated only for a scene that
// registers one, so those writers ride the scene-renderer gates below.
// `write_standalone_render_capture` is called from the standalone frame
// loops (pal_*_sprite.cpp, pal_*_effect.cpp), which compile with no scene
// renderer at all: it writes the same document shape carrying the engine
// basics plus the sprite/effect sections, so the JSON machinery and those
// two family sections sit outside the scene envelope, each on its own
// family gate.

// The build stamp is read through `bblite_build_stamp()` (pal.hpp) rather
// than the generated header: including the digest here would put it in
// the including TUs' preprocessed text and force them to recompile per
// scene.
#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
#include <bblite/upstream/renderer_plan.hpp>
#if BBLITE_HAS_SPLATS
#include <bblite/upstream/splat_sort.hpp>
#endif
#if BBLITE_HAS_BILLBOARDS
// The system UBO builder, the instance layout and the pinned quad the
// billboard lowerer generated out of the pinned pipeline module.
#include <bblite/upstream/billboard_system.hpp>
#endif
#endif // BBLITE_HAS_PBR_RENDERER
#if BBLITE_HAS_BILLBOARDS || \
    (defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER)
// The layer UBO builder, shared by the 2D layer and — for the fx block
// sizes — the billboard family; generated whenever either is reached.
#include <bblite/upstream/sprite_layer.hpp>
#endif
#if defined(BBLITE_HAS_EFFECT_WRAPPER) && BBLITE_HAS_EFFECT_WRAPPER
// The variant table an effect wrapper draws through: stems, declared
// bindings and the uniform block's size.
#include <bblite/upstream/effect_variants.hpp>
#endif

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
inline std::uint64_t fold_payload(
    const std::vector<std::uint8_t>& bytes,
    std::uint64_t hash = 0xcbf29ce484222325ull) {
    for (const std::uint8_t byte : bytes) {
        hash ^= byte;
        hash *= 0x100000001b3ull;
    }
    return hash;
}

inline std::string digest_text(std::uint64_t hash) {
    std::ostringstream text;
    text << std::hex << std::setw(16) << std::setfill('0') << hash;
    return text.str();
}

/** Every level of a compressed payload, folded into one comparable digest. */
inline std::string payload_digest(const CompressedTexture& texture) {
    std::uint64_t hash = 0xcbf29ce484222325ull;
    for (const CompressedMipLevel& mip : texture.mips) {
        hash = fold_payload(mip.bytes, hash);
    }
    return digest_text(hash);
}

inline std::string payload_digest(const std::vector<std::uint8_t>& bytes) {
    return digest_text(fold_payload(bytes));
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

// The scene-frame writers: the plan's vocabulary and the scene-model
// records the draw lists read from, compiled only where the scene loops
// are (camera math and the render plan are generated only for a scene
// that registers one).
#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER

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
        case upstream::RenderMaterialKind::node: return "node";
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
        case upstream::RenderPipelineKind::pbr_opaque_back_clockwise:
            return "pbr_opaque_back_clockwise";
        case upstream::RenderPipelineKind::pbr_opaque_none:
            return "pbr_opaque_none";
        case upstream::RenderPipelineKind::pbr_opaque_none_clockwise:
            return "pbr_opaque_none_clockwise";
        case upstream::RenderPipelineKind::pbr_transparent_back:
            return "pbr_transparent_back";
        case upstream::RenderPipelineKind::pbr_transparent_back_clockwise:
            return "pbr_transparent_back_clockwise";
        case upstream::RenderPipelineKind::pbr_transparent_none:
            return "pbr_transparent_none";
        case upstream::RenderPipelineKind::pbr_transparent_none_clockwise:
            return "pbr_transparent_none_clockwise";
        case upstream::RenderPipelineKind::pbr_opaque_points:
            return "pbr_opaque_points";
        case upstream::RenderPipelineKind::pbr_opaque_lines:
            return "pbr_opaque_lines";
        case upstream::RenderPipelineKind::pbr_opaque_line_strip:
            return "pbr_opaque_line_strip";
        case upstream::RenderPipelineKind::pbr_transparent_points:
            return "pbr_transparent_points";
        case upstream::RenderPipelineKind::pbr_transparent_lines:
            return "pbr_transparent_lines";
        case upstream::RenderPipelineKind::pbr_transparent_line_strip:
            return "pbr_transparent_line_strip";
        case upstream::RenderPipelineKind::standard_opaque_back:
            return "standard_opaque_back";
        case upstream::RenderPipelineKind::standard_opaque_none:
            return "standard_opaque_none";
        case upstream::RenderPipelineKind::standard_transparent_back:
            return "standard_transparent_back";
        case upstream::RenderPipelineKind::standard_transparent_none:
            return "standard_transparent_none";
        case upstream::RenderPipelineKind::standard_opaque_back_clockwise:
            return "standard_opaque_back_clockwise";
        case upstream::RenderPipelineKind::standard_opaque_none_clockwise:
            return "standard_opaque_none_clockwise";
        case upstream::RenderPipelineKind::
            standard_transparent_back_clockwise:
            return "standard_transparent_back_clockwise";
        case upstream::RenderPipelineKind::
            standard_transparent_none_clockwise:
            return "standard_transparent_none_clockwise";

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
        case upstream::RenderPipelineKind::node_opaque_back:
            return "node_opaque_back";
        case upstream::RenderPipelineKind::node_opaque_none:
            return "node_opaque_none";
        case upstream::RenderPipelineKind::node_transparent_back:
            return "node_transparent_back";
        case upstream::RenderPipelineKind::node_transparent_none:
            return "node_transparent_none";
    }
    return "unknown";
}

inline const char* topology_name(MeshTopology topology) {
    switch (topology) {
        case MeshTopology::points: return "points";
        case MeshTopology::lines: return "lines";
        case MeshTopology::line_strip: return "line-strip";
        case MeshTopology::triangles: return "triangles";
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

inline void write_texture_slot(
    JsonWriter& json,
    const char* slot,
    const TextureData& texture) {
    if (!texture.has_image()) return;
    json.begin_object();
    json.field("slot", slot);
    // A compressed slot's payload is its blocks rather than `bytes`, and
    // its own chain rather than one the upload generates, so it reports
    // both — a diff against the browser's uploads compares the same
    // quantities either way.
    std::size_t byte_length = texture.bytes.size();
    std::string digest = payload_digest(texture.bytes);
    if (!texture.compressed.mips.empty()) {
        byte_length = 0;
        for (const CompressedMipLevel& mip : texture.compressed.mips) {
            byte_length += mip.bytes.size();
        }
        digest = payload_digest(texture.compressed);
        json.field("format", std::string(texture.compressed.format));
        json.field("mipLevels", texture.compressed.mips.size());
    }
    json.field("byteLength", byte_length);
    json.field("digest", digest);
    json.field("invertY", texture.invert_y);
    json.field("uvInvertY", texture.uv_invert_y);
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
        json, "occlusionTransform", material.occlusion_transform);
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
    write_texture_slot(
        json,
        "metallicReflectance",
        material.metallic_reflectance_texture);
    write_texture_slot(json, "reflectance", material.reflectance_texture);
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
        json.field("topology", topology_name(geometry.topology));
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
 * builders both backends call. The PBR arm is the one exception: no draw
 * uploads `PbrUniforms` any more, so its dump is the reduced base-lane
 * block documented at the arm itself.
 */
inline void write_draw_uniforms(
    JsonWriter& json,
    const Scene& scene,
    const Engine& engine,
    const CameraRecord& camera,
    const upstream::RenderDrawCommand& draw,
    const std::array<float, 16>& view_projection,
    // The pass's own factors beside its product, for a shader material
    // that declares one.
    const ShaderPassMatrices& pass_matrices) {
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
#if BBLITE_STANDARD_VARIANTS > 0
            // The transcribed StandardUniforms block is retired: the
            // draw path fills the pin's own 96-byte material mirror, so
            // the capture dumps the same bytes the same writer builds.
            const MaterialRecord* material =
                draw.item.material.value < engine.materials.size()
                    ? &engine.materials[draw.item.material.value]
                    : nullptr;
            std::uint32_t features = material
                ? upstream::standard_material_features(*material)
                : 0u;
            if (material && material->no_color) {
                features |= upstream::standard_no_color_output_flag;
            }
            const upstream::StandardMaterialUniforms fragment =
                standard_material_block(material, features);
            write_uniform_block(
                json,
                "fragment",
                0,
                "StandardMaterialUniforms",
                fragment);
#endif
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
            // reflected gathers, so it has no named struct to parse. Mirror
            // the real draw path's per-mesh world products before packing:
            // passing only the frame factors made capture fail for any
            // shader that declared worldView even though rendering itself
            // supplied it correctly.
            if (
                draw.item.material.value < engine.materials.size() &&
                draw.item.mesh.value < engine.meshes.size()) {
                const MaterialRecord& material =
                    engine.materials[draw.item.material.value];
                const ShaderDrawMatrices shader_matrices(
                    engine,
                    engine.meshes[draw.item.mesh.value],
                    pass_matrices);
                const ShaderPassMatrices shader_pass_matrices =
                    shader_matrices.apply(pass_matrices);
                const upstream::ShaderVariantInfo& info =
                    upstream::shader_variant_info(draw.item.shader_variant);
                // The scratch the shared packer fills -- the same
                // caller-owned shape both backends' draw loops thread
                // through it, reused here across the two stages.
                std::vector<float> stage_block_floats;
                const auto emit_block =
                    [&](
                        const upstream::ShaderVariantStageBlock& block,
                        const char* stage) {
                        if (!block.present) return;
                        shader_stage_block_floats(
                            block,
                            shader_pass_matrices,
                            material,
                            stage_block_floats);
                        write_float_block(
                            json,
                            stage,
                            0,
                            info.name,
                            stage_block_floats.data(),
                            stage_block_floats.size());
                    };
                emit_block(info.vertex, "vertex");
                emit_block(info.fragment, "fragment");
            }
            break;
        }
        case upstream::RenderMaterialKind::pbr:
        default: {
            // Reduced to the base lanes: PBR draws bind the pinned
            // material, scene and lights blocks, so the transcribed
            // struct now carries only the scene-and-light-derived values
            // a diff still pairs by name (analytic light slots, camera
            // basis, base material factors, harmonics). The option-gated
            // extension lanes it used to mirror -- fog, transmission,
            // texture transforms, specular, extra lights, clearcoat,
            // sheen, iridescence, occlusion -- are pruned from the
            // generated struct; their real values are the
            // pinnedMaterialBlocks section below and the capture's own
            // scene and lights dumps.
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
    const std::array<float, 16>& view_projection,
    const ShaderPassMatrices& pass_matrices) {
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
            json, scene, engine, camera, draw, view_projection,
            pass_matrices);
        json.end_object();
    }
}

#if BBLITE_HAS_SPLATS
/**
 * The Gaussian-splat renderable lives beside the render plan rather than in
 * either mesh draw list. Capture it at that same boundary so a splat-only
 * scene reports the indexed instanced draw and the exact UBO its pass writes.
 */
inline void write_splat_draw_list(
    JsonWriter& json,
    const Scene& scene,
    const Engine& engine,
    // The frame's own factors, built once by the caller: the pin's splat
    // UBO stores the view and the projection separately.
    const std::array<float, 16>& view,
    const std::array<float, 16>& projection,
    // The eye a cloud carrying harmonics builds its view direction from.
    [[maybe_unused]] const std::array<float, 4>& camera_position,
    int width,
    int height) {
    for (const SplatMeshHandle handle : scene.splat_meshes) {
        if (handle.value >= engine.splat_meshes.size()) continue;
        const SplatMeshRecord& splat = engine.splat_meshes[handle.value];
        if (splat.vertex_count == 0) continue;

        upstream::SplatUniforms uniforms;
        upstream::write_splat_uniforms(
            uniforms,
            upstream::build_splat_world(splat),
            view,
            projection,
            static_cast<double>(width),
            static_cast<double>(height),
            splat.texture_width,
            splat.texture_height
#if BBLITE_SPLAT_SH
            ,
            camera_position
#endif
        );

        json.begin_object();
        json.field("stage", "transparent");
        json.field("pipeline", "splat");
        json.field("materialKind", "splat");
        json.field("bucket", "alphaBlend");
        json.handle("mesh", invalid_handle);
        json.handle("material", invalid_handle);
        json.handle("geometry", invalid_handle);
        json.field("splat", handle.value);
        json.field("indexCount", 6u);
        json.field("vertexCount", 4u);
        json.field("instanceCount", splat.vertex_count);
        json.key("uniforms");
        json.begin_array();
        write_uniform_block(json, "vertex", 0, "SplatUniforms", uniforms);
        json.end_array();
        json.end_object();
    }
}
#endif
#endif // BBLITE_HAS_PBR_RENDERER (scene-frame writers)

#if BBLITE_HAS_BILLBOARDS || \
    (defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER)
// The sprite-family enums as names, and the two records both families
// share — spelled once so the billboard and layer writers cannot label the
// same descriptor differently.
inline const char* sprite_blend_factor_name(SpriteBlendFactor factor) {
    switch (factor) {
        case SpriteBlendFactor::zero: return "zero";
        case SpriteBlendFactor::one: return "one";
        case SpriteBlendFactor::src_alpha: return "src_alpha";
        case SpriteBlendFactor::one_minus_src_alpha:
            return "one_minus_src_alpha";
        case SpriteBlendFactor::dst: return "dst";
        case SpriteBlendFactor::dst_alpha: return "dst_alpha";
    }
    return "unknown";
}

inline const char* billboard_depth_mode_name(BillboardDepthMode mode) {
    return mode == BillboardDepthMode::cutout ? "cutout" : "transparent";
}

/** A pinned blend descriptor as the pure data it is (blend-as-data). */
inline void write_sprite_blend(
    JsonWriter& json,
    const char* name,
    const SpriteBlendDescriptor& blend) {
    json.key(name);
    json.begin_object();
    json.field("enabled", blend.enabled);
    json.field("depthMode", billboard_depth_mode_name(blend.depth_mode));
    json.field("colorSrc", sprite_blend_factor_name(blend.color.src));
    json.field("colorDst", sprite_blend_factor_name(blend.color.dst));
    json.field("alphaSrc", sprite_blend_factor_name(blend.alpha.src));
    json.field("alphaDst", sprite_blend_factor_name(blend.alpha.dst));
    json.field("premultipliedOpacity", blend.premultiplied_opacity);
    json.field("particlePasses", blend.particle_passes);
    json.end_object();
}

/**
 * Which atlas a layer or system samples: identity by digest rather than
 * payload, exactly as the material texture slots report theirs — the
 * digest answers "same asset in the same slot?" without dumping pixels.
 */
inline void write_sprite_atlas_reference(
    JsonWriter& json,
    const Engine& engine,
    SpriteAtlasHandle atlas) {
    json.key("atlas");
    json.begin_object();
    if (atlas.value < engine.sprite_atlases.size()) {
        const SpriteAtlasRecord& record = engine.sprite_atlases[atlas.value];
        json.field("index", atlas.value);
        json.field("width", record.width);
        json.field("height", record.height);
        json.field("frameCount", record.frames.size());
        json.field("premultipliedAlpha", record.premultiplied_alpha);
        json.field("mipMaps", record.mip_maps);
        json.field("byteLength", record.rgba.size());
        json.field("digest", payload_digest(record.rgba));
    }
    json.end_object();
}
#endif

// Billboards draw only inside a scene's frame (there is no standalone
// billboard loop), so their writer needs the scene envelope's camera math
// and rides both gates.
#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER && \
    BBLITE_HAS_BILLBOARDS
/**
 * The billboard renderables live beside the render plan rather than in
 * either mesh draw list, exactly as the splat cloud does. Capture them at
 * that same boundary, so a scene's billboard systems report the indexed
 * instanced draw the frame records, the program stems the shared
 * `billboard_draw_plan` selects for both backends, and the exact system
 * block their passes push (`build_billboard_system_ubo`).
 *
 * One entry per system whatever its `particle_passes`: the mode-4
 * wrapper's second stock-Add draw repeats the same six-index,
 * count-instance shape over the same instances and the same system block,
 * so the pass count rides the entry rather than duplicating it.
 *
 * The custom-shader fx block is deliberately not dumped: its first lane
 * is seconds since the system's first frame — backend frame-clock state,
 * not a value derivable from (scene, engine, camera) — and a fabricated
 * time would read as a divergence on a correct scene. The params half it
 * carries is the `shaderParams` field beside the draw.
 */
inline void write_billboard_draw_list(
    JsonWriter& json,
    const Scene& scene,
    const Engine& engine,
    const CameraRecord& camera,
    const std::array<float, 16>& view_projection) {
    // The same view the frame builds once for the sort and the draw.
    const std::array<float, 16> view = upstream::build_view_matrix(
        upstream::camera_world_matrix(camera));
    for (const BillboardSystemHandle handle : scene.billboard_systems) {
        if (handle.value >= engine.billboard_systems.size()) continue;
        const BillboardSystemRecord& system =
            engine.billboard_systems[handle.value];
        // The pass's own gate: an invisible or empty system records no
        // draw, so it must not describe one here either.
        if (!system.visible || system.count == 0) continue;
        const BillboardDrawPlan plan = billboard_draw_plan(system);
        const bool cutout =
            system.depth_mode == BillboardDepthMode::cutout;
        json.begin_object();
        // The slot the depth mode gives it: cutout draws among the opaque
        // meshes so everything after sees its depth; transparent closes
        // the scene's pass, blending over every stage above.
        json.field("stage", cutout ? "opaque" : "transparent");
        json.field("pipeline", "billboard");
        json.field("materialKind", "billboard");
        json.field("bucket", cutout ? "opaque" : "alphaBlend");
        json.handle("mesh", invalid_handle);
        json.handle("material", invalid_handle);
        json.handle("geometry", invalid_handle);
        json.field("billboardSystem", handle.value);
        json.field("vertexStem", plan.vertex_stem);
        json.field("fragmentStem", plan.fragment_stem);
        json.field(
            "orientation", plan.axis_locked ? "axisLocked" : "facing");
        json.field(
            "depthMode", billboard_depth_mode_name(system.depth_mode));
        json.field("depthWrites", plan.cutout_writes_depth);
        // A transparent system stages its instances back to front for the
        // view; a cutout one uploads in logical insertion order.
        json.field("sorted", !cutout);
        json.field("alphaToCoverage", system.alpha_to_coverage);
        json.field("alphaCutoff", system.alpha_cutoff);
        json.field("opacity", system.opacity);
        json.field("axis", system.axis);
        json.field("particlePasses", plan.particle_passes);
        json.field("customShader", system.custom_shader != 0u);
        json.field("customTextureCount", system.custom_textures.size());
        json.field("shaderParams", system.shader_params);
        write_sprite_blend(json, "blend", system.blend);
        if (plan.particle_passes >= 2) {
            write_sprite_blend(json, "addPassBlend", system.add_pass_blend);
        }
        write_sprite_atlas_reference(json, engine, system.atlas);
        json.field(
            "indexCount", upstream::billboard_index_data.size());
        json.field("vertexCount", 4u);
        json.field("instanceCount", system.count);
        json.field("capacity", system.capacity);
        json.field(
            "instanceFloatsPerSprite", system.instance_floats_per_sprite);
        json.key("uniforms");
        json.begin_array();
        {
            // The reconstructed vertex stage's own block: view-projection
            // then view, pushed as one block by both backends
            // (`BillboardSceneUniforms`).
            std::array<float, 32> scene_block{};
            std::copy(
                view_projection.begin(),
                view_projection.end(),
                scene_block.begin());
            std::copy(view.begin(), view.end(), scene_block.begin() + 16);
            write_float_block(
                json,
                "vertex",
                0,
                "BillboardSceneUniforms",
                scene_block.data(),
                scene_block.size());
            // The per-system block, from the same builder both backends
            // push — to the fragment stage always, and to the axis-locked
            // vertex stage too, which reads its lock axis from it.
            std::array<float, upstream::billboard_system_ubo_bytes / 4>
                system_ubo{};
            upstream::build_billboard_system_ubo(system, system_ubo);
            write_float_block(
                json,
                "fragment",
                0,
                "BillboardSystemUniforms",
                system_ubo.data(),
                system_ubo.size());
        }
        json.end_array();
        json.end_object();
    }
}
#endif

#if defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER
/**
 * The 2D sprite rendering contexts the engine records, layers in the
 * draw order `sprite_layer_draw_order` decides for both backends, each
 * with the exact sixteen-float layer block its pass pushes
 * (`build_sprite_layer_ubo`) and the six-index, count-instance draw shape.
 *
 * Both scene backends and the sprite-only loops use this writer, so capture
 * describes the same ordered overlay contexts that the submitted frame draws.
 *
 * The custom-shader fx block is skipped for the billboard writer's
 * reason: its time lane is frame-clock state; the params ride the layer.
 */
inline void write_sprite_renderer_list(
    JsonWriter& json,
    const Engine& engine,
    int width,
    int height) {
    for (std::size_t index = 0;
         index < engine.sprite_renderers.size();
         ++index) {
        const SpriteRendererRecord& renderer =
            engine.sprite_renderers[index];
        bool registered = false;
        for (const SpriteRendererHandle candidate :
             engine.registered_sprite_renderers) {
            if (candidate.value == static_cast<std::uint32_t>(index)) {
                registered = true;
                break;
            }
        }
        json.begin_object();
        json.field("index", index);
        json.field("registered", registered);
        json.field("clear", renderer.clear);
        json.field("clearValue", renderer.clear_value);
        json.key("layers");
        json.begin_array();
        for (const std::size_t slot :
             sprite_layer_draw_order(engine, renderer)) {
            const Sprite2DLayerHandle handle = renderer.layers[slot];
            if (handle.value >= engine.sprite_layers.size()) continue;
            const Sprite2DLayerRecord& layer =
                engine.sprite_layers[handle.value];
            json.begin_object();
            json.field("layer", handle.value);
            json.field("order", layer.order);
            // The pass's own gate rides along as data: an invisible or
            // empty layer records no draw.
            json.field("visible", layer.visible);
            json.field("opacity", layer.opacity);
            json.field("count", layer.count);
            json.field("capacity", layer.capacity);
            json.field(
                "instanceFloatsPerSprite",
                layer.instance_floats_per_sprite);
            json.field("uvScroll", layer.uv_scroll);
            json.field("customShader", layer.custom_shader != 0u);
            json.field(
                "customTextureCount", layer.custom_textures.size());
            json.field("shaderParams", layer.shader_params);
            json.field("pivot", layer.pivot);
            json.key("view");
            json.begin_object();
            json.field("positionPx", layer.view.position_px);
            json.field("zoom", layer.view.zoom);
            json.field("rotation", layer.view.rotation);
            json.end_object();
            write_sprite_blend(json, "blend", layer.blend);
            write_sprite_atlas_reference(json, engine, layer.atlas);
            json.field("indexCount", 6u);
            json.field("vertexCount", 4u);
            json.field("instanceCount", layer.count);
            json.key("uniforms");
            json.begin_array();
            {
                // Pushed to the vertex stage at slot zero and to the
                // fragment slot its own compiled stage kept, by both
                // backends; one block either way.
                std::array<float, 16> ubo{};
                upstream::build_sprite_layer_ubo(
                    layer,
                    static_cast<float>(width),
                    static_cast<float>(height),
                    ubo);
                write_float_block(
                    json,
                    "vertex",
                    0,
                    "SpriteLayerUniforms",
                    ubo.data(),
                    ubo.size());
            }
            json.end_array();
            json.end_object();
        }
        json.end_array();
        json.end_object();
    }
}
#endif

#if defined(BBLITE_HAS_EFFECT_WRAPPER) && BBLITE_HAS_EFFECT_WRAPPER
/**
 * The fullscreen-effect state: every wrapper with the exact uniform floats
 * `setEffectUniforms` wrote (already padded to the declared block size by
 * the setter) and its texture bindings by declared name; the effect
 * rendering contexts; and — where the frame graph reaches them — the
 * effect render tasks with their targets. All of it is the same records
 * `create_effect_pass` and `record_effect_pass` read, never the API.
 *
 * The tasks are the in-scene half (`effect:task`, drawn inside the
 * scene's frame). An effect-renderer-only scene draws through
 * `pal_*_effect.cpp`, which writes this same section through
 * `write_standalone_render_capture` below.
 */
inline void write_effect_state(JsonWriter& json, const Engine& engine) {
    json.begin_object();
    json.key("wrappers");
    json.begin_array();
    for (std::size_t index = 0;
         index < engine.effect_wrappers.size();
         ++index) {
        const EffectWrapperRecord& wrapper = engine.effect_wrappers[index];
        if (wrapper.variant >= upstream::effect_variants.size()) continue;
        const upstream::EffectVariantEntry& entry =
            upstream::effect_variants.at(wrapper.variant);
        // The declared uniform block's size, from the same variant table
        // both passes size their push and their refusal with.
        std::uint32_t uniform_bytes = 0;
        for (std::size_t binding = 0;
             binding < entry.binding_count;
             ++binding) {
            const upstream::EffectVariantBinding& row =
                upstream::effect_variant_bindings.at(
                    entry.first_binding + binding);
            if (row.kind == upstream::EffectBindingKind::uniform) {
                uniform_bytes = row.uniform_bytes;
            }
        }
        json.begin_object();
        json.field("index", index);
        json.field("variant", wrapper.variant);
        json.field("name", std::string(entry.name));
        json.field("vertexStem", std::string(entry.vertex_stem));
        json.field("fragmentStem", std::string(entry.fragment_stem));
        json.field("uniformBytes", uniform_bytes);
        json.key("textures");
        json.begin_array();
        for (const EffectTextureSlot& slot : wrapper.textures) {
            json.begin_object();
            json.field("name", slot.name);
            json.field("set", slot.set);
            json.field("color", slot.texture.color);
            // The rounded byte IS the texture (`create_solid_texture`),
            // so the texel is what a browser upload can be paired with.
            json.key("texel");
            json.begin_array();
            for (const std::uint8_t channel : slot.texture.texel) {
                json.value(static_cast<std::uint32_t>(channel));
            }
            json.end_array();
            json.end_object();
        }
        json.end_array();
        json.key("uniforms");
        json.begin_array();
        if (!wrapper.uniform_values.empty()) {
            write_float_block(
                json,
                "fragment",
                0,
                "EffectUniforms",
                wrapper.uniform_values.data(),
                wrapper.uniform_values.size());
        }
        json.end_array();
        json.end_object();
    }
    json.end_array();

    // Registration order is draw order across rendering contexts, as it
    // is for the sprite half.
    json.key("renderers");
    json.begin_array();
    for (std::size_t index = 0;
         index < engine.effect_renderers.size();
         ++index) {
        const EffectRendererRecord& renderer =
            engine.effect_renderers[index];
        bool registered = false;
        for (const EffectRendererHandle candidate :
             engine.registered_effect_renderers) {
            if (candidate.value == static_cast<std::uint32_t>(index)) {
                registered = true;
                break;
            }
        }
        json.begin_object();
        json.field("index", index);
        json.handle("effect", renderer.effect.value);
        json.field("registered", registered);
        json.field("clear", renderer.clear);
        json.field("clearColor", renderer.clear_color);
        json.end_object();
    }
    json.end_array();

#if defined(BBLITE_HAS_EFFECT_TASK) && BBLITE_HAS_EFFECT_TASK
    json.key("tasks");
    json.begin_array();
    for (std::size_t index = 0; index < engine.frame_tasks.size(); ++index) {
        const FrameTaskRecord& task = engine.frame_tasks[index];
        if (task.kind != FrameTaskKind::effect) continue;
        json.begin_object();
        json.field("taskIndex", index);
        json.field("name", task.effect.name);
        json.handle("effect", task.effect.effect.value);
        json.handle("target", task.effect.target.value);
        json.field("clear", task.effect.clear);
        json.field("clearColor", task.effect.clear_color);
        if (task.effect.target.value < engine.render_targets.size()) {
            const RenderTargetRecord& target =
                engine.render_targets[task.effect.target.value];
            json.field("targetWidth", target.width);
            json.field("targetHeight", target.height);
            json.field("targetSamples", target.samples);
            json.field("targetSwapchain", target.swapchain);
        }
        json.end_object();
    }
    json.end_array();
#endif
    json.end_object();
}
#endif

#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
/**
 * Write the whole frame of a scene.
 *
 * Called from each backend's scene frame loop at the frame the screenshot
 * is taken, so the capture describes the image that was measured rather
 * than some other frame of the same run.
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
    json.field("buildStamp", bblite_build_stamp());
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
#if BBLITE_HAS_BILLBOARDS
    json.field("billboardSystemCount", scene.billboard_systems.size());
#endif
#if defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER
    json.field("spriteRendererCount", engine.sprite_renderers.size());
#endif
#if defined(BBLITE_HAS_EFFECT_WRAPPER) && BBLITE_HAS_EFFECT_WRAPPER
    json.field("effectWrapperCount", engine.effect_wrappers.size());
#endif
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
    // The frame's own factors beside its product, exactly as the two
    // frame loops build them before the uploads this describes.
    // getEffectiveAspectRatio divides two JavaScript numbers, exactly as
    // the frame loops do before building the matrix passed in here.
    const double capture_aspect =
        static_cast<double>(width) / static_cast<double>(height);
    const std::array<float, 16> frame_view = upstream::build_view_matrix(
        upstream::camera_world_matrix(camera));
    const std::array<float, 16> frame_projection =
        upstream::build_scene_projection(camera, capture_aspect);
    const std::array<float, 4> frame_camera_position =
        shader_camera_position(scene, engine, camera);
    ShaderPassMatrices frame_pass_matrices{
        view_projection.data(), &frame_view, &frame_projection};
    frame_pass_matrices.camera_position = &frame_camera_position;
    write_draw_list(
        json,
        "opaque",
        render_plan.draw_lists.opaque,
        scene,
        engine,
        camera,
        view_projection,
        frame_pass_matrices);
    write_draw_list(
        json,
        "transparent",
        render_plan.draw_lists.transparent,
        scene,
        engine,
        camera,
        view_projection,
        frame_pass_matrices);
#if BBLITE_HAS_SPLATS
    write_splat_draw_list(
        json,
        scene,
        engine,
        frame_view,
        frame_projection,
        frame_camera_position,
        width,
        height);
#endif
#if BBLITE_HAS_BILLBOARDS
    write_billboard_draw_list(json, scene, engine, camera, view_projection);
#endif
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
            upstream::build_background_uniforms(
                scene.environment, camera, scene.transmission_enabled);
        write_uniform_block(
            json, "fragment", 0, "BackgroundUniforms", background);
    }
    json.end_array();

#if defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER
    json.key("spriteRenderers");
    json.begin_array();
    write_sprite_renderer_list(json, engine, width, height);
    json.end_array();
#endif

#if defined(BBLITE_HAS_EFFECT_WRAPPER) && BBLITE_HAS_EFFECT_WRAPPER
    json.key("effects");
    write_effect_state(json, engine);
#endif

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

    // The pin's per-draw mesh block for every PBR draw, and each mesh's bone
    // palette, from the same builders the draw path calls. The browser half is
    // the capture's 144-byte buffers and its rgba32float texture upload; this
    // is ours, so the skinning comparison is two listings like the material
    // block's.
    json.key("pinnedMeshBlocks");
    json.begin_array();
    {
        const auto dump_list = [&](const upstream::RenderDrawList& list) {
            for (const upstream::RenderDrawCommand& draw : list.commands) {
                if (
                    draw.item.material_kind !=
                    upstream::RenderMaterialKind::pbr) {
                    continue;
                }
                // Deliberately the identity world, not the draw's own
                // `pinned_draw_world` chain: the capture rebuilds blocks
                // from (scene, engine, item) without the per-draw
                // instance context the encoders carry, so an instanced
                // or local-position world here would be a re-derivation
                // the diff could disagree with for the wrong reason. A
                // wrong world in the real draw surfaces in the
                // SDL-versus-Dawn differential and the mesh-matrix rows
                // of `scene -- diff`, which read the browser's uploads.
                const upstream::MeshUniforms block = pinned_mesh_block(
                    scene,
                    engine,
                    pinned_mesh_world(),
                    draw.item.mesh.value);
                json.begin_object();
                json.field("meshIndex", draw.item.mesh.value);
                json.field("world", block.world.data(), block.world.size());
                json.field("lightCount", block.lc);
                if (draw.item.mesh.value < engine.meshes.size()) {
                    const MeshRecord& record =
                        engine.meshes[draw.item.mesh.value];
                    json.field("boneCount", record.bone_matrices.size());
                    if (!record.bone_matrices.empty()) {
                        json.field(
                            "bone0",
                            record.bone_matrices[0].data(),
                            record.bone_matrices[0].size());
                    }
                    if (record.bone_matrices.size() > 1) {
                        json.field(
                            "bone1",
                            record.bone_matrices[1].data(),
                            record.bone_matrices[1].size());
                    }
                }
                json.end_object();
            }
        };
        dump_list(render_plan.draw_lists.opaque);
        dump_list(render_plan.draw_lists.transparent);
    }
    json.end_array();
#endif


    json.end_object();
    stream << '\n';
}
#endif // BBLITE_HAS_PBR_RENDERER (write_render_capture)

// Compiled exactly where a standalone loop exists to call it — a build
// with neither standalone renderer would hold an unreachable definition.
#if (defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER) || \
    (defined(BBLITE_HAS_EFFECT_RENDERER) && BBLITE_HAS_EFFECT_RENDERER) || \
    (defined(BBLITE_HAS_FRAME_GRAPH_RENDERER) && BBLITE_HAS_FRAME_GRAPH_RENDERER)
/**
 * Write the frame of a scene with no scene renderer.
 *
 * The standalone frame loops (`pal_*_sprite.cpp`, `pal_*_effect.cpp`)
 * compile with no camera math and no render plan, so their document
 * carries the engine basics the scene document does where they apply —
 * backend, build stamp, frame, viewport, the family counts — plus the
 * `spriteRenderers` and/or `effects` sections the build compiles. The
 * mesh-family arrays are present and empty rather than absent, so the
 * diff reader sees one document shape, not two.
 *
 * Called at the frame the screenshot gate names, exactly as the scene
 * loops write theirs, so the capture describes the presented image.
 */
inline void write_standalone_render_capture(
    const std::string& path,
    const char* backend,
    const Engine& engine,
    int width,
    int height,
    long frame) {
    (void)engine;
    std::ofstream stream(path, std::ios::binary | std::ios::trunc);
    if (!stream) {
        throw std::runtime_error(
            "Unable to write the render capture to '" + path + "'.");
    }
    JsonWriter json(stream);
    json.begin_object();
    json.field("backend", backend);
    json.field("buildStamp", bblite_build_stamp());
    json.field("frame", static_cast<int>(frame));
    json.key("viewport");
    json.begin_object();
    json.field("width", width);
    json.field("height", height);
    json.end_object();

    // The family counts the scene document's own `scene` section carries,
    // read from the engine because a standalone frame has no Scene.
    json.key("scene");
    json.begin_object();
#if defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER
    json.field("spriteRendererCount", engine.sprite_renderers.size());
#endif
#if defined(BBLITE_HAS_EFFECT_WRAPPER) && BBLITE_HAS_EFFECT_WRAPPER
    json.field("effectWrapperCount", engine.effect_wrappers.size());
#endif
    json.end_object();

    // No render plan and no background pass exist on this loop; the draws
    // this frame records are the family sections below.
    json.key("draws");
    json.begin_array();
    json.end_array();
    json.key("backgroundUniforms");
    json.begin_array();
    json.end_array();

#if defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER
    json.key("spriteRenderers");
    json.begin_array();
    write_sprite_renderer_list(json, engine, width, height);
    json.end_array();
#endif

#if defined(BBLITE_HAS_EFFECT_WRAPPER) && BBLITE_HAS_EFFECT_WRAPPER
    json.key("effects");
    write_effect_state(json, engine);
#endif

    json.end_object();
    stream << '\n';
}
#endif // standalone renderers

// Declared on CaptureGate (pal_gpu_shared.hpp); defined here beside the
// writer it calls — under the same standalone-renderer gate — so a TU
// including only the shared header carries no undefined inline, and a
// scene-only build compiles neither half.
#if (defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER) || \
    (defined(BBLITE_HAS_EFFECT_RENDERER) && BBLITE_HAS_EFFECT_RENDERER) || \
    (defined(BBLITE_HAS_FRAME_GRAPH_RENDERER) && BBLITE_HAS_FRAME_GRAPH_RENDERER)
inline void CaptureGate::maybe_write_standalone_render_capture(
    const char* backend,
    const Engine& engine,
    std::uint32_t width,
    std::uint32_t height,
    long frame) {
    if (frame < options_->screenshot_frame ||
        render_capture_saved ||
        options_->render_capture_path.empty()) {
        return;
    }
    write_standalone_render_capture(
        options_->render_capture_path,
        backend,
        engine,
        static_cast<int>(width),
        static_cast<int>(height),
        frame);
    render_capture_saved = true;
}
#endif // standalone renderers (CaptureGate::maybe_write_standalone_render_capture)

} // namespace bbl::pal

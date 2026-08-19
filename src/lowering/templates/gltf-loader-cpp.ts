/**
 * The generated glTF loader.
 *
 * `nonTrianglePrimitives` mirrors the predicate behind Babylon Lite's
 * dynamically imported `gltf-feature-primitive.js`: a primitive whose mode
 * is not the triangle-list default. Upstream keeps topology off its core
 * path deliberately (`pbr-primitive-topology.ts` is a module of its own so
 * ordinary PBR scenes never carry the topology names), so a scene whose
 * assets are all triangle lists emits this loader without any of it.
 *
 * `lowered` carries the segments produced from the pinned ASTs at
 * generation time (`gltf-lowerer.ts`), replacing what used to be
 * hand-transcribed C++ in this string: a changed pinned formula now
 * changes — or refuses — the emitted loader instead of leaving stale
 * text behind an unrelated assertion.
 */
export interface GltfLoaderLoweredSegments {
    /**
     * `normalize_quaternion`, `interpolate_quaternion`, `cubic_quaternion`
     * and `cubic_vec3`, lowered from `src/animation/evaluate.ts`
     * (`normalizeQuat4`, `quatSlerp`, and `evaluateSampler`'s CUBICSPLINE
     * branch).
     */
    animationInterpolation: string;
    /**
     * The sampler filter/wrap mapping inside `texture_data`, lowered from
     * `src/loader-gltf/gltf-sampler-desc.ts#gltfTexSamplerDesc`.
     */
    samplerMapping: string;
    /**
     * The four integer componentType clauses of `read_component`, lowered
     * from `src/loader-gltf/gltf-ext-quantization.ts#readComponent` — the
     * byte/ubyte/short/ushort scale factors and the signed clamps.
     */
    accessorNormalization: string;
    /**
     * The COLOR_0 → Vec4 build, lowered from
     * `src/loader-gltf/gltf-color-normalize.ts#normalizeColorToVec4`: the
     * channel order, the VEC3 alpha default, and the proof that the pinned
     * color divisors are the accessor divisors `read_component` applies.
     */
    vertexColor: string;
    /**
     * `pre_scale_harmonics`, lowered from
     * `src/loader-gltf/ibl-env-assembly.ts#polynomialToPreScaledHarmonics`
     * (the private copy the pinned EXT_lights_image_based feature executes,
     * proven identical to `src/loader-env/load-env.ts`'s canonical).
     */
    shPrescale: string;
    /**
     * The image-processing defaults the pinned EXT_lights_image_based
     * `_sceneSetup` writes, lowered from
     * `src/loader-gltf/gltf-ext-lights-image-based.ts`.
     */
    imageProcessingDefaults: string;
    /**
     * The dielectric/ior/dispersion/iridescence JSON keys and default
     * constants, lowered from `src/loader-gltf/gltf-ext-dielectric.ts` and
     * `src/loader-gltf/gltf-ext-iridescence.ts`.
     */
    extensionDefaults: GltfExtensionDefaults;
    /**
     * The remaining material JSON keys and default constants, lowered
     * from `gltf-material.ts#assembleMaterial`, the dielectric
     * specular-factor treatment, the KHR_texture_transform identity
     * (`gltf-ext-uv-transform.ts` + the pinned writer's defaults), and
     * the clearcoat/sheen/emissive-strength option objects.
     */
    materialDefaults: GltfMaterialDefaults;
    /**
     * The factor-bake helpers and their byte constants, lowered from
     * `src/math/color.ts#linearToSrgbByte` and the pinned factor-texture
     * bakes (`src/loader-gltf/gltf-pbr-builder.ts`
     * `uploadBaseColorFactorTexture` / `uploadOrmFactorTexture`).
     */
    factorBake: GltfFactorBake;
    /**
     * `multiply_matrix`, lowered from
     * `src/math/mat4-multiply-into.ts#mat4MultiplyInto` — the pin's fully
     * unrolled product sums verified term by term, emitted as the loop
     * the loader has always carried.
     */
    matrixMultiply: string;
    /**
     * `local_matrix`, lowered from
     * `src/loader-gltf/gltf-parser.ts#computeNodeWorldMatrix` (the
     * authored-matrix arm, the three JSON keys and their whole-array
     * defaults, the compose argument order) through the same
     * `mat4ComposeInto` walk `trs_matrix` uses — but reading the raw
     * JSON doubles and rounding once per lane at the store, which is
     * the pin's own precision chain. See the round-3/4 notes in
     * `gltf-lowerer.ts`.
     */
    matrixLocal: string;
    /**
     * `trs_matrix`, lowered from
     * `src/math/mat4-compose-into.ts#mat4ComposeInto` — every product
     * local and store expression comes from the pin.
     */
    matrixCompose: string;
    /**
     * `native_matrix`, anchored to
     * `src/loader-gltf/gltf-parser.ts#RH_TO_LH_ROOT`. The function itself
     * is the record's convention (the diagonal change of basis applied at
     * consumption instead of the pin's root-level left multiply), so only
     * the flip axis and sign flow from the pin.
     */
    matrixNative: string;
    /**
     * The EXT_lights_image_based SH9 → spherical-polynomial conversion of
     * `load_image_based_environment`, lowered from
     * `src/loader-gltf/gltf-ext-lights-image-based.ts#irradianceCoefficientsToPolynomial`
     * (band constants, slot layout, the intensity/π prescale) plus the
     * feature's `applyAsset` intensity default.
     */
    iblPolynomial: string;
    /**
     * The IBL environment scalars that follow it — the LOD generation
     * scale, the rotation yaw, and the BRDF LUT width — lowered from the
     * same feature's `applyAsset`/`envYawFromQuaternion` and from
     * `src/loader-gltf/ibl-env-assembly.ts#generateBrdfLut`.
     */
    iblEnvironmentScalars: string;
    /**
     * The KHR_lights_punctual record build — type strings, the spot
     * outer-cone default, the color/intensity/range defaults, and the
     * position/direction sign convention — lowered from
     * `src/loader-gltf/gltf-feature-lights-punctual.ts#applyAsset`,
     * `src/light/spot-light.ts#createSpotLight`, and the parser's
     * `RH_TO_LH_ROOT`.
     */
    punctualLightLoading: string;
}

/** One lowered glTF extension default: the JSON key and the C++ literal. */
export interface GltfLoweredDefault {
    key: string;
    literal: string;
}

/**
 * The pinned factor bakes: `unorm_byte` / `linear_to_srgb_byte`
 * emitted whole, plus the round-clamp-scale constants the material
 * build inlines for the base-color alpha lane and the ORM texel's
 * constant opaque lanes.
 */
export interface GltfFactorBake {
    helpers: string;
    /** `Math.round(clamp(v, lo, hi) * scale)` as float literals. */
    unormClampLo: string;
    unormClampHi: string;
    unormScale: string;
    /** The pinned ORM texel's constant occlusion/alpha byte. */
    opaqueByte: string;
}

export interface GltfExtensionDefaults {
    ior: GltfLoweredDefault;
    transmissionFactor: GltfLoweredDefault;
    thicknessFactor: GltfLoweredDefault;
    attenuationDistance: GltfLoweredDefault;
    dispersion: GltfLoweredDefault;
    /** Babylon's fixed Abbe numerator in `strength = 20 / dispersion`. */
    dispersionScale: string;
    iridescenceFactor: GltfLoweredDefault;
    iridescenceIor: GltfLoweredDefault;
    iridescenceThicknessMinimum: GltfLoweredDefault;
    iridescenceThicknessMaximum: GltfLoweredDefault;
}

/**
 * The round-4 material defaults — see the round-4 notes in
 * `gltf-lowerer.ts` for the absent-arm asymmetries (the base color's
 * native default, the texture-transform identity, the doubleSided
 * coercion).
 */
export interface GltfMaterialDefaults {
    /** Key only: the absent arm is the record's native Color4{1,1,1,1}. */
    baseColorFactorKey: string;
    metallicFactor: GltfLoweredDefault;
    roughnessFactor: GltfLoweredDefault;
    /** The key plus the identity seed the loader writes before the read. */
    emissiveFactor: { key: string; identity: string };
    /** glTF `normalTexture.scale`. */
    normalScale: GltfLoweredDefault;
    /** glTF `occlusionTexture.texCoord`; the literal is an integer. */
    occlusionTexCoord: GltfLoweredDefault;
    alphaMode: { key: string; literal: string };
    /** Key only: `bool_or(..., false)` is the pin's `!!` coercion. */
    doubleSidedKey: string;
    alphaCutoff: GltfLoweredDefault;
    /** A factor within `epsilon` of `clear` drops both pinned options. */
    specularFactor: { key: string; clear: string; epsilon: string };
    /** `((ior - one) / (ior + one)) ** 2 / baseReflectance`. */
    iorToF0: { one: string; baseReflectance: string };
    /** The `!== unit` triple gating the dielectric tint, and its length. */
    specularColor: { key: string; length: string; unit: string };
    /** KHR_texture_transform: the three field keys; rotation's identity. */
    textureTransform: {
        rotation: GltfLoweredDefault;
        scaleKey: string;
        offsetKey: string;
    };
    /** `clearcoatFactor ?? (clearcoatTexture ? present : absent)`. */
    clearcoatIntensity: { key: string; present: string; absent: string };
    clearcoatRoughness: { key: string; present: string; absent: string };
    clearcoatNormalScale: GltfLoweredDefault;
    sheenColor: { key: string; identity: string };
    sheenRoughness: GltfLoweredDefault;
    sheenIntensity: string;
    emissiveStrength: GltfLoweredDefault;
}

export function gltfLoaderCpp(
    provenance: string,
    lowered: GltfLoaderLoweredSegments,
    nonTrianglePrimitives = false,
    nodeVisibility = false,
    animationPointer = false,
    animatedWorldBounds = false,
    animationPointerMaterials = false,
    assetTransmission = false,
    materialSpecular = false,
    /**
     * The `KHR_materials_variants` name a scene's `selectVariant` chose, or
     * "" when unreached. One static selection is the reached shape, so the
     * name is the only compile-time input: the variant order and the
     * per-primitive mappings are read from the document, like every other
     * asset fact.
     */
    selectedMaterialVariant = "",
): string {
    // The scene selected a variant, so the loader resolves each mapped
    // primitive's material. `JSON.stringify` is the C++ string literal: the
    // name is asset-declared text, and every other interpolated literal in
    // this template is a pin-derived JSON key that needs no escaping.
    const materialVariants = selectedMaterialVariant !== "";
    const selectedVariantLiteral = JSON.stringify(selectedMaterialVariant);
    const defaults = lowered.extensionDefaults;
    const materialDefaults = lowered.materialDefaults;
    const factorBake = lowered.factorBake;
    return `// ${provenance}
#include <bblite/pal_gltf.hpp>
#include <bblite/runtime.hpp>
#include <bblite/ts_runtime.hpp>
#include <bblite/upstream/gltf_glb_parser.hpp>
#include <bblite/upstream/render_capabilities.hpp>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <limits>
#include <memory>
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

// The raw JSON doubles, for the one consumer whose pin composes them in
// double precision before its Float32Array store (local_matrix).
std::vector<double> double_array(const ts::JsonValue* value) {
    if (!value) return {};
    std::vector<double> result;
    for (const ts::JsonValue& element : value->as_array()) {
        result.push_back(element.as_number());
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

using Matrix = std::array<float, 16>;

struct RotationTrack {
    std::size_t clip = 0;
    std::size_t node = 0;
    bool cubic = false;
    std::vector<float> times;
    std::vector<Vec4> values;
    std::vector<Vec4> in_tangents;
    std::vector<Vec4> out_tangents;
};

struct TranslationTrack {
    std::size_t clip = 0;
    std::size_t node = 0;
    bool cubic = false;
    std::vector<float> times;
    std::vector<Vec3> values;
    std::vector<Vec3> in_tangents;
    std::vector<Vec3> out_tangents;
};

struct WeightTrack {
    std::size_t clip = 0;
    std::size_t node = 0;
    std::size_t target_count = 0;
    std::vector<float> times;
    std::vector<float> values;
};${animationPointer ? `

struct VisibilityTrack {
    std::size_t clip = 0;
    std::size_t node = 0;
    // The target node and every descendant, resolved once at load. The
    // pinned writer calls setSubtreeVisible on each evaluation, which
    // materializes the KHR_node_visibility cascade rather than testing
    // ancestors while drawing.
    std::vector<std::size_t> subtree;
    std::vector<float> times;
    std::vector<bool> values;
};

enum class LightTrackKind {
    color,
    intensity,
    range,
    outer_cone_angle,
};

// A light instantiated on an animated node. The pinned loader parents the
// light to that node, so its world position and direction follow the node
// every frame; ours bakes them at load, which leaves an animated light
// shining from wherever it started.
struct AnimatedLightBinding {
    LightHandle light{};
    std::size_t node = 0;
};

struct LightTrack {
    std::size_t clip = 0;
    LightHandle light{};
    LightTrackKind kind = LightTrackKind::color;
    std::vector<float> times;
    std::vector<Vec4> values;
};

// Pointer targets the pinned resolver has no handler for. Its registry is a
// list of patterns and anything outside it returns null, so the channel is
// warned about once and then never applied — the browser renders as though the
// asset had not authored it. Reproducing that is a parity requirement rather
// than a shortcut: implementing one of these would animate a value the
// reference holds still. Each entry is absent from the pinned registry for its
// own reason:
//   - roughnessFactor: Babylon.js registers the metallicFactor pointer twice
//     and the second registration animates roughness, so roughnessFactor
//     itself is never registered. The pin matches that deliberately.
//   - alphaCutoff and the camera planes: no handler in any pointer module.
//   - spot/innerConeAngle: the lights module handles color, intensity, range
//     and spot/outerConeAngle only.
bool pointer_unhandled_upstream(const std::string& pointer) {
    const auto tail_after_index =
        [&pointer](const std::string& prefix) -> std::string {
        if (pointer.rfind(prefix, 0) != 0) return std::string();
        const std::size_t start = prefix.size();
        std::size_t end = start;
        while (end < pointer.size() && std::isdigit(
                   static_cast<unsigned char>(pointer[end]))) {
            ++end;
        }
        if (end == start) return std::string();
        return pointer.substr(end);
    };
    const std::string material_tail = tail_after_index("/materials/");
    if (
        material_tail == "/pbrMetallicRoughness/roughnessFactor" ||
        material_tail == "/alphaCutoff") {
        return true;
    }
    if (!tail_after_index("/cameras/").empty()) return true;
    return tail_after_index("/extensions/KHR_lights_punctual/lights/") ==
        "/spot/innerConeAngle";
}` : ""}${animationPointerMaterials ? `

enum class MaterialTrackKind {
    base_color_factor,
    emissive_factor,
    emissive_strength,
    texture_transform,
    // Babylon.js registers the glTF metallicFactor pointer twice and the
    // second registration animates roughness, so a metallicFactor channel
    // drives the roughness factor and metallic itself is never animated. The
    // pin matches that for parity and says so; roughnessFactor has no handler
    // at all.
    roughness_from_metallic,
    normal_texture_scale,
    occlusion_strength,
    transmission_factor,
    index_of_refraction,
    volume_thickness,
    volume_attenuation_distance,
    volume_attenuation_color,
    iridescence_factor,
    iridescence_index_of_refraction,
    iridescence_maximum_thickness,
};

// Which texture slot's transform a KHR_texture_transform pointer drives, and
// which of its three components. The pin resolves the slot to the runtime
// texture wrapper and writes uAng, uOffset/vOffset or uScale/vScale on it;
// per-slot transforms live on the material record here, so the slot travels as
// a tag rather than as a pointer into a vector that reallocates.
enum class TextureTransformSlot {
    base_color,
    orm,
    normal,
    emissive,
    clearcoat,
    clearcoat_roughness,
    clearcoat_normal,
    sheen,
    sheen_roughness,
    iridescence,
    iridescence_thickness,
    transmission,
    thickness,
};

enum class TextureTransformComponent {
    offset,
    scale,
    rotation,
};

struct MaterialTrack {
    std::size_t clip = 0;
    std::size_t material = 0;
    MaterialTrackKind kind = MaterialTrackKind::base_color_factor;
    TextureTransformSlot slot = TextureTransformSlot::base_color;
    TextureTransformComponent component =
        TextureTransformComponent::rotation;
    std::vector<float> times;
    std::vector<Vec4> values;
};

// The texture slots a KHR_texture_transform pointer may name. The core four
// mirror the pin's TX_SLOT map, in which metallicRoughnessTexture is
// deliberately absent: Babylon.js omits the extension path segment when it
// registers that pointer, so the interpolation never attaches and the MR
// transform stays at its load-time value. The pin matches that for parity, and
// so does this. The extension slots mirror resolveExtTexture, and occlusion
// resolves onto the ORM slot exactly as TX_SLOT does.
bool material_transform_slot(
    const std::string& path,
    TextureTransformSlot& slot) {
    if (path == "/pbrMetallicRoughness/baseColorTexture") {
        slot = TextureTransformSlot::base_color;
    } else if (path == "/emissiveTexture") {
        slot = TextureTransformSlot::emissive;
    } else if (path == "/normalTexture") {
        slot = TextureTransformSlot::normal;
    } else if (path == "/occlusionTexture") {
        slot = TextureTransformSlot::orm;
    } else if (
        path ==
        "/extensions/KHR_materials_clearcoat/clearcoatTexture") {
        slot = TextureTransformSlot::clearcoat;
    } else if (
        path ==
        "/extensions/KHR_materials_clearcoat/clearcoatRoughnessTexture") {
        slot = TextureTransformSlot::clearcoat_roughness;
    } else if (
        path ==
        "/extensions/KHR_materials_clearcoat/clearcoatNormalTexture") {
        slot = TextureTransformSlot::clearcoat_normal;
    } else if (
        path == "/extensions/KHR_materials_sheen/sheenColorTexture") {
        slot = TextureTransformSlot::sheen;
    } else if (
        path ==
        "/extensions/KHR_materials_sheen/sheenRoughnessTexture") {
        slot = TextureTransformSlot::sheen_roughness;
    } else if (
        path ==
        "/extensions/KHR_materials_iridescence/iridescenceTexture") {
        slot = TextureTransformSlot::iridescence;
    } else if (
        path ==
        "/extensions/KHR_materials_iridescence/iridescenceThicknessTexture") {
        slot = TextureTransformSlot::iridescence_thickness;
    } else if (
        path ==
        "/extensions/KHR_materials_transmission/transmissionTexture") {
        slot = TextureTransformSlot::transmission;
    } else if (
        path == "/extensions/KHR_materials_volume/thicknessTexture") {
        slot = TextureTransformSlot::thickness;
    } else {
        return false;
    }
    return true;
}

TextureTransform& material_transform(
    MaterialRecord& material,
    TextureTransformSlot slot) {
    switch (slot) {
        case TextureTransformSlot::base_color:
            return material.base_color_transform;
        case TextureTransformSlot::orm:
            return material.orm_transform;
        case TextureTransformSlot::normal:
            return material.normal_transform;
        case TextureTransformSlot::emissive:
            return material.emissive_transform;
        case TextureTransformSlot::clearcoat:
            return material.clearcoat_transform;
        case TextureTransformSlot::clearcoat_roughness:
            return material.clearcoat_roughness_transform;
        case TextureTransformSlot::clearcoat_normal:
            return material.clearcoat_normal_transform;
        case TextureTransformSlot::sheen:
            return material.sheen_transform;
        case TextureTransformSlot::sheen_roughness:
            return material.sheen_roughness_transform;
        case TextureTransformSlot::iridescence:
            return material.iridescence_transform;
        case TextureTransformSlot::iridescence_thickness:
            return material.iridescence_thickness_transform;
        case TextureTransformSlot::transmission:
            return material.transmission_transform;
        case TextureTransformSlot::thickness:
            break;
    }
    return material.thickness_transform;
}` : ""}

struct AnimatedNode {
    Vec3 translation{};
    Vec4 rotation{0.0f, 0.0f, 0.0f, 1.0f};
    Vec3 scale{1.0f, 1.0f, 1.0f};
    // A node authored with a matrix keeps it verbatim: the pinned loader builds
    // such a node with createSceneNodeFromMatrix, which stores the raw matrix as
    // _localMatrix, and the local matrix reads _localMatrix in preference to the
    // composed translation/rotation/scale. Upstream never decomposes it.
    bool has_matrix = false;
    Matrix matrix{};
    int parent = -1;
    Matrix world{};
    bool computed = false;
    bool computing = false;
    std::vector<float> weights;
};

struct SkinRuntime {
    std::vector<std::size_t> joints;
    std::vector<Matrix> inverse_bind_matrices;
};

struct AnimatedMeshBinding {
    std::uint32_t mesh = 0;
    std::uint32_t geometry = 0;
    std::size_t node = 0;
    std::size_t skin = std::numeric_limits<std::size_t>::max();
};

// One glTF animation, the shape src/animation/animation-group.ts builds per
// clip: its own name, duration, frame rate and play state. Upstream starts
// only the first clip (isPlaying: clipIndex === 0) and loops each one over
// its own duration, so the clips advance independently.
struct AnimationClip {
    std::string name;
    float time = 0.0f;
    float duration = 0.0f;
    bool playing = false;
    bool stopped = true;
};

struct AnimationRuntime {
    float time = 0.0f;
    bool paused = false;
    std::vector<AnimationClip> clips;
    std::vector<RotationTrack> rotation_tracks;
    std::vector<TranslationTrack> translation_tracks;
    std::vector<TranslationTrack> scale_tracks;
    std::vector<WeightTrack> weight_tracks;${animationPointer ? `
    std::vector<VisibilityTrack> visibility_tracks;
    std::vector<LightTrack> light_tracks;
    std::vector<AnimatedLightBinding> light_nodes;` : ""}${animationPointerMaterials ? `
    std::vector<MaterialTrack> material_tracks;` : ""}
    std::vector<std::vector<std::uint32_t>> node_meshes;
    std::vector<AnimatedNode> nodes;
    std::vector<SkinRuntime> skins;
    std::vector<AnimatedMeshBinding> meshes;
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
    const std::size_t component_bytes =
        component_size(accessor.component_type);
    const std::size_t components =
        component_count(accessor.type);
    if (element >= accessor.count || component >= components) {
        throw std::runtime_error(
            "glTF accessor element or component is out of range.");
    }
    const std::size_t packed_stride =
        component_bytes * components;
    const std::size_t stride = view.stride != 0 ? view.stride : packed_stride;
    if (stride < packed_stride) {
        throw std::runtime_error(
            "glTF accessor stride is smaller than its element size.");
    }
    if (accessor.offset > view.length) {
        throw std::runtime_error(
            "glTF accessor offset exceeds its bufferView.");
    }
    const std::size_t available =
        view.length - accessor.offset;
    if (
        element >
        std::numeric_limits<std::size_t>::max() / stride) {
        throw std::runtime_error("glTF accessor offset overflows.");
    }
    const std::size_t element_offset = element * stride;
    const std::size_t component_offset =
        component * component_bytes;
    if (
        element_offset > available ||
        component_offset > available - element_offset ||
        component_bytes >
            available - element_offset - component_offset) {
        throw std::runtime_error(
            "glTF accessor exceeds its bufferView.");
    }
    const std::size_t offset =
        container.bin_offset +
        view.offset +
        accessor.offset +
        element_offset +
        component_offset;
    const std::uint8_t* data = buffer.data() + offset;
    switch (accessor.component_type) {
${lowered.accessorNormalization}
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

${lowered.animationInterpolation}

Matrix identity_matrix() {
    Matrix result{};
    result[0] = result[5] = result[10] = result[15] = 1.0f;
    return result;
}

${lowered.matrixMultiply}

${lowered.matrixLocal}

${lowered.matrixCompose}

${lowered.matrixNative}

Vec3 transform_point_raw(const Matrix& matrix, Vec3 value) {
    return Vec3{
        matrix[0] * value.x + matrix[4] * value.y + matrix[8] * value.z + matrix[12],
        matrix[1] * value.x + matrix[5] * value.y + matrix[9] * value.z + matrix[13],
        matrix[2] * value.x + matrix[6] * value.y + matrix[10] * value.z + matrix[14],
    };
}

Vec3 transform_direction_raw(const Matrix& matrix, Vec3 value) {
    return Vec3{
        matrix[0] * value.x + matrix[4] * value.y + matrix[8] * value.z,
        matrix[1] * value.x + matrix[5] * value.y + matrix[9] * value.z,
        matrix[2] * value.x + matrix[6] * value.y + matrix[10] * value.z,
    };
}

Vec3 transform_point(const Matrix& matrix, Vec3 value) {
    const Vec3 transformed = transform_point_raw(matrix, value);
    return Vec3{-transformed.x, transformed.y, transformed.z};
}

// Babylon Lite normalizes the object-space direction and interpolates
// the transformed vector unnormalized; only the fragment renormalizes.
Vec3 transform_direction(const Matrix& matrix, Vec3 value) {
    const Vec3 transformed =
        transform_direction_raw(matrix, normalize(value));
    return Vec3{-transformed.x, transformed.y, transformed.z};
}

float linear_determinant(const Matrix& matrix) {
    return
        matrix[0] * (matrix[5] * matrix[10] - matrix[9] * matrix[6]) -
        matrix[4] * (matrix[1] * matrix[10] - matrix[9] * matrix[2]) +
        matrix[8] * (matrix[1] * matrix[6] - matrix[5] * matrix[2]);
}

// getTextureImageIndex: an alternate-source extension supplies the image index
// in place of the core field. The pin keeps this on its core path rather than
// behind a feature import, because the decode needs no extra module there —
// createImageBitmap reads WebP natively.
std::size_t texture_image_index(const JsonObject& texture) {
    if (
        const ts::JsonValue* extensions =
            optional(texture, "extensions")) {
        if (
            const ts::JsonValue* webp = optional(
                extensions->as_object(),
                "EXT_texture_webp")) {
            if (
                const ts::JsonValue* source =
                    optional(webp->as_object(), "source")) {
                return unsigned_value(*source);
            }
        }
    }
    return unsigned_value(required(texture, "source"));
}
${materialVariants ? `
// src/loader-gltf/material-variants.ts#selectVariant composed with
// gltf-feature-variants.ts's mapping walk: the selection restores every
// original material and then applies the entries the chosen variant maps, so
// a primitive that variant does not map keeps its own material. The chosen
// name is the scene's; the variant order and the mappings are the
// document's.
std::size_t variant_material_index(
    const JsonObject& document,
    const JsonObject& primitive,
    std::size_t fallback) {
    const std::size_t own = unsigned_or(primitive, "material", fallback);
    const ts::JsonValue* extensions = optional(document, "extensions");
    if (!extensions) return own;
    const ts::JsonValue* declared =
        optional(extensions->as_object(), "KHR_materials_variants");
    if (!declared) return own;
    const JsonArray& variants =
        array_or_empty(declared->as_object(), "variants");
    std::size_t selected = variants.size();
    for (std::size_t index = 0; index < variants.size(); ++index) {
        const ts::JsonValue* name =
            optional(variants[index].as_object(), "name");
        if (name && name->as_string() == ${selectedVariantLiteral}) {
            selected = index;
            break;
        }
    }
    if (selected == variants.size()) return own;
    const ts::JsonValue* extended = optional(primitive, "extensions");
    if (!extended) return own;
    const ts::JsonValue* mappings_ext =
        optional(extended->as_object(), "KHR_materials_variants");
    if (!mappings_ext) return own;
    // selectVariant assigns every entry the variant maps, in order, so the
    // last mapping naming it is the one that survives.
    std::size_t mapped = own;
    for (
        const ts::JsonValue& mapping :
        array_or_empty(mappings_ext->as_object(), "mappings")) {
        for (
            const ts::JsonValue& variant :
            array_or_empty(mapping.as_object(), "variants")) {
            if (unsigned_value(variant) == selected) {
                mapped =
                    unsigned_or(mapping.as_object(), "material", mapped);
                break;
            }
        }
    }
    return mapped;
}
` : ""}
TextureData image_data(
    const ts::ArrayBuffer& buffer,
    const upstream::ParsedGlbContainer& container,
    const std::vector<BufferViewInfo>& views,
    const JsonArray& images,
    std::size_t image_index) {
    TextureData result;
    const JsonObject& image =
        images.at(image_index).as_object();
    const BufferViewInfo& view = views.at(
        unsigned_value(required(image, "bufferView")));
    const std::size_t start =
        container.bin_offset + view.offset;
    const std::size_t end = start + view.length;
    if (end > buffer.byte_length()) {
        throw std::runtime_error(
            "glTF image exceeds BIN chunk.");
    }
    const std::string mime_type =
        string_or(image, "mimeType");
    // The codec set the build links is decided by scanning these same
    // materialized assets, so a media type listed here is always one the
    // executable can decode: an asset carrying WebP is what put the WebP
    // codec in BBLITE_IMAGE_CODECS in the first place.
    if (
        mime_type != "image/png" &&
        mime_type != "image/jpeg" &&
        mime_type != "image/webp") {
        throw std::runtime_error(
            "Only embedded PNG, JPEG and WebP glTF images are supported: " +
            mime_type + ".");
    }
    result.bytes.assign(
        buffer.bytes().begin() + start,
        buffer.bytes().begin() + end);
    return result;
}

float color_channel(
    const Color3& color,
    int channel) {
    return channel == 0
        ? color.r
        : channel == 1
            ? color.g
            : color.b;
}

void set_color_channel(
    Color3& color,
    int channel,
    float value) {
    if (channel == 0) color.r = value;
    else if (channel == 1) color.g = value;
    else color.b = value;
}

${lowered.shPrescale}

bool load_image_based_environment(
    EnvironmentState& environment,
    const JsonObject& document,
    const ts::ArrayBuffer& buffer,
    const upstream::ParsedGlbContainer& container,
    const std::vector<BufferViewInfo>& views,
    const JsonArray& images) {
    const ts::JsonValue* extensions_value =
        optional(document, "extensions");
    const JsonArray& scenes =
        array_or_empty(document, "scenes");
    if (!extensions_value || scenes.empty()) {
        return false;
    }
    const JsonObject& extensions =
        extensions_value->as_object();
    const ts::JsonValue* ibl_value =
        optional(extensions, "EXT_lights_image_based");
    if (!ibl_value) return false;
    const JsonArray& lights = array_or_empty(
        ibl_value->as_object(),
        "lights");
    const std::size_t scene_index =
        unsigned_or(document, "scene", 0);
    if (scene_index >= scenes.size()) return false;
    const JsonObject& scene =
        scenes[scene_index].as_object();
    const ts::JsonValue* scene_extensions_value =
        optional(scene, "extensions");
    if (!scene_extensions_value) return false;
    const ts::JsonValue* scene_ibl_value =
        optional(
            scene_extensions_value->as_object(),
            "EXT_lights_image_based");
    if (!scene_ibl_value) return false;
    const std::size_t light_index = unsigned_value(
        required(
            scene_ibl_value->as_object(),
            "light"));
    if (light_index >= lights.size()) return false;
    const JsonObject& light =
        lights[light_index].as_object();
    const JsonArray& coefficients =
        array_or_empty(
            light,
            "irradianceCoefficients");
    const JsonArray& specular_images =
        array_or_empty(light, "specularImages");
    if (
        coefficients.size() != 9 ||
        specular_images.empty()) {
        return false;
    }
${lowered.iblPolynomial}
    environment.has_irradiance = true;
    environment.spherical_harmonics =
        pre_scale_harmonics(polynomial);
    environment.specular_width =
        static_cast<std::uint32_t>(
            unsigned_value(
                required(
                    light,
                    "specularImageSize")));
    environment.specular_mip_count =
        static_cast<std::uint32_t>(
            specular_images.size());
    environment.specular_faces.clear();
    environment.specular_faces.reserve(
        specular_images.size() * 6);
    for (const ts::JsonValue& mip_value :
         specular_images) {
        const JsonArray& faces =
            mip_value.as_array();
        if (faces.size() != 6) {
            throw std::runtime_error(
                "Image-based light mip must contain six faces.");
        }
        for (const ts::JsonValue& face : faces) {
            environment.specular_faces.push_back(
                image_data(
                    buffer,
                    container,
                    views,
                    images,
                    unsigned_value(face)));
        }
    }
${lowered.iblEnvironmentScalars}
${lowered.imageProcessingDefaults}
    return true;
}

TextureData texture_data(
    const ts::ArrayBuffer& buffer,
    const upstream::ParsedGlbContainer& container,
    const std::vector<BufferViewInfo>& views,
    const JsonArray& images,
    const JsonArray& textures,
    const JsonArray& samplers,
    const ts::JsonValue* texture_info) {
    TextureData result;
    if (!texture_info) return result;
    const JsonObject& info = texture_info->as_object();
    const std::size_t texture_index = unsigned_value(required(info, "index"));
    const JsonObject& texture = textures.at(texture_index).as_object();
    const JsonObject* sampler = nullptr;
    if (const ts::JsonValue* sampler_value = optional(texture, "sampler")) {
        sampler = &samplers.at(unsigned_value(*sampler_value)).as_object();
    }
${lowered.samplerMapping}
    const std::size_t image_index = texture_image_index(texture);
    result.bytes = image_data(
        buffer,
        container,
        views,
        images,
        image_index).bytes;
    return result;
}

const ts::JsonValue* texture_transform_value(
    const ts::JsonValue* texture_info) {
    if (!texture_info) return nullptr;
    const ts::JsonValue* extensions_value =
        optional(
            texture_info->as_object(),
            "extensions");
    if (!extensions_value) return nullptr;
    return optional(
        extensions_value->as_object(),
        "KHR_texture_transform");
}

// Read one textureInfo's KHR_texture_transform into that slot's own transform.
// The pinned wrapTexture patches only the fields the extension declares and
// leaves the rest at their defaults, so an absent scale/offset/rotation keeps
// the identity values this record is constructed with.
void apply_texture_transform(
    TextureTransform& slot,
    const ts::JsonValue* texture_info) {
    if (!texture_info) return;
    const ts::JsonValue* extensions_value =
        optional(
            texture_info->as_object(),
            "extensions");
    if (!extensions_value) return;
    const ts::JsonValue* transform_value =
        optional(
            extensions_value->as_object(),
            "KHR_texture_transform");
    if (!transform_value) return;
    const JsonObject& transform =
        transform_value->as_object();
    const std::vector<float> scale =
        float_array(optional(transform, "${materialDefaults.textureTransform.scaleKey}"));
    const std::vector<float> offset =
        float_array(optional(transform, "${materialDefaults.textureTransform.offsetKey}"));
    if (scale.size() == 2) {
        slot.u_scale = scale[0];
        slot.v_scale = scale[1];
    }
    if (offset.size() == 2) {
        slot.u_offset = offset[0];
        slot.v_offset = offset[1];
    }
    slot.rotation = float_or(transform, "${materialDefaults.textureTransform.rotation.key}", ${materialDefaults.textureTransform.rotation.literal});
}

${factorBake.helpers}

// animation-pointer-basecolor.ts#collectBaseColorDefs: which materials have
// their base colour factor driven by a KHR_animation_pointer channel. It is a
// pre-pass upstream for the same reason it is one here — materials are built
// before animations are read, and the answer changes how a material is built.
std::vector<bool> collect_animated_base_color(
    const JsonObject& document,
    std::size_t material_count) {
    std::vector<bool> animated(material_count, false);
    for (const ts::JsonValue& animation : array_or_empty(document, "animations")) {
        for (const ts::JsonValue& channel :
             array_or_empty(animation.as_object(), "channels")) {
            const ts::JsonValue* target =
                optional(channel.as_object(), "target");
            if (target == nullptr) continue;
            const ts::JsonValue* extensions =
                optional(target->as_object(), "extensions");
            if (extensions == nullptr) continue;
            const ts::JsonValue* pointer_extension = optional(
                extensions->as_object(), "KHR_animation_pointer");
            if (pointer_extension == nullptr) continue;
            const ts::JsonValue* pointer =
                optional(pointer_extension->as_object(), "pointer");
            if (pointer == nullptr) continue;
            const std::string path = pointer->as_string();
            const std::string prefix = "/materials/";
            const std::string suffix =
                "/pbrMetallicRoughness/baseColorFactor";
            if (path.size() <= prefix.size() + suffix.size()) continue;
            if (path.compare(0, prefix.size(), prefix) != 0) continue;
            if (path.compare(
                    path.size() - suffix.size(),
                    suffix.size(),
                    suffix) != 0) {
                continue;
            }
            const std::string digits = path.substr(
                prefix.size(),
                path.size() - prefix.size() - suffix.size());
            if (digits.empty() ||
                digits.find_first_not_of("0123456789") != std::string::npos) {
                continue;
            }
            const std::size_t index =
                static_cast<std::size_t>(std::stoull(digits));
            if (index < animated.size()) animated[index] = true;
        }
    }
    return animated;
}

MaterialHandle load_material(
    Engine& engine,
    const JsonObject& material_json,
    const ts::ArrayBuffer& buffer,
    const upstream::ParsedGlbContainer& container,
    const std::vector<BufferViewInfo>& views,
    const JsonArray& images,
    const JsonArray& textures,
    const JsonArray& samplers,
    bool animated_base_color) {
    MaterialRecord material;
    material.emissive_factor = ${materialDefaults.emissiveFactor.identity};
    material.specular_aa = true;
    if (const ts::JsonValue* pbr_value = optional(material_json, "pbrMetallicRoughness")) {
        const JsonObject& pbr = pbr_value->as_object();
        const std::vector<float> base = float_array(optional(pbr, "${materialDefaults.baseColorFactorKey}"));
        if (base.size() == 4) material.base_color_factor = Color4{base[0], base[1], base[2], base[3]};
        material.metallic_factor = float_or(pbr, "${materialDefaults.metallicFactor.key}", ${materialDefaults.metallicFactor.literal});
        material.roughness_factor = float_or(pbr, "${materialDefaults.roughnessFactor.key}", ${materialDefaults.roughnessFactor.literal});
        const ts::JsonValue* base_color_texture =
            optional(pbr, "baseColorTexture");
        material.base_color_texture = texture_data(
            buffer, container, views, images, textures, samplers, base_color_texture);
        apply_texture_transform(
            material.base_color_transform,
            base_color_texture);
        const ts::JsonValue*
            metallic_roughness_texture =
                optional(
                    pbr,
                    "metallicRoughnessTexture");
        material.metallic_roughness_texture = texture_data(
            buffer, container, views, images, textures, samplers, metallic_roughness_texture);
        apply_texture_transform(
            material.orm_transform,
            metallic_roughness_texture);
        if (material.metallic_roughness_texture.bytes.empty()) {
            // uploadOrmFactorTexture: the factors bake into the texel and the
            // uniforms revert to one. The product is what it always was, but
            // the split matters the moment a KHR_animation_pointer channel
            // writes a factor — the pointer drives the UNIFORM, which the
            // shader multiplies by this texel, so a material authored at
            // roughness zero stays a mirror however its factor animates. Ours
            // kept the factor in the uniform against a white texel, which let
            // an animated factor resurrect a value the pin holds at zero.
            material.orm_fallback = {
                ${factorBake.opaqueByte},
                unorm_byte(material.roughness_factor),
                unorm_byte(material.metallic_factor),
                ${factorBake.opaqueByte},
            };
            material.metallic_factor = 1.0f;
            material.roughness_factor = 1.0f;
        }
        if (material.base_color_texture.bytes.empty()) {
            if (animated_base_color) {
                // animation-pointer-basecolor.ts#whiteFallback: a base
                // colour factor that is animated, on a material with no
                // base colour image, bakes a fully WHITE texel and keeps
                // the real factor — alpha included — in the uniform for
                // the pointer writer to overwrite. Baking the factor here
                // as well multiplies it in twice: Scene 253's Transparency
                // sphere carried 0.502 in the texel and 0.648 in the
                // uniform against the browser's 0.648 alone.
                material.base_color_fallback = {255, 255, 255, 255};
                material.animated_base_color = true;
            } else {
                // Pinned uploadBaseColorFactorTexture: the factor bakes
                // into the sRGB fallback texel (alpha as a linear byte)
                // and the shader uniform reverts to white; the raw alpha
                // stays on the record for the pinned blend semantics.
                material.base_color_fallback = {
                    linear_to_srgb_byte(material.base_color_factor.r),
                    linear_to_srgb_byte(material.base_color_factor.g),
                    linear_to_srgb_byte(material.base_color_factor.b),
                    static_cast<std::uint8_t>(
                        std::round(
                            std::clamp(
                                material.base_color_factor.a,
                                ${factorBake.unormClampLo},
                                ${factorBake.unormClampHi}) *
                            ${factorBake.unormScale})),
                };
                material.base_color_factor.r = 1.0f;
                material.base_color_factor.g = 1.0f;
                material.base_color_factor.b = 1.0f;
            }
        }
    }
    const ts::JsonValue* normal_texture =
        optional(material_json, "normalTexture");
    material.normal_texture = texture_data(
        buffer, container, views, images, textures, samplers, normal_texture);
    apply_texture_transform(
        material.normal_transform,
        normal_texture);
    if (normal_texture) {
        material.normal_texture_scale =
            float_or(normal_texture->as_object(), "${materialDefaults.normalScale.key}", ${materialDefaults.normalScale.literal});
    }
    const ts::JsonValue* occlusion_texture_info =
        optional(material_json, "occlusionTexture");
    material.has_occlusion_texture = occlusion_texture_info != nullptr;
    // assemblePbrPropsExt seeds occlusionStrength as image presence -- the
    // glTF strength is not what the field carries -- and the animation
    // pointer overwrites the live value from there. A no-image material
    // carries 0 so the fragment's occlusion mix stays at the composed 1.0
    // instead of sampling the metallic-roughness red channel.
    material.occlusion_strength =
        occlusion_texture_info ? 1.0f : 0.0f;
    if (occlusion_texture_info) {
        // Babylon Lite's buildDefaultPbrTexturesExt: an occlusion
        // texture on TEXCOORD_1 without a metallic-roughness image
        // keeps the factor-driven ORM slot and binds the occlusion
        // image through the dedicated uv2 pair; on TEXCOORD_0 the
        // occlusion image itself becomes the ORM texture while
        // assemblePbrPropsExt drops the glTF metallic and roughness
        // factors (the engine defaults of 1.0 apply). Distinct
        // metallic-roughness and occlusion images composite upstream
        // and stay unreached natively.
        const ts::JsonValue* metallic_roughness_info = nullptr;
        if (const ts::JsonValue* pbr_value =
                optional(material_json, "pbrMetallicRoughness")) {
            metallic_roughness_info = optional(
                pbr_value->as_object(),
                "metallicRoughnessTexture");
        }
        const auto texture_image =
            [&](const ts::JsonValue* info) -> std::size_t {
                const std::size_t texture_index = unsigned_value(
                    required(info->as_object(), "index"));
                return texture_image_index(
                    textures.at(texture_index).as_object());
            };
        const std::size_t occlusion_uv = unsigned_or(
            occlusion_texture_info->as_object(),
            "${materialDefaults.occlusionTexCoord.key}",
            ${materialDefaults.occlusionTexCoord.literal});
        if (occlusion_uv == 1) {
            if (metallic_roughness_info) {
                throw std::runtime_error(
                    "Reached glTF occlusion texture on TEXCOORD_1 "
                    "alongside a metallic-roughness texture is not "
                    "lowered.");
            }
            material.occlusion_texture = texture_data(
                buffer,
                container,
                views,
                images,
                textures,
                samplers,
                occlusion_texture_info);
            material.occlusion_texture_uv2 = true;
        } else if (occlusion_uv == 0) {
            if (!metallic_roughness_info) {
                material.metallic_roughness_texture = texture_data(
                    buffer,
                    container,
                    views,
                    images,
                    textures,
                    samplers,
                    occlusion_texture_info);
                material.metallic_factor = 1.0f;
                material.roughness_factor = 1.0f;
            } else if (
                texture_image(metallic_roughness_info) !=
                texture_image(occlusion_texture_info)) {
                throw std::runtime_error(
                    "Reached glTF material uses distinct occlusion "
                    "and metallic-roughness images.");
            }
        } else {
            throw std::runtime_error(
                "Reached glTF occlusion texture uses an unsupported "
                "texture-coordinate set.");
        }
    }
    if (const ts::JsonValue* extensions_value = optional(material_json, "extensions")) {
        const JsonObject& extensions = extensions_value->as_object();
        material.unlit = optional(extensions, "KHR_materials_unlit") != nullptr;
        if (const ts::JsonValue* ior_value =
                optional(extensions, "KHR_materials_ior")) {
            material.has_ior = true;
            material.index_of_refraction =
                float_or(ior_value->as_object(), "${defaults.ior.key}", ${defaults.ior.literal});
            const float ratio =
                (material.index_of_refraction - ${materialDefaults.iorToF0.one}) /
                (material.index_of_refraction + ${materialDefaults.iorToF0.one});
            material.reflectance = ratio * ratio;
        }
${materialSpecular ? `        if (const ts::JsonValue* specular_value =
                optional(
                    extensions,
                    "KHR_materials_specular")) {
            const JsonObject& specular =
                specular_value->as_object();
            if (
                optional(specular, "specularTexture") ||
                optional(specular, "specularColorTexture")) {
                throw std::runtime_error(
                    "Reached KHR_materials_specular supports the specular and specular color factors only.");
            }
            material.has_metallic_reflectance = true;
            // The pin keeps the material's own reflectance at its default and
            // scales it with metallicF0Factor, so the IOR fold this loader
            // applies above — exact while nothing else scales F0 — has to be
            // undone the moment a second scale exists. IOR seeds the factor and
            // the specular factor then replaces it, which is the spec's
            // "specular wins" rule and what the pinned loader does by
            // overwriting the same option.
            const float base_reflectance = ${materialDefaults.iorToF0.baseReflectance};
            material.metallic_f0_factor =
                material.has_ior
                    ? material.reflectance / base_reflectance
                    : 1.0f;
            material.reflectance = base_reflectance;
            if (optional(specular, "${materialDefaults.specularFactor.key}")) {
                const float factor =
                    float_or(specular, "${materialDefaults.specularFactor.key}", ${materialDefaults.specularFactor.clear});
                // A specular factor of one is the default: the pin drops both
                // options rather than writing them, so an IOR-seeded factor
                // does not survive it either.
                material.metallic_f0_factor =
                    std::abs(factor - ${materialDefaults.specularFactor.clear}) > ${materialDefaults.specularFactor.epsilon} ? factor : ${materialDefaults.specularFactor.clear};
                material.specular_weight =
                    material.metallic_f0_factor;
            }
            const std::vector<float> specular_color =
                float_array(
                    optional(specular, "${materialDefaults.specularColor.key}"));
            if (
                specular_color.size() == ${materialDefaults.specularColor.length} &&
                (specular_color[0] != ${materialDefaults.specularColor.unit} ||
                 specular_color[1] != ${materialDefaults.specularColor.unit} ||
                 specular_color[2] != ${materialDefaults.specularColor.unit})) {
                material.metallic_reflectance_color = Color3{
                    specular_color[0],
                    specular_color[1],
                    specular_color[2],
                };
            }
        }
` : ""}        if (const ts::JsonValue* volume_value =
                optional(extensions, "KHR_materials_volume")) {
            const JsonObject& volume = volume_value->as_object();
            material.has_volume = true;
            material.use_thickness_as_depth = true;
            material.thickness =
                float_or(volume, "${defaults.thicknessFactor.key}", ${defaults.thicknessFactor.literal});
            const std::vector<float> attenuation =
                float_array(optional(volume, "attenuationColor"));
            if (attenuation.size() == 3) {
                material.attenuation_color = Color3{
                    attenuation[0],
                    attenuation[1],
                    attenuation[2],
                };
            }
            material.attenuation_distance =
                float_or(volume, "${defaults.attenuationDistance.key}", ${defaults.attenuationDistance.literal});
            material.thickness_texture = texture_data(
                buffer,
                container,
                views,
                images,
                textures,
                samplers,
                optional(volume, "thicknessTexture"));
            apply_texture_transform(
                material.thickness_transform,
                optional(volume, "thicknessTexture"));
        }
        if (const ts::JsonValue* transmission_value =
                optional(extensions, "KHR_materials_transmission")) {
            const JsonObject& transmission =
                transmission_value->as_object();
            material.transmission_factor =
                float_or(transmission, "${defaults.transmissionFactor.key}", ${defaults.transmissionFactor.literal});
            material.transmission_texture = texture_data(
                buffer,
                container,
                views,
                images,
                textures,
                samplers,
                optional(transmission, "transmissionTexture"));
            apply_texture_transform(
                material.transmission_transform,
                optional(transmission, "transmissionTexture"));
        }
        if (const ts::JsonValue* dispersion_value =
                optional(
                    extensions,
                    "KHR_materials_dispersion")) {
            const float dispersion = float_or(
                dispersion_value->as_object(),
                "${defaults.dispersion.key}",
                ${defaults.dispersion.literal});
            const bool has_refraction =
                material.has_ior ||
                material.transmission_factor > 0.0f ||
                !material.transmission_texture.bytes.empty();
            const bool has_thickness =
                material.thickness > 0.0f ||
                !material.thickness_texture.bytes.empty();
            if (
                dispersion > 0.0f &&
                has_refraction &&
                has_thickness) {
                material.dispersion = ${defaults.dispersionScale} / dispersion;
            }
        }
        if (const ts::JsonValue* clearcoat_value =
                optional(
                    extensions,
                    "KHR_materials_clearcoat")) {
            const JsonObject& clearcoat =
                clearcoat_value->as_object();
            const ts::JsonValue* clearcoat_texture =
                optional(clearcoat, "clearcoatTexture");
            const ts::JsonValue*
                clearcoat_roughness_texture = optional(
                    clearcoat,
                    "clearcoatRoughnessTexture");
            const ts::JsonValue* clearcoat_normal_texture =
                optional(
                    clearcoat,
                    "clearcoatNormalTexture");
            material.clearcoat_intensity = float_or(
                clearcoat,
                "${materialDefaults.clearcoatIntensity.key}",
                clearcoat_texture ? ${materialDefaults.clearcoatIntensity.present} : ${materialDefaults.clearcoatIntensity.absent});
            material.clearcoat_roughness = float_or(
                clearcoat,
                "${materialDefaults.clearcoatRoughness.key}",
                clearcoat_roughness_texture ? ${materialDefaults.clearcoatRoughness.present} : ${materialDefaults.clearcoatRoughness.absent});
            material.clearcoat_texture = texture_data(
                buffer,
                container,
                views,
                images,
                textures,
                samplers,
                clearcoat_texture);
            material.clearcoat_roughness_texture =
                texture_data(
                    buffer,
                    container,
                    views,
                    images,
                    textures,
                    samplers,
                    clearcoat_roughness_texture);
            material.clearcoat_normal_texture = texture_data(
                buffer,
                container,
                views,
                images,
                textures,
                samplers,
                clearcoat_normal_texture);
            material.clearcoat_normal_scale =
                clearcoat_normal_texture
                    ? float_or(
                          clearcoat_normal_texture
                              ->as_object(),
                          "${materialDefaults.clearcoatNormalScale.key}",
                          ${materialDefaults.clearcoatNormalScale.literal})
                    : ${materialDefaults.clearcoatNormalScale.literal};
            apply_texture_transform(
                material.clearcoat_transform,
                clearcoat_texture);
            apply_texture_transform(
                material.clearcoat_roughness_transform,
                clearcoat_roughness_texture);
            apply_texture_transform(
                material.clearcoat_normal_transform,
                clearcoat_normal_texture);
        }
        if (const ts::JsonValue* sheen_value =
                optional(extensions, "KHR_materials_sheen")) {
            const JsonObject& sheen =
                sheen_value->as_object();
            const ts::JsonValue* sheen_color_texture =
                optional(sheen, "sheenColorTexture");
            const ts::JsonValue* sheen_roughness_texture =
                optional(sheen, "sheenRoughnessTexture");
            const std::vector<float> sheen_color =
                float_array(
                    optional(sheen, "${materialDefaults.sheenColor.key}"));
            material.sheen_color = sheen_color.size() == 3
                ? Color3{
                      sheen_color[0],
                      sheen_color[1],
                      sheen_color[2],
                  }
                : ${materialDefaults.sheenColor.identity};
            material.sheen_roughness = float_or(
                sheen,
                "${materialDefaults.sheenRoughness.key}",
                ${materialDefaults.sheenRoughness.literal});
            material.sheen_intensity = ${materialDefaults.sheenIntensity};
            material.sheen_color_texture = texture_data(
                buffer,
                container,
                views,
                images,
                textures,
                samplers,
                sheen_color_texture);
            const bool same_as_color =
                sheen_roughness_texture &&
                sheen_color_texture &&
                unsigned_value(
                    required(
                        sheen_roughness_texture->as_object(),
                        "index")) ==
                    unsigned_value(
                        required(
                            sheen_color_texture->as_object(),
                            "index")) &&
                texture_transform_value(
                    sheen_roughness_texture) ==
                    texture_transform_value(
                        sheen_color_texture);
            if (sheen_roughness_texture && !same_as_color) {
                material.sheen_roughness_texture =
                    texture_data(
                        buffer,
                        container,
                        views,
                        images,
                        textures,
                        samplers,
                        sheen_roughness_texture);
            } else if (
                !material.sheen_color_texture.bytes.empty()) {
                material.sheen_roughness_texture =
                    material.sheen_color_texture;
            }
            apply_texture_transform(
                material.sheen_transform,
                sheen_color_texture);
            // Roughness shares the colour texture when the asset declares no
            // separate one, so it shares that texture's transform too — the
            // fallback the pinned pointer resolver makes explicit.
            apply_texture_transform(
                material.sheen_roughness_transform,
                sheen_roughness_texture
                    ? sheen_roughness_texture
                    : sheen_color_texture);
        }
        if (const ts::JsonValue* iridescence_value =
                optional(
                    extensions,
                    "KHR_materials_iridescence")) {
            const JsonObject& iridescence =
                iridescence_value->as_object();
            const ts::JsonValue* iridescence_texture =
                optional(
                    iridescence,
                    "iridescenceTexture");
            const ts::JsonValue*
                iridescence_thickness_texture = optional(
                    iridescence,
                    "iridescenceThicknessTexture");
            material.iridescence_intensity = float_or(
                iridescence,
                "${defaults.iridescenceFactor.key}",
                ${defaults.iridescenceFactor.literal});
            material.iridescence_index_of_refraction =
                float_or(iridescence, "${defaults.iridescenceIor.key}", ${defaults.iridescenceIor.literal});
            material.iridescence_minimum_thickness = float_or(
                iridescence,
                "${defaults.iridescenceThicknessMinimum.key}",
                ${defaults.iridescenceThicknessMinimum.literal});
            material.iridescence_maximum_thickness = float_or(
                iridescence,
                "${defaults.iridescenceThicknessMaximum.key}",
                ${defaults.iridescenceThicknessMaximum.literal});
            material.iridescence_texture = texture_data(
                buffer,
                container,
                views,
                images,
                textures,
                samplers,
                iridescence_texture);
            material.iridescence_thickness_texture =
                texture_data(
                    buffer,
                    container,
                    views,
                    images,
                    textures,
                    samplers,
                    iridescence_thickness_texture);
            apply_texture_transform(
                material.iridescence_transform,
                iridescence_texture);
            apply_texture_transform(
                material.iridescence_thickness_transform,
                iridescence_thickness_texture);
        }
    }
    material.emissive_texture = texture_data(
        buffer, container, views, images, textures, samplers, optional(material_json, "emissiveTexture"));
    apply_texture_transform(
        material.emissive_transform,
        optional(material_json, "emissiveTexture"));
    if (material.metallic_roughness_texture.bytes.empty()) {
        // Occlusion is sampled from the ORM texture, so it carries that slot's
        // transform. When the asset declares no metallic-roughness texture the
        // occlusion image IS the ORM texture, so its own transform is the one
        // that slot must use.
        apply_texture_transform(
            material.orm_transform,
            optional(material_json, "occlusionTexture"));
    }
    const std::vector<float> emissive = float_array(optional(material_json, "${materialDefaults.emissiveFactor.key}"));
    if (emissive.size() == 3) material.emissive_factor = Color3{emissive[0], emissive[1], emissive[2]};${animationPointerMaterials ? `
    material.emissive_base_factor = material.emissive_factor;` : ""}
    if (const ts::JsonValue* extensions_value =
            optional(material_json, "extensions")) {
        const JsonObject& extensions =
            extensions_value->as_object();
        if (const ts::JsonValue* strength_value =
                optional(
                    extensions,
                    "KHR_materials_emissive_strength")) {
            const float strength = float_or(
                strength_value->as_object(),
                "${materialDefaults.emissiveStrength.key}",
                ${materialDefaults.emissiveStrength.literal});${animationPointerMaterials ? `
            material.emissive_strength = strength;` : ""}
            material.emissive_factor.r *= strength;
            material.emissive_factor.g *= strength;
            material.emissive_factor.b *= strength;
        }
    }
    material.double_sided = bool_or(material_json, "${materialDefaults.doubleSidedKey}", false);
    const std::string alpha_mode = string_or(material_json, "${materialDefaults.alphaMode.key}", "${materialDefaults.alphaMode.literal}");
    material.alpha_mode =
        alpha_mode == "BLEND"
            ? MaterialAlphaMode::blend
            : alpha_mode == "MASK"
                ? MaterialAlphaMode::mask
                : MaterialAlphaMode::opaque;
    material.alpha_cutoff = float_or(material_json, "${materialDefaults.alphaCutoff.key}", ${materialDefaults.alphaCutoff.literal});
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
    const JsonArray& sampler_json = array_or_empty(document, "samplers");
    const JsonArray& material_json = array_or_empty(document, "materials");
    const JsonArray& mesh_json = array_or_empty(document, "meshes");
    const JsonArray& node_json = array_or_empty(document, "nodes");
    const JsonArray& skin_json = array_or_empty(document, "skins");
    const JsonArray& animation_json =
        array_or_empty(document, "animations");
    const bool animated = !animation_json.empty();

    std::vector<BufferViewInfo> views;
    views.reserve(view_json.size());
    for (const ts::JsonValue& value : view_json) {
        const JsonObject& object = value.as_object();
        const std::size_t offset =
            unsigned_or(object, "byteOffset", 0);
        const std::size_t length =
            unsigned_value(required(object, "byteLength"));
        if (
            offset > container.bin_length ||
            length > container.bin_length - offset) {
            throw std::runtime_error(
                "glTF bufferView exceeds the BIN chunk.");
        }
        views.push_back(BufferViewInfo{
            offset,
            length,
            unsigned_or(object, "byteStride", 0),
        });
    }
    std::vector<AccessorInfo> accessors;
    accessors.reserve(accessor_json.size());
    for (const ts::JsonValue& value : accessor_json) {
        const JsonObject& object = value.as_object();
        if (optional(object, "sparse")) {
            throw std::runtime_error(
                "Sparse glTF accessors are not supported.");
        }
        const std::size_t buffer_view =
            unsigned_value(required(object, "bufferView"));
        if (buffer_view >= views.size()) {
            throw std::runtime_error(
                "glTF accessor references an invalid bufferView.");
        }
        accessors.push_back(AccessorInfo{
            buffer_view,
            unsigned_or(object, "byteOffset", 0),
            unsigned_value(required(object, "count")),
            static_cast<std::uint32_t>(unsigned_value(required(object, "componentType"))),
            required(object, "type").as_string(),
            bool_or(object, "normalized", false),
        });
    }
    std::vector<MaterialHandle> materials;
    materials.reserve(material_json.size());
    const std::vector<bool> animated_base_color =
        collect_animated_base_color(document, material_json.size());
    for (std::size_t index = 0; index < material_json.size(); ++index) {
        materials.push_back(load_material(
            engine, material_json[index].as_object(), buffer, container, views,
            image_json, texture_json, sampler_json,
            animated_base_color[index]));
    }

    std::vector<int> parents(node_json.size(), -1);
    for (std::size_t index = 0; index < node_json.size(); ++index) {
        for (const ts::JsonValue& child : array_or_empty(node_json[index].as_object(), "children")) {
            const std::size_t child_index = unsigned_value(child);
            if (child_index >= parents.size()) {
                throw std::runtime_error(
                    "glTF node references an invalid child.");
            }
            if (parents[child_index] >= 0) {
                throw std::runtime_error(
                    "glTF node has multiple parents.");
            }
            parents[child_index] = static_cast<int>(index);
        }
    }${nodeVisibility ? `
    // KHR_node_visibility. The pinned extension cascades \`visible: false\`
    // through the subtree at load, so a node draws only when it and every
    // ancestor are visible, and the render path tests one boolean.
    std::vector<bool> node_visible(node_json.size(), true);
    for (std::size_t index = 0; index < node_json.size(); ++index) {
        const ts::JsonValue* extensions =
            optional(node_json[index].as_object(), "extensions");
        if (!extensions) continue;
        const ts::JsonValue* visibility =
            optional(extensions->as_object(), "KHR_node_visibility");
        if (
            visibility &&
            !bool_or(visibility->as_object(), "visible", true)) {
            node_visible[index] = false;
        }
    }
    for (std::size_t index = 0; index < node_json.size(); ++index) {
        for (
            int ancestor = parents[index];
            ancestor >= 0;
            ancestor = parents[static_cast<std::size_t>(ancestor)]) {
            if (!node_visible[static_cast<std::size_t>(ancestor)]) {
                node_visible[index] = false;
                break;
            }
        }
    }` : ""}
    std::vector<Matrix> world(node_json.size());
    std::vector<bool> computed(node_json.size(), false);
    std::vector<bool> computing(node_json.size(), false);
    std::function<const Matrix&(std::size_t)> compute_world = [&](std::size_t index) -> const Matrix& {
        if (computed[index]) return world[index];
        if (computing[index]) {
            throw std::runtime_error(
                "glTF node hierarchy contains a cycle.");
        }
        computing[index] = true;
        const Matrix local = local_matrix(node_json[index].as_object());
        world[index] = parents[index] >= 0
            ? multiply_matrix(compute_world(static_cast<std::size_t>(parents[index])), local)
            : local;
        computing[index] = false;
        computed[index] = true;
        return world[index];
    };

    AssetRecord asset;
    EnvironmentState image_based_environment;
    if (load_image_based_environment(
            image_based_environment,
            document,
            buffer,
            container,
            views,
            image_json)) {
        asset.scene_setup =
            [image_based_environment](Scene& scene) {
            scene.environment =
                image_based_environment;
        };
    }${assetTransmission ? `
    // registerPbrTransmission: the pinned transmission setter installs a scene
    // hook that the renderable build drains, and the hook enables scene
    // transmission when any of the meshes it is handed carries a transmissive
    // surface. The predicate is that hook's own — a transmissive material whose
    // refraction intensity is above zero, which the dielectric loader takes from
    // transmissionFactor — so a declared extension at the zero default reaches
    // nothing, exactly as it does upstream. The scene source never names it.
    {
        bool transmissive_surface = false;
        for (const MaterialHandle handle : materials) {
            if (
                handle.value < engine.materials.size() &&
                engine.materials[handle.value].transmission_factor >
                    0.0f) {
                transmissive_surface = true;
                break;
            }
        }
        if (transmissive_surface) {
            std::function<void(Scene&)> previous_setup =
                asset.scene_setup;
            asset.scene_setup =
                [previous_setup](Scene& scene) {
                if (previous_setup) previous_setup(scene);
                enable_scene_transmission(scene);
            };
        }
    }` : ""}
${animationPointer ? `    // Runtime lights indexed by their KHR_lights_punctual definition index,
    // which is the index a light pointer names.
    std::vector<LightHandle> punctual_lights;
    std::vector<AnimatedLightBinding> light_node_bindings;
` : ""}    if (const ts::JsonValue* extensions_value =
            optional(document, "extensions")) {
        const JsonObject& extensions =
            extensions_value->as_object();
        if (const ts::JsonValue* lights_value =
                optional(
                    extensions,
                    "KHR_lights_punctual")) {
            const JsonArray& light_definitions =
                array_or_empty(
                    lights_value->as_object(),
                    "lights");
            for (
                std::size_t node_index = 0;
                node_index < node_json.size();
                ++node_index) {
                const JsonObject& node =
                    node_json[node_index].as_object();
                const ts::JsonValue*
                    node_extensions_value =
                        optional(node, "extensions");
                if (!node_extensions_value) continue;
                const ts::JsonValue* light_value =
                    optional(
                        node_extensions_value
                            ->as_object(),
                        "KHR_lights_punctual");
                if (!light_value) continue;
                const std::size_t light_index =
                    unsigned_value(
                        required(
                            light_value->as_object(),
                            "light"));
                if (
                    light_index >=
                    light_definitions.size()) {
                    continue;
                }
                const JsonObject& definition =
                    light_definitions[light_index]
                        .as_object();
${lowered.punctualLightLoading}
                engine.lights.push_back(light);
                const LightHandle light_handle{
                    static_cast<std::uint32_t>(
                        engine.lights.size() - 1)};
                asset.lights.push_back(light_handle);${animationPointer ? `
                // setGltfPunctualLight: a light pointer names the definition
                // index, not the node, so the runtime light it created has to
                // be reachable by that index.
                if (light_index >= punctual_lights.size()) {
                    punctual_lights.resize(light_index + 1, LightHandle{});
                }
                punctual_lights[light_index] = light_handle;
                light_node_bindings.push_back(
                    AnimatedLightBinding{light_handle, node_index});` : ""}
            }
        }
    }
    const auto animation_runtime =
        std::make_shared<AnimationRuntime>();
${animationPointer ? `    animation_runtime->light_nodes =
        std::move(light_node_bindings);
` : ""}    animation_runtime->node_meshes.resize(node_json.size());
    animation_runtime->nodes.resize(node_json.size());
    for (std::size_t index = 0; index < node_json.size(); ++index) {
        const JsonObject& node = node_json[index].as_object();
        AnimatedNode& animated_node =
            animation_runtime->nodes[index];
        animated_node.parent = parents[index];
        if (optional(node, "matrix")) {
            animated_node.has_matrix = true;
            animated_node.matrix = local_matrix(node);
        }
        const std::vector<float> translation =
            float_array(optional(node, "translation"));
        if (translation.size() == 3) {
            animated_node.translation = Vec3{
                translation[0],
                translation[1],
                translation[2],
            };
        }
        const std::vector<float> rotation =
            float_array(optional(node, "rotation"));
        if (rotation.size() == 4) {
            animated_node.rotation = Vec4{
                rotation[0],
                rotation[1],
                rotation[2],
                rotation[3],
            };
        }
        const std::vector<float> scale =
            float_array(optional(node, "scale"));
        if (scale.size() == 3) {
            animated_node.scale = Vec3{
                scale[0],
                scale[1],
                scale[2],
            };
        }
        animated_node.weights =
            float_array(optional(node, "weights"));
        if (
            animated_node.weights.empty() &&
            optional(node, "mesh")) {
            animated_node.weights = float_array(
                optional(
                    mesh_json.at(
                        unsigned_value(
                            *optional(node, "mesh")))
                        .as_object(),
                    "weights"));
        }
    }
    for (const ts::JsonValue& skin_value : skin_json) {
        const JsonObject& skin = skin_value.as_object();
        SkinRuntime runtime_skin;
        for (const ts::JsonValue& joint :
             array_or_empty(skin, "joints")) {
            runtime_skin.joints.push_back(
                unsigned_value(joint));
        }
        const ts::JsonValue* inverse_bind_value =
            optional(skin, "inverseBindMatrices");
        if (inverse_bind_value) {
            const AccessorInfo& inverse_bind =
                accessors.at(unsigned_value(*inverse_bind_value));
            if (
                inverse_bind.type != "MAT4" ||
                inverse_bind.count !=
                    runtime_skin.joints.size()) {
                throw std::runtime_error(
                    "glTF inverse bind matrix layout is invalid.");
            }
            for (
                std::size_t matrix_index = 0;
                matrix_index < inverse_bind.count;
                ++matrix_index) {
                Matrix matrix{};
                for (std::size_t component = 0; component < 16; ++component) {
                    matrix[component] = read_component(
                        buffer,
                        container,
                        views,
                        inverse_bind,
                        matrix_index,
                        component);
                }
                runtime_skin
                    .inverse_bind_matrices
                    .push_back(matrix);
            }
        } else {
            runtime_skin.inverse_bind_matrices.assign(
                runtime_skin.joints.size(),
                identity_matrix());
        }
        animation_runtime->skins.push_back(
            std::move(runtime_skin));
    }
    for (std::size_t node_index = 0; node_index < node_json.size(); ++node_index) {
        const JsonObject& node = node_json[node_index].as_object();
        const ts::JsonValue* mesh_value = optional(node, "mesh");
        if (!mesh_value) continue;
        const JsonObject& mesh = mesh_json.at(unsigned_value(*mesh_value)).as_object();
        for (const ts::JsonValue& primitive_value : array_or_empty(mesh, "primitives")) {
            const JsonObject& primitive = primitive_value.as_object();
${nonTrianglePrimitives
            ? `            // The pinned loader keeps the authored topology and hands it to
            // WebGPU: load-gltf.ts records a _topology index and
            // gltf-feature-primitive.ts turns it into a GPUPrimitiveState.
            // A triangle strip is the one non-default mode that describes
            // the same triangles a triangle list can, so it is expanded
            // below; point, line, and line-strip topologies rasterize
            // differently and stay unsupported.
            const std::size_t primitive_mode =
                unsigned_or(primitive, "mode", 4);
            if (primitive_mode != 4 && primitive_mode != 5) {
                throw std::runtime_error(
                    "Only triangle-list and triangle-strip glTF primitives "
                    "are supported (mode " +
                    std::to_string(primitive_mode) + ").");
            }`
            : `            if (unsigned_or(primitive, "mode", 4) != 4) {
                throw std::runtime_error("Only triangle-list glTF primitives are supported.");
            }`}
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
            const AccessorInfo* texcoords1 = optional(attributes, "TEXCOORD_1")
                ? &accessors.at(unsigned_value(*optional(attributes, "TEXCOORD_1")))
                : nullptr;
            const AccessorInfo* colors = optional(attributes, "COLOR_0")
                ? &accessors.at(unsigned_value(*optional(attributes, "COLOR_0")))
                : nullptr;
            const AccessorInfo* joints = optional(attributes, "JOINTS_0")
                ? &accessors.at(unsigned_value(*optional(attributes, "JOINTS_0")))
                : nullptr;
            const AccessorInfo* weights = optional(attributes, "WEIGHTS_0")
                ? &accessors.at(unsigned_value(*optional(attributes, "WEIGHTS_0")))
                : nullptr;
            std::vector<const AccessorInfo*> morph_positions;
            std::vector<const AccessorInfo*> morph_normals;
            std::vector<const AccessorInfo*> morph_tangents;
            for (const ts::JsonValue& target_value :
                 array_or_empty(primitive, "targets")) {
                const JsonObject& target =
                    target_value.as_object();
                morph_positions.push_back(
                    optional(target, "POSITION")
                        ? &accessors.at(
                              unsigned_value(
                                  *optional(target, "POSITION")))
                        : nullptr);
                morph_normals.push_back(
                    optional(target, "NORMAL")
                        ? &accessors.at(
                              unsigned_value(
                                  *optional(target, "NORMAL")))
                        : nullptr);
                morph_tangents.push_back(
                    optional(target, "TANGENT")
                        ? &accessors.at(
                              unsigned_value(
                                  *optional(target, "TANGENT")))
                        : nullptr);
            }
            // The node's own world in the native convention, for every mesh:
            // the thin-instance arm composes through it, and a geometry
            // LOCAL_POSITION variant pairs it with the vertex's local lanes.
            Matrix instance_parent_matrix =
                native_matrix(compute_world(node_index));
            std::vector<Matrix> instance_matrices;
            if (const ts::JsonValue* extensions_value =
                    optional(node, "extensions")) {
                const ts::JsonValue* instancing_value =
                    optional(
                        extensions_value->as_object(),
                        "EXT_mesh_gpu_instancing");
                if (instancing_value) {
                    if (animated || !morph_positions.empty()) {
                        throw std::runtime_error(
                            "Animated or morphed GPU instances are not supported.");
                    }
                    const JsonObject& instance_attributes =
                        required(
                            instancing_value->as_object(),
                            "attributes")
                            .as_object();
                    const auto accessor =
                        [&](const char* name)
                        -> const AccessorInfo* {
                        const ts::JsonValue* value =
                            optional(
                                instance_attributes,
                                name);
                        return value
                            ? &accessors.at(
                                  unsigned_value(*value))
                            : nullptr;
                    };
                    const AccessorInfo* translations =
                        accessor("TRANSLATION");
                    const AccessorInfo* rotations =
                        accessor("ROTATION");
                    const AccessorInfo* scales =
                        accessor("SCALE");
                    std::size_t instance_count = 0;
                    for (const AccessorInfo* value :
                         {translations, rotations, scales}) {
                        if (!value) continue;
                        if (
                            instance_count != 0 &&
                            value->count != instance_count) {
                            throw std::runtime_error(
                                "GPU instance accessor counts differ.");
                        }
                        instance_count = value->count;
                    }
                    const Matrix& node_world =
                        compute_world(node_index);
                    instance_parent_matrix =
                        native_matrix(node_world);
                    for (
                        std::size_t instance = 0;
                        instance < instance_count;
                        ++instance) {
                        const Vec3 translation = translations
                            ? Vec3{
                                  read_component(
                                      buffer, container, views,
                                      *translations, instance, 0),
                                  read_component(
                                      buffer, container, views,
                                      *translations, instance, 1),
                                  read_component(
                                      buffer, container, views,
                                      *translations, instance, 2),
                              }
                            : Vec3{};
                        const Vec4 rotation = rotations
                            ? Vec4{
                                  read_component(
                                      buffer, container, views,
                                      *rotations, instance, 0),
                                  read_component(
                                      buffer, container, views,
                                      *rotations, instance, 1),
                                  read_component(
                                      buffer, container, views,
                                      *rotations, instance, 2),
                                  read_component(
                                      buffer, container, views,
                                      *rotations, instance, 3),
                              }
                            : Vec4{0.0f, 0.0f, 0.0f, 1.0f};
                        const Vec3 scale = scales
                            ? Vec3{
                                  read_component(
                                      buffer, container, views,
                                      *scales, instance, 0),
                                  read_component(
                                      buffer, container, views,
                                      *scales, instance, 1),
                                  read_component(
                                      buffer, container, views,
                                      *scales, instance, 2),
                              }
                            : Vec3{1.0f, 1.0f, 1.0f};
                        instance_matrices.push_back(
                            native_matrix(
                                trs_matrix(
                                    translation,
                                    rotation,
                                    scale)));
                    }
                }
            }
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
            const bool instanced =
                !instance_matrices.empty();
            const Matrix matrix = instanced
                ? identity_matrix()
                : compute_world(node_index);
            const float determinant = linear_determinant(matrix);
            const std::size_t material_index =
                ${materialVariants
                    ? `variant_material_index(document, primitive, material_json.size())`
                    : `unsigned_or(primitive, "material", material_json.size())`};
            // A primitive with no material index takes the pin's default
            // material -- getMat(undefined) assembles one from an empty
            // object -- created once and appended after the document's,
            // which is where the composed variant table keys it.
            if (
                material_index == material_json.size() &&
                materials.size() == material_json.size()) {
                materials.push_back(load_material(
                    engine, JsonObject{}, buffer, container, views,
                    image_json, texture_json, sampler_json,
                    false));
            }
            const bool clockwise_front_face =
                determinant < 0.0f &&
                material_index < materials.size() &&
                materials[material_index].value <
                    engine.materials.size() &&
                engine.materials[
                    materials[material_index].value]
                    .double_sided;
            for (std::size_t index = 0; index < positions.count; ++index) {
                ModelVertex vertex;
                const Vec3 local_position{
                    read_component(buffer, container, views, positions, index, 0),
                    read_component(buffer, container, views, positions, index, 1),
                    read_component(buffer, container, views, positions, index, 2),
                };
                vertex.local_position = local_position;
                vertex.position = animated || instanced
                    ? Vec3{
                          -local_position.x,
                          local_position.y,
                          local_position.z,
                      }
                    : transform_point(matrix, local_position);
                if (normals) {
                    const Vec3 local_normal{
                        read_component(buffer, container, views, *normals, index, 0),
                        read_component(buffer, container, views, *normals, index, 1),
                        read_component(buffer, container, views, *normals, index, 2),
                    };
                    vertex.normal = animated || instanced
                        ? normalize(Vec3{
                              -local_normal.x,
                              local_normal.y,
                              local_normal.z,
                          })
                        : transform_direction(matrix, local_normal);
                }
                if (tangents) {
                    const Vec3 local_tangent{
                        read_component(buffer, container, views, *tangents, index, 0),
                        read_component(buffer, container, views, *tangents, index, 1),
                        read_component(buffer, container, views, *tangents, index, 2),
                    };
                    const Vec3 tangent = animated || instanced
                        ? normalize(Vec3{
                              -local_tangent.x,
                              local_tangent.y,
                              local_tangent.z,
                          })
                        : transform_direction(matrix, local_tangent);
                    vertex.tangent = Vec4{
                        tangent.x,
                        tangent.y,
                        tangent.z,
                        (determinant < 0.0f ? 1.0f : -1.0f) *
                            read_component(buffer, container, views, *tangents, index, 3),
                    };
                }
                if (texcoords) {
                    vertex.uv = Vec2{
                        read_component(buffer, container, views, *texcoords, index, 0),
                        read_component(buffer, container, views, *texcoords, index, 1),
                    };
                }
                if (texcoords1) {
                    vertex.uv2 = Vec2{
                        read_component(buffer, container, views, *texcoords1, index, 0),
                        read_component(buffer, container, views, *texcoords1, index, 1),
                    };
                }
${lowered.vertexColor}
                if (joints && weights) {
                    for (std::size_t component = 0; component < 4; ++component) {
                        vertex.joints[component] =
                            static_cast<std::uint16_t>(
                                read_component(
                                    buffer,
                                    container,
                                    views,
                                    *joints,
                                    index,
                                    component));
                    }
                    vertex.weights = Vec4{
                        read_component(buffer, container, views, *weights, index, 0),
                        read_component(buffer, container, views, *weights, index, 1),
                        read_component(buffer, container, views, *weights, index, 2),
                        read_component(buffer, container, views, *weights, index, 3),
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
            for (std::size_t target = 0; target < morph_positions.size(); ++target) {
                std::vector<Vec3> position_deltas(
                    positions.count,
                    Vec3{});
                std::vector<Vec3> normal_deltas(
                    positions.count,
                    Vec3{});
                std::vector<Vec3> tangent_deltas(
                    positions.count,
                    Vec3{});
                for (std::size_t index = 0; index < positions.count; ++index) {
                    if (morph_positions[target]) {
                        position_deltas[index] = Vec3{
                            read_component(
                                buffer,
                                container,
                                views,
                                *morph_positions[target],
                                index,
                                0),
                            read_component(
                                buffer,
                                container,
                                views,
                                *morph_positions[target],
                                index,
                                1),
                            read_component(
                                buffer,
                                container,
                                views,
                                *morph_positions[target],
                                index,
                                2),
                        };
                    }
                    if (morph_normals[target]) {
                        normal_deltas[index] = Vec3{
                            read_component(
                                buffer,
                                container,
                                views,
                                *morph_normals[target],
                                index,
                                0),
                            read_component(
                                buffer,
                                container,
                                views,
                                *morph_normals[target],
                                index,
                                1),
                            read_component(
                                buffer,
                                container,
                                views,
                                *morph_normals[target],
                                index,
                                2),
                        };
                    }
                    if (morph_tangents[target]) {
                        tangent_deltas[index] = Vec3{
                            read_component(
                                buffer,
                                container,
                                views,
                                *morph_tangents[target],
                                index,
                                0),
                            read_component(
                                buffer,
                                container,
                                views,
                                *morph_tangents[target],
                                index,
                                1),
                            read_component(
                                buffer,
                                container,
                                views,
                                *morph_tangents[target],
                                index,
                                2),
                        };
                    }
                }
                geometry.morph_positions.push_back(
                    std::move(position_deltas));
                geometry.morph_normals.push_back(
                    std::move(normal_deltas));
                geometry.morph_tangents.push_back(
                    std::move(tangent_deltas));
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
            }${nonTrianglePrimitives
            ? `
            if (primitive_mode == 5) {
                // Walk the strip into the triangle list it stands for:
                // primitive i is (i, i+1, i+2) with odd i swapped, the
                // expansion every WebGPU/Vulkan/D3D rasterizer performs, so
                // the triangles, their winding, and their order all match
                // what the pinned engine submits as a strip. glTF forbids an
                // index equal to the component type's maximum precisely so
                // clients need not handle primitive restart, which makes the
                // run contiguous. The expansion happens here rather than at
                // the pipeline because the flat-normal path below bakes one
                // normal per face, and a face normal needs each triangle to
                // own its vertices.
                std::vector<std::uint32_t> expanded;
                if (geometry.indices.size() >= 3) {
                    expanded.reserve((geometry.indices.size() - 2) * 3);
                    for (
                        std::size_t index = 0;
                        index + 2 < geometry.indices.size();
                        ++index) {
                        const bool even = index % 2 == 0;
                        expanded.push_back(
                            geometry.indices[even ? index : index + 1]);
                        expanded.push_back(
                            geometry.indices[even ? index + 1 : index]);
                        expanded.push_back(geometry.indices[index + 2]);
                    }
                }
                geometry.indices = std::move(expanded);
            }`
            : ""}
            if (geometry.indices.size() % 3 != 0) {
                throw std::runtime_error("Triangle-list glTF indices must be divisible by three.");
            }
            for (const std::uint32_t index : geometry.indices) {
                if (index >= geometry.vertices.size()) {
                    throw std::runtime_error(
                        "glTF primitive index exceeds its vertex count.");
                }
            }
            if (
                determinant < 0.0f &&
                !clockwise_front_face) {
                for (std::size_t index = 0; index < geometry.indices.size(); index += 3) {
                    std::swap(geometry.indices[index + 1], geometry.indices[index + 2]);
                }
            }
            if (!normals) {
                geometry.flat_normals = true;
                std::vector<ModelVertex> flat_vertices;
                flat_vertices.reserve(geometry.indices.size());
                std::vector<std::vector<Vec3>> flat_morph_positions(
                    geometry.morph_positions.size());
                std::vector<std::vector<Vec3>> flat_morph_normals(
                    geometry.morph_normals.size());
                std::vector<std::vector<Vec3>> flat_morph_tangents(
                    geometry.morph_tangents.size());
                for (const std::uint32_t index : geometry.indices) {
                    flat_vertices.push_back(
                        geometry.vertices.at(index));
                    for (std::size_t target = 0; target < flat_morph_positions.size(); ++target) {
                        flat_morph_positions[target].push_back(
                            geometry.morph_positions[target].at(index));
                        flat_morph_normals[target].push_back(
                            geometry.morph_normals[target].at(index));
                        flat_morph_tangents[target].push_back(
                            geometry.morph_tangents[target].at(index));
                    }
                }
                geometry.vertices = std::move(flat_vertices);
                geometry.morph_positions =
                    std::move(flat_morph_positions);
                geometry.morph_normals =
                    std::move(flat_morph_normals);
                geometry.morph_tangents =
                    std::move(flat_morph_tangents);
                geometry.indices.resize(geometry.vertices.size());
                for (
                    std::size_t index = 0;
                    index < geometry.indices.size();
                    ++index) {
                    geometry.indices[index] =
                        static_cast<std::uint32_t>(index);
                }
                for (
                    std::size_t index = 0;
                    index < geometry.vertices.size();
                    index += 3) {
                    ModelVertex& a = geometry.vertices[index];
                    ModelVertex& b = geometry.vertices[index + 1];
                    ModelVertex& c = geometry.vertices[index + 2];
                    const Vec3 edge1{
                        b.position.x - a.position.x,
                        b.position.y - a.position.y,
                        b.position.z - a.position.z,
                    };
                    const Vec3 edge2{
                        c.position.x - a.position.x,
                        c.position.y - a.position.y,
                        c.position.z - a.position.z,
                    };
                    const Vec3 face{
                        edge2.y * edge1.z - edge2.z * edge1.y,
                        edge2.z * edge1.x - edge2.x * edge1.z,
                        edge2.x * edge1.y - edge2.y * edge1.x,
                    };
                    const Vec3 normal = normalize(face);
                    a.normal = normal;
                    b.normal = normal;
                    c.normal = normal;
                }
            }
            geometry.has_tangents = tangents != nullptr;
            if (animated) {
                geometry.bind_vertices = geometry.vertices;
            }
            if (instanced) {
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
                for (const Matrix& instance :
                     instance_matrices) {
                    const Matrix world_instance =
                        multiply_matrix(
                            instance_parent_matrix,
                            instance);
                    for (const ModelVertex& vertex :
                         geometry.vertices) {
                        const Vec3 position =
                            transform_point_raw(
                                world_instance,
                                vertex.position);
                        geometry.bounds_min.x = std::min(
                            geometry.bounds_min.x,
                            position.x);
                        geometry.bounds_min.y = std::min(
                            geometry.bounds_min.y,
                            position.y);
                        geometry.bounds_min.z = std::min(
                            geometry.bounds_min.z,
                            position.z);
                        geometry.bounds_max.x = std::max(
                            geometry.bounds_max.x,
                            position.x);
                        geometry.bounds_max.y = std::max(
                            geometry.bounds_max.y,
                            position.y);
                        geometry.bounds_max.z = std::max(
                            geometry.bounds_max.z,
                            position.z);
                    }
                }
            }
${animatedWorldBounds ? `            // A static primitive bakes its node matrix into its vertices, so
            // the box just accumulated is already the world one. An animated
            // primitive keeps local vertices and receives that matrix per
            // frame, so its world box is the local box through the node
            // matrix -- the transform the pinned expandWorldAabbForMesh
            // applies while framing the default camera.
            geometry.world_bounds_min = geometry.bounds_min;
            geometry.world_bounds_max = geometry.bounds_max;
            // An instanced primitive already had its box rebuilt from the
            // instance matrices, which carry the node matrix, so applying
            // that matrix again here would double it.
            if (animated && !instanced) {
                const Matrix& node_world = compute_world(node_index);
                bool has_world_bounds = false;
                for (const Vec3& corner : std::array<Vec3, 8>{
                         Vec3{geometry.bounds_min.x, geometry.bounds_min.y, geometry.bounds_min.z},
                         Vec3{geometry.bounds_min.x, geometry.bounds_min.y, geometry.bounds_max.z},
                         Vec3{geometry.bounds_min.x, geometry.bounds_max.y, geometry.bounds_min.z},
                         Vec3{geometry.bounds_min.x, geometry.bounds_max.y, geometry.bounds_max.z},
                         Vec3{geometry.bounds_max.x, geometry.bounds_min.y, geometry.bounds_min.z},
                         Vec3{geometry.bounds_max.x, geometry.bounds_min.y, geometry.bounds_max.z},
                         Vec3{geometry.bounds_max.x, geometry.bounds_max.y, geometry.bounds_min.z},
                         Vec3{geometry.bounds_max.x, geometry.bounds_max.y, geometry.bounds_max.z},
                     }) {
                    // The stored vertices already carry the mirror the
                    // native convention applies, so undo it before the node
                    // matrix and re-apply it after.
                    const Vec3 world = transform_point(
                        node_world,
                        Vec3{-corner.x, corner.y, corner.z});
                    if (!has_world_bounds) {
                        geometry.world_bounds_min = world;
                        geometry.world_bounds_max = world;
                        has_world_bounds = true;
                        continue;
                    }
                    geometry.world_bounds_min.x = std::min(geometry.world_bounds_min.x, world.x);
                    geometry.world_bounds_min.y = std::min(geometry.world_bounds_min.y, world.y);
                    geometry.world_bounds_min.z = std::min(geometry.world_bounds_min.z, world.z);
                    geometry.world_bounds_max.x = std::max(geometry.world_bounds_max.x, world.x);
                    geometry.world_bounds_max.y = std::max(geometry.world_bounds_max.y, world.y);
                    geometry.world_bounds_max.z = std::max(geometry.world_bounds_max.z, world.z);
                }
            }
` : ""}            engine.geometries.push_back(std::move(geometry));
            MeshRecord record;
            record.primitive = PrimitiveKind::gltf;
            record.geometry = static_cast<std::uint32_t>(engine.geometries.size() - 1);
            record.baked_world_scale = std::max({
                std::sqrt(
                    matrix[0] * matrix[0] +
                    matrix[1] * matrix[1] +
                    matrix[2] * matrix[2]),
                std::sqrt(
                    matrix[4] * matrix[4] +
                    matrix[5] * matrix[5] +
                    matrix[6] * matrix[6]),
                std::sqrt(
                    matrix[8] * matrix[8] +
                    matrix[9] * matrix[9] +
                    matrix[10] * matrix[10]),
            });
            if (material_index < materials.size()) record.material = materials[material_index];
            record.clockwise_front_face =
                clockwise_front_face;
            // The node matrix's handedness. Our vertices are stored in the
            // native mirrored convention and the tangent sign is reconciled
            // against it at load, where the pin keeps both unmirrored and puts
            // the mirror in the mesh block's own world matrix. A PAL feeding
            // the pin's composed stages has to undo one to supply the other,
            // and the sign is only known here.
            record.mirrored_x = determinant < 0.0f;${nodeVisibility ? `
            record.visible = node_visible[node_index];` : ""}
            record.instance_parent_matrix =
                instance_parent_matrix;
            record.instance_matrices =
                std::move(instance_matrices);
            // Loader-built pools are static: the thin-instance flag routes
            // the draw through the shared parent-world composition and the
            // record count, while the version/source fields stay unused so
            // the PAL never re-uploads them.
            record.thin_instanced =
                !record.instance_matrices.empty();
            record.instance_count = static_cast<std::uint32_t>(
                record.instance_matrices.size());
            engine.meshes.push_back(std::move(record));
            const std::uint32_t mesh_record_index =
                static_cast<std::uint32_t>(engine.meshes.size() - 1);
            if (animated) {
                const std::size_t skin_index =
                    optional(node, "skin")
                        ? unsigned_value(*optional(node, "skin"))
                        : std::numeric_limits<std::size_t>::max();
                const bool gpu_deformation =
#if BBLITE_GPU_MORPH_STORAGE
                    // Storage-buffer morphing lifts the two-slot
                    // vertex-attribute morph-target cap.
                    (
#else
                    geometry.morph_positions.size() <= 2 &&
                    (
#endif
                        skin_index ==
                            std::numeric_limits<std::size_t>::max() ||
                        animation_runtime
                                ->skins.at(skin_index)
                                .joints.size() <= 64);
                engine.meshes[mesh_record_index]
                    .gpu_deformation = gpu_deformation;
                animation_runtime
                    ->node_meshes[node_index]
                    .push_back(mesh_record_index);
                animation_runtime->meshes.push_back(
                    AnimatedMeshBinding{
                        mesh_record_index,
                        record.geometry,
                        node_index,
                        skin_index,
                    });
            }
            asset.meshes.push_back(MeshHandle{mesh_record_index});
        }
    }
    if (animated) {
        for (const ts::JsonValue& animation_value : animation_json) {
            const JsonObject& animation =
                animation_value.as_object();
            // One clip per glTF animation, named the way
            // createAnimationGroups names it, and started only for the first.
            const std::size_t clip_index =
                animation_runtime->clips.size();
            AnimationClip clip;
            clip.name = string_or(
                animation,
                "name",
                "animation_" + std::to_string(clip_index));
            clip.playing = clip_index == 0;
            clip.stopped = !clip.playing;
            animation_runtime->clips.push_back(std::move(clip));
            // Every channel path notes its key times here, so a clip whose
            // only channels are animation pointers still gets a duration.
            const auto note_clip_time =
                [animation_runtime, clip_index](float time) {
                AnimationClip& owner =
                    animation_runtime->clips[clip_index];
                owner.duration = std::max(owner.duration, time);
            };
            const JsonArray& animation_samplers =
                array_or_empty(animation, "samplers");
            for (const ts::JsonValue& channel_value :
                 array_or_empty(animation, "channels")) {
                const JsonObject& channel =
                    channel_value.as_object();
                const JsonObject& target =
                    required(channel, "target").as_object();
                std::string path_name =
                    required(target, "path").as_string();
                // A node-TRS pointer resolves to the same thing a standard
                // channel does, so it carries a node index the standard path
                // reads in place of the target's own.
                bool pointer_node_override = false;
                std::size_t pointer_node_index = 0;${animationPointer ? `
                if (path_name == "pointer") {
                    // KHR_animation_pointer. The pinned base module resolves
                    // node-visibility and node-TRS pointers itself and pulls
                    // separate modules for material, light and camera
                    // targets; only the visibility pointer is reached.
                    const ts::JsonValue* target_extensions =
                        optional(target, "extensions");
                    const ts::JsonValue* pointer_extension =
                        target_extensions
                            ? optional(
                                  target_extensions->as_object(),
                                  "KHR_animation_pointer")
                            : nullptr;
                    if (!pointer_extension) {
                        throw std::runtime_error(
                            "glTF pointer channel is missing its KHR_animation_pointer target.");
                    }
                    // Dropped before dispatch, so an unported target the pin
                    // DOES resolve still fails explicitly below rather than
                    // rendering a value nothing animates.
                    const std::string pointer_target =
                        required(
                            pointer_extension->as_object(),
                            "pointer")
                            .as_string();
                    if (pointer_unhandled_upstream(pointer_target)) {
                        continue;
                    }
                    // A /nodes/{n}/{translation|rotation|scale|weights}
                    // pointer is semantically identical to a standard channel
                    // on node n. The pin emits a standard channel for it so it
                    // flows through the proven topological node-TRS and morph
                    // writeback, which moves the node and its descendants,
                    // rather than through an opaque per-node writer. Rewriting
                    // the target here reaches the same code for the same
                    // reason.
                    {
                        const std::string node_prefix = "/nodes/";
                        if (pointer_target.rfind(node_prefix, 0) == 0) {
                            const std::size_t index_start =
                                node_prefix.size();
                            std::size_t index_end = index_start;
                            while (
                                index_end < pointer_target.size() &&
                                std::isdigit(static_cast<unsigned char>(
                                    pointer_target[index_end]))) {
                                ++index_end;
                            }
                            const std::string node_path =
                                pointer_target.substr(index_end);
                            if (
                                index_end > index_start &&
                                (node_path == "/translation" ||
                                 node_path == "/rotation" ||
                                 node_path == "/scale" ||
                                 node_path == "/weights")) {
                                pointer_node_override = true;
                                pointer_node_index =
                                    static_cast<std::size_t>(
                                        std::stoull(
                                            pointer_target.substr(
                                                index_start,
                                                index_end - index_start)));
                                path_name = node_path.substr(1);
                            }
                        }
                    }
                    // /extensions/KHR_lights_punctual/lights/{l}/{color|
                    // intensity|range|spot/outerConeAngle}. The pinned writers
                    // set diffuse AND specular from a colour, and an outer
                    // cone angle sets the light's full angle to twice the
                    // value, which its setter turns back into cos(angle / 2).
                    {
                        const std::string light_prefix =
                            "/extensions/KHR_lights_punctual/lights/";
                        if (
                            !pointer_node_override &&
                            pointer_target.rfind(light_prefix, 0) == 0) {
                            std::size_t index_end = light_prefix.size();
                            while (
                                index_end < pointer_target.size() &&
                                std::isdigit(static_cast<unsigned char>(
                                    pointer_target[index_end]))) {
                                ++index_end;
                            }
                            const std::string light_field =
                                pointer_target.substr(index_end);
                            LightTrack track;
                            std::size_t components = 0;
                            if (light_field == "/color") {
                                track.kind = LightTrackKind::color;
                                components = 3;
                            } else if (light_field == "/intensity") {
                                track.kind = LightTrackKind::intensity;
                                components = 1;
                            } else if (light_field == "/range") {
                                track.kind = LightTrackKind::range;
                                components = 1;
                            } else if (
                                light_field == "/spot/outerConeAngle") {
                                track.kind =
                                    LightTrackKind::outer_cone_angle;
                                components = 1;
                            } else {
                                throw std::runtime_error(
                                    "Reached KHR_animation_pointer lowering supports light color, intensity, range and outer cone angle targets only: " +
                                    pointer_target + ".");
                            }
                            const std::size_t light_definition =
                                static_cast<std::size_t>(
                                    std::stoull(
                                        pointer_target.substr(
                                            light_prefix.size(),
                                            index_end -
                                                light_prefix.size())));
                            // The pinned writer reads the light back through
                            // the asset and does nothing when it is absent, so
                            // a channel targeting a light type this loader
                            // skips is dropped rather than fatal.
                            if (
                                light_definition >= punctual_lights.size() ||
                                punctual_lights[light_definition].value ==
                                    invalid_handle) {
                                continue;
                            }
                            track.light =
                                punctual_lights[light_definition];
                            const JsonObject& light_sampler =
                                animation_samplers
                                    .at(unsigned_value(
                                        required(channel, "sampler")))
                                    .as_object();
                            const std::string light_interpolation =
                                string_or(
                                    light_sampler,
                                    "interpolation",
                                    "LINEAR");
                            if (light_interpolation != "LINEAR") {
                                throw std::runtime_error(
                                    "Reached KHR_animation_pointer light targets support LINEAR interpolation only.");
                            }
                            const AccessorInfo& light_input =
                                accessors.at(unsigned_value(
                                    required(light_sampler, "input")));
                            const AccessorInfo& light_output =
                                accessors.at(unsigned_value(
                                    required(light_sampler, "output")));
                            if (
                                light_input.type != "SCALAR" ||
                                light_input.count != light_output.count ||
                                component_count(light_output.type) !=
                                    components) {
                                throw std::runtime_error(
                                    "glTF light pointer accessors have an unsupported layout.");
                            }
                            for (
                                std::size_t index = 0;
                                index < light_input.count;
                                ++index) {
                                const float time = read_component(
                                    buffer,
                                    container,
                                    views,
                                    light_input,
                                    index,
                                    0);
                                track.times.push_back(time);
                                note_clip_time(time);
                                Vec4 value{};
                                float* const channels[4] = {
                                    &value.x,
                                    &value.y,
                                    &value.z,
                                    &value.w,
                                };
                                for (
                                    std::size_t component = 0;
                                    component < components;
                                    ++component) {
                                    *channels[component] = read_component(
                                        buffer,
                                        container,
                                        views,
                                        light_output,
                                        index,
                                        component);
                                }
                                track.values.push_back(value);
                            }
                            animation_runtime->light_tracks.push_back(
                                std::move(track));
                            continue;
                        }
                    }
                    if (!pointer_node_override) {
                    const std::string pointer =
                        required(
                            pointer_extension->as_object(),
                            "pointer")
                            .as_string();
${animationPointerMaterials ? `                    // Material targets. The pinned base module hands these to
                    // animation-pointer-basecolor and -ext; the three the
                    // asset reaches all write a PBR factor the fragment
                    // reads back out of the material record every frame.
                    const std::string material_prefix = "/materials/";
                    if (
                        pointer.compare(
                            0,
                            material_prefix.size(),
                            material_prefix) == 0) {
                        const std::size_t suffix_start =
                            pointer.find('/', material_prefix.size());
                        if (suffix_start == std::string::npos) {
                            throw std::runtime_error(
                                "glTF animation pointer names no material property: " +
                                pointer + ".");
                        }
                        const std::string material_index_text =
                            pointer.substr(
                                material_prefix.size(),
                                suffix_start - material_prefix.size());
                        const std::string property =
                            pointer.substr(suffix_start);
                        if (
                            material_index_text.find_first_not_of(
                                "0123456789") != std::string::npos) {
                            throw std::runtime_error(
                                "glTF animation pointer has a non-numeric material index: " +
                                pointer + ".");
                        }
                        const std::size_t material_index =
                            static_cast<std::size_t>(
                                std::stoull(material_index_text));
                        MaterialTrack track;
                        std::size_t components = 0;
                        if (property == "/pbrMetallicRoughness/baseColorFactor") {
                            track.kind =
                                MaterialTrackKind::base_color_factor;
                            components = 4;
                        } else if (property == "/emissiveFactor") {
                            track.kind =
                                MaterialTrackKind::emissive_factor;
                            components = 3;
                        } else if (
                            property ==
                            "/extensions/KHR_materials_emissive_strength/emissiveStrength") {
                            track.kind =
                                MaterialTrackKind::emissive_strength;
                            components = 1;
                        } else if (
                            property ==
                            "/pbrMetallicRoughness/metallicFactor") {
                            track.kind =
                                MaterialTrackKind::roughness_from_metallic;
                            components = 1;
                        } else if (property == "/normalTexture/scale") {
                            track.kind =
                                MaterialTrackKind::normal_texture_scale;
                            components = 1;
                        } else if (property == "/occlusionTexture/strength") {
                            track.kind =
                                MaterialTrackKind::occlusion_strength;
                            components = 1;
                        } else if (
                            property ==
                            "/extensions/KHR_materials_transmission/transmissionFactor") {
                            track.kind =
                                MaterialTrackKind::transmission_factor;
                            components = 1;
                        } else if (
                            property ==
                            "/extensions/KHR_materials_ior/ior") {
                            track.kind =
                                MaterialTrackKind::index_of_refraction;
                            components = 1;
                        } else if (
                            property ==
                            "/extensions/KHR_materials_volume/thicknessFactor") {
                            track.kind =
                                MaterialTrackKind::volume_thickness;
                            components = 1;
                        } else if (
                            property ==
                            "/extensions/KHR_materials_volume/attenuationDistance") {
                            track.kind =
                                MaterialTrackKind::volume_attenuation_distance;
                            components = 1;
                        } else if (
                            property ==
                            "/extensions/KHR_materials_volume/attenuationColor") {
                            track.kind =
                                MaterialTrackKind::volume_attenuation_color;
                            components = 3;
                        } else if (
                            property ==
                            "/extensions/KHR_materials_iridescence/iridescenceFactor") {
                            track.kind =
                                MaterialTrackKind::iridescence_factor;
                            components = 1;
                        } else if (
                            property ==
                            "/extensions/KHR_materials_iridescence/iridescenceIor") {
                            track.kind =
                                MaterialTrackKind::iridescence_index_of_refraction;
                            components = 1;
                        } else if (
                            property ==
                            "/extensions/KHR_materials_iridescence/iridescenceThicknessMaximum") {
                            track.kind =
                                MaterialTrackKind::iridescence_maximum_thickness;
                            components = 1;
                        } else {
                            // A KHR_texture_transform pointer names the slot,
                            // then the extension, then one of its three
                            // components. The pin resolves the slot to the
                            // runtime texture wrapper and drives uAng,
                            // uOffset/vOffset or uScale/vScale on it.
                            const std::string transform_infix =
                                "/extensions/KHR_texture_transform/";
                            const std::size_t transform_start =
                                property.rfind(transform_infix);
                            bool resolved = false;
                            if (transform_start != std::string::npos) {
                                const std::string component_name =
                                    property.substr(
                                        transform_start +
                                        transform_infix.size());
                                const std::string slot_path =
                                    property.substr(0, transform_start);
                                if (
                                    material_transform_slot(
                                        slot_path,
                                        track.slot)) {
                                    if (component_name == "rotation") {
                                        track.component =
                                            TextureTransformComponent::rotation;
                                        components = 1;
                                        resolved = true;
                                    } else if (component_name == "offset") {
                                        track.component =
                                            TextureTransformComponent::offset;
                                        components = 2;
                                        resolved = true;
                                    } else if (component_name == "scale") {
                                        track.component =
                                            TextureTransformComponent::scale;
                                        components = 2;
                                        resolved = true;
                                    }
                                }
                            }
                            if (!resolved) {
                                throw std::runtime_error(
                                    "Reached KHR_animation_pointer lowering supports base color, emissive factor, emissive strength and texture transform material targets only: " +
                                    pointer + ".");
                            }
                            track.kind =
                                MaterialTrackKind::texture_transform;
                        }
                        if (material_index >= materials.size()) {
                            throw std::runtime_error(
                                "glTF animation pointer targets a material that does not exist.");
                        }
                        track.material = materials[material_index].value;
                        const JsonObject& material_sampler =
                            animation_samplers
                                .at(unsigned_value(
                                    required(channel, "sampler")))
                                .as_object();
                        if (
                            string_or(
                                material_sampler,
                                "interpolation",
                                "LINEAR") != "LINEAR") {
                            throw std::runtime_error(
                                "glTF material animation supports LINEAR interpolation.");
                        }
                        const AccessorInfo& material_input =
                            accessors.at(unsigned_value(
                                required(material_sampler, "input")));
                        const AccessorInfo& material_output =
                            accessors.at(unsigned_value(
                                required(material_sampler, "output")));
                        if (
                            material_input.type != "SCALAR" ||
                            component_count(material_output.type) !=
                                components ||
                            material_output.count != material_input.count) {
                            throw std::runtime_error(
                                "glTF material animation accessor layout is invalid.");
                        }
                        for (
                            std::size_t index = 0;
                            index < material_input.count;
                            ++index) {
                            const float time = read_component(
                                buffer,
                                container,
                                views,
                                material_input,
                                index,
                                0);
                            track.times.push_back(time);
                            note_clip_time(time);
                            Vec4 value{};
                            float* channels[4] = {
                                &value.x,
                                &value.y,
                                &value.z,
                                &value.w,
                            };
                            for (
                                std::size_t component = 0;
                                component < components;
                                ++component) {
                                *channels[component] = read_component(
                                    buffer,
                                    container,
                                    views,
                                    material_output,
                                    index,
                                    component);
                            }
                            track.values.push_back(value);
                        }
                        animation_runtime->material_tracks.push_back(
                            std::move(track));
                        continue;
                    }
` : ""}                    const std::string pointer_prefix = "/nodes/";
                    const std::string pointer_suffix =
                        "/extensions/KHR_node_visibility/visible";
                    const bool visibility_pointer =
                        pointer.size() >
                            pointer_prefix.size() + pointer_suffix.size() &&
                        pointer.compare(
                            0,
                            pointer_prefix.size(),
                            pointer_prefix) == 0 &&
                        pointer.compare(
                            pointer.size() - pointer_suffix.size(),
                            pointer_suffix.size(),
                            pointer_suffix) == 0;
                    const std::string pointer_node_text =
                        visibility_pointer
                            ? pointer.substr(
                                  pointer_prefix.size(),
                                  pointer.size() -
                                      pointer_prefix.size() -
                                      pointer_suffix.size())
                            : std::string();
                    if (
                        !visibility_pointer ||
                        pointer_node_text.find_first_not_of("0123456789") !=
                            std::string::npos) {
                        throw std::runtime_error(
                            "Reached KHR_animation_pointer lowering supports node visibility targets only: " +
                            pointer + ".");
                    }
                    const std::size_t visibility_node =
                        static_cast<std::size_t>(
                            std::stoull(pointer_node_text));
                    if (visibility_node >= node_json.size()) {
                        throw std::runtime_error(
                            "glTF animation pointer targets a node that does not exist.");
                    }
                    const JsonObject& pointer_sampler =
                        animation_samplers
                            .at(unsigned_value(
                                required(channel, "sampler")))
                            .as_object();
                    if (
                        string_or(
                            pointer_sampler,
                            "interpolation",
                            "LINEAR") != "STEP") {
                        // Visibility is a boolean; the pin authors it STEP
                        // and interpolating one would have no meaning.
                        throw std::runtime_error(
                            "glTF node-visibility animation requires STEP interpolation.");
                    }
                    const AccessorInfo& pointer_input =
                        accessors.at(unsigned_value(
                            required(pointer_sampler, "input")));
                    const AccessorInfo& pointer_output =
                        accessors.at(unsigned_value(
                            required(pointer_sampler, "output")));
                    if (
                        pointer_input.type != "SCALAR" ||
                        pointer_output.type != "SCALAR" ||
                        pointer_output.count != pointer_input.count) {
                        throw std::runtime_error(
                            "glTF node-visibility animation accessor layout is invalid.");
                    }
                    VisibilityTrack track;
                    track.node = visibility_node;
                    track.subtree.push_back(visibility_node);
                    for (
                        std::size_t index = 0;
                        index < parents.size();
                        ++index) {
                        for (
                            int ancestor = parents[index];
                            ancestor >= 0;
                            ancestor =
                                parents[static_cast<std::size_t>(ancestor)]) {
                            if (
                                static_cast<std::size_t>(ancestor) ==
                                visibility_node) {
                                track.subtree.push_back(index);
                                break;
                            }
                        }
                    }
                    for (
                        std::size_t index = 0;
                        index < pointer_input.count;
                        ++index) {
                        const float time = read_component(
                            buffer,
                            container,
                            views,
                            pointer_input,
                            index,
                            0);
                        track.times.push_back(time);
                        note_clip_time(time);
                        track.values.push_back(
                            read_component(
                                buffer,
                                container,
                                views,
                                pointer_output,
                                index,
                                0) != 0.0f);
                    }
                    track.clip = clip_index;
                    animation_runtime
                        ->visibility_tracks
                        .push_back(std::move(track));
                    continue;
                    }
                }` : ""}
                if (
                    path_name != "rotation" &&
                    path_name != "translation" &&
                    path_name != "scale" &&
                    path_name != "weights") {
                    throw std::runtime_error(
                        "Reached glTF animation lowering currently supports rotation, translation, scale, and weights channels.");
                }
                const std::size_t sampler_index =
                    unsigned_value(required(channel, "sampler"));
                const JsonObject& sampler =
                    animation_samplers.at(sampler_index).as_object();
                const std::string interpolation =
                    string_or(sampler, "interpolation", "LINEAR");
                if (
                    interpolation != "LINEAR" &&
                    interpolation != "CUBICSPLINE") {
                    throw std::runtime_error(
                        "Reached glTF animation lowering supports LINEAR and CUBICSPLINE interpolation.");
                }
                const AccessorInfo& input =
                    accessors.at(unsigned_value(required(sampler, "input")));
                const AccessorInfo& output =
                    accessors.at(unsigned_value(required(sampler, "output")));
                const std::size_t target_node =
                    pointer_node_override
                        ? pointer_node_index
                        : unsigned_value(required(target, "node"));
                if (input.type != "SCALAR") {
                    throw std::runtime_error(
                        "glTF animation input accessor must be SCALAR.");
                }
                for (std::size_t index = 0; index < input.count; ++index) {
                    const float time = read_component(
                        buffer,
                        container,
                        views,
                        input,
                        index,
                        0);
                    note_clip_time(time);
                }
                if (path_name == "rotation") {
                    const bool cubic =
                        interpolation == "CUBICSPLINE";
                    if (
                        output.type != "VEC4" ||
                        output.count !=
                            input.count * (cubic ? 3u : 1u)) {
                        throw std::runtime_error(
                            "glTF rotation animation accessor layout is invalid.");
                    }
                    RotationTrack track;
                    track.node = target_node;
                    track.cubic = cubic;
                    for (std::size_t index = 0; index < input.count; ++index) {
                        track.times.push_back(
                            read_component(
                                buffer,
                                container,
                                views,
                                input,
                                index,
                                0));
                        const std::size_t value_index =
                            cubic ? index * 3 + 1 : index;
                        const auto read_quaternion =
                            [&](std::size_t output_index) {
                            return Vec4{
                                read_component(buffer, container, views, output, output_index, 0),
                                read_component(buffer, container, views, output, output_index, 1),
                                read_component(buffer, container, views, output, output_index, 2),
                                read_component(buffer, container, views, output, output_index, 3),
                            };
                        };
                        track.values.push_back(
                            read_quaternion(value_index));
                        if (cubic) {
                            track.in_tangents.push_back(
                                read_quaternion(index * 3));
                            track.out_tangents.push_back(
                                read_quaternion(index * 3 + 2));
                        }
                    }
                    track.clip = clip_index;
                    animation_runtime
                        ->rotation_tracks
                        .push_back(std::move(track));
                } else if (
                    path_name == "translation" ||
                    path_name == "scale") {
                    const bool cubic =
                        interpolation == "CUBICSPLINE";
                    if (
                        output.type != "VEC3" ||
                        output.count !=
                            input.count * (cubic ? 3u : 1u)) {
                        throw std::runtime_error(
                            "glTF translation or scale animation accessor layout is invalid.");
                    }
                    TranslationTrack track;
                    track.node = target_node;
                    track.cubic = cubic;
                    for (std::size_t index = 0; index < input.count; ++index) {
                        track.times.push_back(
                            read_component(buffer, container, views, input, index, 0));
                        const std::size_t value_index =
                            cubic ? index * 3 + 1 : index;
                        const auto read_translation =
                            [&](std::size_t output_index) {
                            return Vec3{
                                read_component(buffer, container, views, output, output_index, 0),
                                read_component(buffer, container, views, output, output_index, 1),
                                read_component(buffer, container, views, output, output_index, 2),
                            };
                        };
                        track.values.push_back(
                            read_translation(value_index));
                        if (cubic) {
                            track.in_tangents.push_back(
                                read_translation(index * 3));
                            track.out_tangents.push_back(
                                read_translation(index * 3 + 2));
                        }
                    }
                    if (path_name == "translation") {
                        track.clip = clip_index;
                        animation_runtime
                            ->translation_tracks
                            .push_back(std::move(track));
                    } else {
                        track.clip = clip_index;
                        animation_runtime
                            ->scale_tracks
                            .push_back(std::move(track));
                    }
                } else {
                    if (interpolation != "LINEAR") {
                        throw std::runtime_error(
                            "glTF weights animation currently requires LINEAR interpolation.");
                    }
                    if (
                        output.type != "SCALAR" ||
                        input.count == 0 ||
                        output.count % input.count != 0) {
                        throw std::runtime_error(
                            "glTF weights animation accessor layout is invalid.");
                    }
                    WeightTrack track;
                    track.node = target_node;
                    track.target_count =
                        output.count / input.count;
                    for (std::size_t index = 0; index < input.count; ++index) {
                        track.times.push_back(
                            read_component(
                                buffer,
                                container,
                                views,
                                input,
                                index,
                                0));
                        for (std::size_t target_index = 0; target_index < track.target_count; ++target_index) {
                            track.values.push_back(
                                read_component(
                                    buffer,
                                    container,
                                    views,
                                    output,
                                    index * track.target_count + target_index,
                                    0));
                        }
                    }
                    track.clip = clip_index;
                    animation_runtime
                        ->weight_tracks
                        .push_back(std::move(track));
                }
            }
        }
        const auto apply_animation_time =
            [animation_runtime, &engine](float time, bool seek) {
            // The master clock is the scene's elapsed animation time and no
            // longer wraps: each clip loops over its own duration, the way
            // upstream's per-group controllers do, and a clip upstream never
            // started holds at zero.
            animation_runtime->time = std::max(time, 0.0f);
            for (AnimationClip& clip : animation_runtime->clips) {
                if (seek ? clip.stopped : !clip.playing) {
                    continue;
                }
                clip.time = clip.duration > 0.0f
                    ? std::fmod(
                          animation_runtime->time,
                          clip.duration)
                    : 0.0f;
                if (seek) {
                    clip.playing = false;
                }
            }${animationPointer ? `
            for (const VisibilityTrack& track :
                 animation_runtime->visibility_tracks) {
                const AnimationClip& clip =
                    animation_runtime->clips[track.clip];
                if (clip.stopped) continue;
                if (track.times.empty()) continue;
                // STEP holds each output until the next keyframe, so the
                // key in effect is the last one at or before the current
                // time and the first key holds before that.
                std::size_t key = 0;
                while (
                    key + 1 < track.times.size() &&
                    track.times[key + 1] <=
                        clip.time) {
                    ++key;
                }
                const bool visible = track.values[key];
                for (const std::size_t node : track.subtree) {
                    if (
                        node >=
                        animation_runtime->node_meshes.size()) {
                        continue;
                    }
                    for (
                        const std::uint32_t mesh :
                        animation_runtime->node_meshes[node]) {
                        if (mesh < engine.meshes.size()) {
                            engine.meshes[mesh].visible = visible;
                        }
                    }
                }
            }` : ""}
${animationPointerMaterials ? `            for (const MaterialTrack& track :
                 animation_runtime->material_tracks) {
                const AnimationClip& clip =
                    animation_runtime->clips[track.clip];
                if (clip.stopped) continue;
                if (
                    track.times.empty() ||
                    track.material >= engine.materials.size()) {
                    continue;
                }
                std::size_t right = 1;
                while (
                    right < track.times.size() &&
                    track.times[right] < clip.time) {
                    ++right;
                }
                if (right >= track.times.size()) {
                    right = track.times.size() - 1;
                }
                const std::size_t left = right > 0 ? right - 1 : 0;
                const double span =
                    static_cast<double>(track.times[right]) -
                    track.times[left];
                const double amount = span > 0.0
                    ? std::clamp(
                          (static_cast<double>(
                               clip.time) -
                           track.times[left]) /
                              span,
                          0.0,
                          1.0)
                    : 0.0;
                const Vec4& a = track.values[left];
                const Vec4& b = track.values[right];
                const auto mix = [&](float from, float to) {
                    return static_cast<float>(
                        from + (to - from) * amount);
                };
                MaterialRecord& material =
                    engine.materials[track.material];
                switch (track.kind) {
                    case MaterialTrackKind::base_color_factor:
                        material.base_color_factor = Color4{
                            mix(a.x, b.x),
                            mix(a.y, b.y),
                            mix(a.z, b.z),
                            mix(a.w, b.w),
                        };
                        break;
                    case MaterialTrackKind::emissive_factor:
                        material.emissive_base_factor = Color3{
                            mix(a.x, b.x),
                            mix(a.y, b.y),
                            mix(a.z, b.z),
                        };
                        break;
                    case MaterialTrackKind::emissive_strength:
                        material.emissive_strength = mix(a.x, b.x);
                        break;
                    case MaterialTrackKind::roughness_from_metallic:
                        material.roughness_factor = mix(a.x, b.x);
                        break;
                    case MaterialTrackKind::normal_texture_scale:
                        material.normal_texture_scale = mix(a.x, b.x);
                        break;
                    case MaterialTrackKind::occlusion_strength:
                        material.occlusion_strength = mix(a.x, b.x);
                        break;
                    case MaterialTrackKind::transmission_factor:
                        material.transmission_factor = mix(a.x, b.x);
                        break;
                    case MaterialTrackKind::index_of_refraction:
                        // The render plan recomposes the dielectric ratio from
                        // this every frame, so writing the index is the whole
                        // of it — the pin instead reaches its reflectance ext,
                        // which arrives at the same F0.
                        material.index_of_refraction = mix(a.x, b.x);
                        break;
                    case MaterialTrackKind::volume_thickness:
                        material.thickness = mix(a.x, b.x);
                        break;
                    case MaterialTrackKind::volume_attenuation_distance:
                        material.attenuation_distance = mix(a.x, b.x);
                        break;
                    case MaterialTrackKind::volume_attenuation_color:
                        material.attenuation_color = Color3{
                            mix(a.x, b.x),
                            mix(a.y, b.y),
                            mix(a.z, b.z),
                        };
                        break;
                    case MaterialTrackKind::iridescence_factor:
                        material.iridescence_intensity = mix(a.x, b.x);
                        break;
                    case MaterialTrackKind::iridescence_index_of_refraction:
                        material.iridescence_index_of_refraction =
                            mix(a.x, b.x);
                        break;
                    case MaterialTrackKind::iridescence_maximum_thickness:
                        material.iridescence_maximum_thickness =
                            mix(a.x, b.x);
                        break;
                    case MaterialTrackKind::texture_transform: {
                        TextureTransform& slot =
                            material_transform(material, track.slot);
                        if (
                            track.component ==
                            TextureTransformComponent::rotation) {
                            slot.rotation = mix(a.x, b.x);
                        } else if (
                            track.component ==
                            TextureTransformComponent::offset) {
                            slot.u_offset = mix(a.x, b.x);
                            slot.v_offset = mix(a.y, b.y);
                        } else {
                            slot.u_scale = mix(a.x, b.x);
                            slot.v_scale = mix(a.y, b.y);
                        }
                        break;
                    }
                }
                // The load-time fold, redone from whichever half moved.
                material.emissive_factor = Color3{
                    material.emissive_base_factor.r *
                        material.emissive_strength,
                    material.emissive_base_factor.g *
                        material.emissive_strength,
                    material.emissive_base_factor.b *
                        material.emissive_strength,
                };
            }
` : ""}${animationPointer ? `            for (const LightTrack& track :
                 animation_runtime->light_tracks) {
                const AnimationClip& clip =
                    animation_runtime->clips[track.clip];
                if (clip.stopped) continue;
                if (
                    track.times.empty() ||
                    track.light.value >= engine.lights.size()) {
                    continue;
                }
                std::size_t right = 1;
                while (
                    right < track.times.size() &&
                    track.times[right] < clip.time) {
                    ++right;
                }
                const std::size_t left =
                    right < track.times.size() ? right - 1 : right - 1;
                const std::size_t clamped_right =
                    std::min(right, track.times.size() - 1);
                const float span =
                    track.times[clamped_right] - track.times[left];
                const float amount = span > 0.0f
                    ? std::clamp(
                          (clip.time - track.times[left]) /
                              span,
                          0.0f,
                          1.0f)
                    : 0.0f;
                const Vec4& a = track.values[left];
                const Vec4& b = track.values[clamped_right];
                const auto mix =
                    [amount](const float from, const float to) {
                    return from + (to - from) * amount;
                };
                LightRecord& light = engine.lights[track.light.value];
                switch (track.kind) {
                    case LightTrackKind::color:
                        // The pinned writer sets diffuse and specular alike.
                        light.diffuse_color = Color3{
                            mix(a.x, b.x),
                            mix(a.y, b.y),
                            mix(a.z, b.z),
                        };
                        light.specular_color = light.diffuse_color;
                        break;
                    case LightTrackKind::intensity:
                        light.intensity = mix(a.x, b.x);
                        break;
                    case LightTrackKind::range:
                        light.range = mix(a.x, b.x);
                        break;
                    case LightTrackKind::outer_cone_angle:
                        // angle = value * 2, and the light stores
                        // cos(angle / 2), so the cosine is of the value.
                        light.cos_half_angle =
                            std::cos(mix(a.x, b.x));
                        break;
                }
            }
` : ""}            for (const RotationTrack& track :
                 animation_runtime->rotation_tracks) {
                const AnimationClip& clip =
                    animation_runtime->clips[track.clip];
                if (clip.stopped) continue;
                if (
                    track.times.empty() ||
                    track.node >=
                        animation_runtime->node_meshes.size()) {
                    continue;
                }
                std::size_t right = 1;
                while (
                    right < track.times.size() &&
                    track.times[right] <
                        clip.time) {
                    ++right;
                }
                if (right >= track.times.size()) {
                    right = track.times.size() - 1;
                }
                const std::size_t left =
                    right > 0 ? right - 1 : 0;
                const double span =
                    static_cast<double>(track.times[right]) -
                    track.times[left];
                const double amount =
                    span > 0.0
                        ? std::clamp(
                              (static_cast<double>(
                                   clip.time) -
                               track.times[left]) /
                                  span,
                              0.0,
                              1.0)
                        : 0.0;
                animation_runtime->nodes[track.node].rotation =
                    track.cubic
                        ? cubic_quaternion(
                              track.values[left],
                              track.out_tangents[left],
                              track.values[right],
                              track.in_tangents[right],
                              amount,
                              span)
                        : interpolate_quaternion(
                              track.values[left],
                              track.values[right],
                              amount);
            }
            for (const TranslationTrack& track :
                 animation_runtime->translation_tracks) {
                const AnimationClip& clip =
                    animation_runtime->clips[track.clip];
                if (clip.stopped) continue;
                if (
                    track.times.empty() ||
                    track.node >= animation_runtime->nodes.size()) {
                    continue;
                }
                std::size_t right = 1;
                while (
                    right < track.times.size() &&
                    track.times[right] <
                        clip.time) {
                    ++right;
                }
                if (right >= track.times.size()) {
                    right = track.times.size() - 1;
                }
                const std::size_t left =
                    right > 0 ? right - 1 : 0;
                const double span =
                    static_cast<double>(track.times[right]) -
                    track.times[left];
                const double amount =
                    span > 0.0
                        ? std::clamp(
                              (static_cast<double>(
                                   clip.time) -
                               track.times[left]) /
                                  span,
                              0.0,
                              1.0)
                        : 0.0;
                const Vec3 left_value = track.values[left];
                const Vec3 right_value = track.values[right];
                animation_runtime->nodes[track.node].translation =
                    track.cubic
                        ? cubic_vec3(
                              left_value,
                              track.out_tangents[left],
                              right_value,
                              track.in_tangents[right],
                              amount,
                              span)
                        : Vec3{
                              static_cast<float>(
                                  left_value.x +
                                  (static_cast<double>(
                                       right_value.x) -
                                   left_value.x) *
                                      amount),
                              static_cast<float>(
                                  left_value.y +
                                  (static_cast<double>(
                                       right_value.y) -
                                   left_value.y) *
                                      amount),
                              static_cast<float>(
                                  left_value.z +
                                  (static_cast<double>(
                                       right_value.z) -
                                   left_value.z) *
                                      amount),
                          };
            }
            for (const TranslationTrack& track :
                 animation_runtime->scale_tracks) {
                const AnimationClip& clip =
                    animation_runtime->clips[track.clip];
                if (clip.stopped) continue;
                if (
                    track.times.empty() ||
                    track.node >= animation_runtime->nodes.size()) {
                    continue;
                }
                std::size_t right = 1;
                while (
                    right < track.times.size() &&
                    track.times[right] <
                        clip.time) {
                    ++right;
                }
                if (right >= track.times.size()) {
                    right = track.times.size() - 1;
                }
                const std::size_t left =
                    right > 0 ? right - 1 : 0;
                const double span =
                    static_cast<double>(track.times[right]) -
                    track.times[left];
                const double amount =
                    span > 0.0
                        ? std::clamp(
                              (static_cast<double>(
                                   clip.time) -
                               track.times[left]) /
                                  span,
                              0.0,
                              1.0)
                        : 0.0;
                const Vec3 left_value = track.values[left];
                const Vec3 right_value = track.values[right];
                animation_runtime->nodes[track.node].scale =
                    track.cubic
                        ? cubic_vec3(
                              left_value,
                              track.out_tangents[left],
                              right_value,
                              track.in_tangents[right],
                              amount,
                              span)
                        : Vec3{
                              static_cast<float>(
                                  left_value.x +
                                  (static_cast<double>(
                                       right_value.x) -
                                   left_value.x) *
                                      amount),
                              static_cast<float>(
                                  left_value.y +
                                  (static_cast<double>(
                                       right_value.y) -
                                   left_value.y) *
                                      amount),
                              static_cast<float>(
                                  left_value.z +
                                  (static_cast<double>(
                                       right_value.z) -
                                   left_value.z) *
                                      amount),
                          };
            }
            for (
                auto track_iterator =
                    animation_runtime
                        ->weight_tracks.rbegin();
                track_iterator !=
                    animation_runtime
                        ->weight_tracks.rend();
                ++track_iterator) {
                const WeightTrack& track =
                    *track_iterator;
                const AnimationClip& clip =
                    animation_runtime->clips[track.clip];
                if (clip.stopped) continue;
                if (
                    track.times.empty() ||
                    track.node >= animation_runtime->nodes.size()) {
                    continue;
                }
                std::size_t right = 1;
                while (
                    right < track.times.size() &&
                    track.times[right] <
                        clip.time) {
                    ++right;
                }
                if (right >= track.times.size()) {
                    right = track.times.size() - 1;
                }
                const std::size_t left =
                    right > 0 ? right - 1 : 0;
                const double span =
                    static_cast<double>(track.times[right]) -
                    track.times[left];
                const double amount =
                    span > 0.0
                        ? std::clamp(
                              (static_cast<double>(
                                   clip.time) -
                               track.times[left]) /
                                  span,
                              0.0,
                              1.0)
                        : 0.0;
                AnimatedNode& node =
                    animation_runtime->nodes[track.node];
                node.weights.resize(track.target_count);
                for (std::size_t target = 0; target < track.target_count; ++target) {
                    const float left_value =
                        track.values[left * track.target_count + target];
                    const float right_value =
                        track.values[right * track.target_count + target];
                    node.weights[target] = static_cast<float>(
                        left_value +
                        (static_cast<double>(right_value) -
                         left_value) *
                            amount);
                }
            }
            for (AnimatedNode& node : animation_runtime->nodes) {
                node.computed = false;
                node.computing = false;
            }
            std::function<const Matrix&(std::size_t)> compute_animated_world =
                [&](std::size_t node_index) -> const Matrix& {
                AnimatedNode& node =
                    animation_runtime->nodes.at(node_index);
                if (node.computed) return node.world;
                if (node.computing) {
                    throw std::runtime_error(
                        "glTF animated node hierarchy contains a cycle.");
                }
                node.computing = true;
                const Matrix local = node.has_matrix
                    ? node.matrix
                    : trs_matrix(
                          node.translation,
                          node.rotation,
                          node.scale);
                node.world = node.parent >= 0
                    ? multiply_matrix(
                          compute_animated_world(
                              static_cast<std::size_t>(
                                  node.parent)),
                          local)
                    : local;
                node.computing = false;
                node.computed = true;
                return node.world;
            };${animationPointer ? `
            // The pinned loader parents each punctual light to the node that
            // instantiates it, so an animated node carries its light with it.
            // Recomposed from the same world matrix and the same mirror
            // convention the load-time path uses.
            for (const AnimatedLightBinding& binding :
                 animation_runtime->light_nodes) {
                if (
                    binding.light.value >= engine.lights.size() ||
                    binding.node >= animation_runtime->nodes.size()) {
                    continue;
                }
                const Matrix& light_world =
                    compute_animated_world(binding.node);
                LightRecord& light =
                    engine.lights[binding.light.value];
                light.position = Vec3{
                    -light_world[12],
                    light_world[13],
                    light_world[14],
                };
                light.direction = normalize(Vec3{
                    light_world[8],
                    -light_world[9],
                    -light_world[10],
                });
            }` : ""}
            for (const AnimatedMeshBinding& binding :
                 animation_runtime->meshes) {
                ModelGeometry& geometry =
                    engine.geometries.at(binding.geometry);
                if (
                    geometry.bind_vertices.size() !=
                    geometry.vertices.size()) {
                    continue;
                }
                const Matrix& mesh_world =
                    compute_animated_world(binding.node);
                const bool skinned =
                    binding.skin <
                    animation_runtime->skins.size();
                const SkinRuntime* skin = skinned
                    ? &animation_runtime->skins[binding.skin]
                    : nullptr;
                std::vector<Matrix> joint_matrices;
                if (skin) {
                    joint_matrices.reserve(skin->joints.size());
                    for (std::size_t joint = 0; joint < skin->joints.size(); ++joint) {
                        joint_matrices.push_back(
                            multiply_matrix(
                                compute_animated_world(
                                    skin->joints[joint]),
                                skin->inverse_bind_matrices[joint]));
                    }
                }
                MeshRecord& mesh_record =
                    engine.meshes.at(binding.mesh);
                mesh_record.bone_matrices.clear();
                if (skin) {
                    for (const Matrix& joint_matrix : joint_matrices) {
                        mesh_record.bone_matrices.push_back(
                            native_matrix(joint_matrix));
                    }
                } else {
                    mesh_record.bone_matrices.push_back(
                        native_matrix(mesh_world));
                }
                mesh_record.morph_weights = {};
                const std::vector<float>& node_weights =
                    animation_runtime
                        ->nodes[binding.node]
                        .weights;
                for (
                    std::size_t target = 0;
                    target < node_weights.size() &&
                    target < mesh_record.morph_weights.size();
                    ++target) {
                    mesh_record.morph_weights[target] =
                        node_weights[target];
                }
#if BBLITE_GPU_MORPH_STORAGE
                if (
                    mesh_record.morph_storage_weights !=
                    node_weights) {
                    mesh_record.morph_storage_weights =
                        node_weights;
                    ++mesh_record.morph_weights_version;
                }
#endif
                if (
                    mesh_record.gpu_deformation &&
                    !geometry.flat_normals) {
                    ++mesh_record.transform_version;
                    continue;
                }
                for (
                    std::size_t vertex_index = 0;
                    vertex_index < geometry.vertices.size();
                    ++vertex_index) {
                    const ModelVertex& bind =
                        geometry.bind_vertices[vertex_index];
                    Vec3 morphed_position =
                        bind.local_position;
                    Vec3 morphed_normal{
                        -bind.normal.x,
                        bind.normal.y,
                        bind.normal.z,
                    };
                    Vec3 morphed_tangent{
                        -bind.tangent.x,
                        bind.tangent.y,
                        bind.tangent.z,
                    };
                    const std::vector<float>& morph_weights =
                        animation_runtime
                            ->nodes[binding.node]
                            .weights;
                    for (
                        std::size_t target = 0;
                        target < morph_weights.size() &&
                        target < geometry.morph_positions.size();
                        ++target) {
                        const float weight = morph_weights[target];
                        const Vec3 position_delta =
                            geometry.morph_positions[target][vertex_index];
                        const Vec3 normal_delta =
                            geometry.morph_normals[target][vertex_index];
                        const Vec3 tangent_delta =
                            geometry.morph_tangents[target][vertex_index];
                        morphed_position.x +=
                            position_delta.x * weight;
                        morphed_position.y +=
                            position_delta.y * weight;
                        morphed_position.z +=
                            position_delta.z * weight;
                        morphed_normal.x +=
                            normal_delta.x * weight;
                        morphed_normal.y +=
                            normal_delta.y * weight;
                        morphed_normal.z +=
                            normal_delta.z * weight;
                        morphed_tangent.x +=
                            tangent_delta.x * weight;
                        morphed_tangent.y +=
                            tangent_delta.y * weight;
                        morphed_tangent.z +=
                            tangent_delta.z * weight;
                    }
                    Vec3 position{};
                    Vec3 normal{};
                    Vec3 tangent{};
                    if (skin) {
                        const std::array<float, 4> weights{
                            bind.weights.x,
                            bind.weights.y,
                            bind.weights.z,
                            bind.weights.w,
                        };
                        for (std::size_t influence = 0; influence < 4; ++influence) {
                            const float weight = weights[influence];
                            const std::size_t joint = bind.joints[influence];
                            if (
                                weight <= 0.0f ||
                                joint >= joint_matrices.size()) {
                                continue;
                            }
                            const Vec3 joint_position =
                                transform_point_raw(
                                    joint_matrices[joint],
                                    morphed_position);
                            const Vec3 joint_normal =
                                transform_direction_raw(
                                    joint_matrices[joint],
                                    morphed_normal);
                            const Vec3 joint_tangent =
                                transform_direction_raw(
                                    joint_matrices[joint],
                                    morphed_tangent);
                            position.x += joint_position.x * weight;
                            position.y += joint_position.y * weight;
                            position.z += joint_position.z * weight;
                            normal.x += joint_normal.x * weight;
                            normal.y += joint_normal.y * weight;
                            normal.z += joint_normal.z * weight;
                            tangent.x += joint_tangent.x * weight;
                            tangent.y += joint_tangent.y * weight;
                            tangent.z += joint_tangent.z * weight;
                        }
                    } else {
                        position = transform_point_raw(
                            mesh_world,
                            morphed_position);
                        normal = transform_direction_raw(
                            mesh_world,
                            morphed_normal);
                        tangent = transform_direction_raw(
                            mesh_world,
                            morphed_tangent);
                    }
                    ModelVertex& vertex =
                        geometry.vertices[vertex_index];
                    vertex.position = Vec3{
                        -position.x,
                        position.y,
                        position.z,
                    };
                    vertex.normal = normalize(Vec3{
                        -normal.x,
                        normal.y,
                        normal.z,
                    });
                    const Vec3 native_tangent = normalize(Vec3{
                        -tangent.x,
                        tangent.y,
                        tangent.z,
                    });
                    vertex.tangent = Vec4{
                        native_tangent.x,
                        native_tangent.y,
                        native_tangent.z,
                        bind.tangent.w,
                    };
                }
                if (geometry.flat_normals) {
                    for (
                        std::size_t index = 0;
                        index < geometry.vertices.size();
                        index += 3) {
                        ModelVertex& a = geometry.vertices[index];
                        ModelVertex& b = geometry.vertices[index + 1];
                        ModelVertex& c = geometry.vertices[index + 2];
                        const Vec3 edge1{
                            b.position.x - a.position.x,
                            b.position.y - a.position.y,
                            b.position.z - a.position.z,
                        };
                        const Vec3 edge2{
                            c.position.x - a.position.x,
                            c.position.y - a.position.y,
                            c.position.z - a.position.z,
                        };
                        const Vec3 face = normalize(Vec3{
                            edge2.y * edge1.z - edge2.z * edge1.y,
                            edge2.z * edge1.x - edge2.x * edge1.z,
                            edge2.x * edge1.y - edge2.y * edge1.x,
                        });
                        a.normal = face;
                        b.normal = face;
                        c.normal = face;
                    }
                }
                ++mesh_record.transform_version;
            }
        };
        apply_animation_time(0.0f, false);
        // The clips scene code addresses, in the document's animation order,
        // plus the writers the group operations need — one per field the
        // pin's operations assign. The clip state stays inside this runtime;
        // only these writers reach it, the way animation_tick already does.
        for (const AnimationClip& clip : animation_runtime->clips) {
            engine.animation_groups.push_back(
                AnimationGroupRecord{
                    clip.name,
                    static_cast<std::uint32_t>(engine.assets.size()),
                    asset.animation_groups.size(),
                });
            asset.animation_groups.push_back(
                AnimationGroupHandle{static_cast<std::uint32_t>(
                    engine.animation_groups.size() - 1)});
        }
        asset.set_clip_playing =
            [animation_runtime](std::size_t clip, bool playing) {
            if (clip >= animation_runtime->clips.size()) return;
            animation_runtime->clips[clip].playing = playing;
        };
        asset.set_clip_stopped =
            [animation_runtime](std::size_t clip, bool stopped) {
            if (clip >= animation_runtime->clips.size()) return;
            animation_runtime->clips[clip].stopped = stopped;
        };
        asset.set_clip_time =
            [animation_runtime](std::size_t clip, float time) {
            if (clip >= animation_runtime->clips.size()) return;
            animation_runtime->clips[clip].time = std::max(time, 0.0f);
        };
        asset.animation_seek =
            [animation_runtime, apply_animation_time](float time) {
            animation_runtime->paused = true;
            apply_animation_time(time, true);
        };
        asset.animation_tick =
            [animation_runtime, apply_animation_time](float delta_ms) {
            if (animation_runtime->paused) return;
            apply_animation_time(
                animation_runtime->time +
                    delta_ms * 0.001f,
                false);
        };
    }
    if (asset.meshes.empty()) throw std::runtime_error("glTF contains no renderable meshes.");
    engine.assets.push_back(std::move(asset));
    return AssetHandle{static_cast<std::uint32_t>(engine.assets.size() - 1)};
}

} // namespace bbl
`;
}

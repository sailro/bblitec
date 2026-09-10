import { DEFORMATION_BONE_SLOTS } from "../../shader-builtins-standard.js";
import { compressedTextureFormat } from "../../compressed-texture-format.js";
// The document key packaging names the converted Gaussian-splat rows under,
// from the module that owns the document schema both sides read.
import { GAUSSIAN_SPLAT_DOCUMENT_KEY, GLTF_MESH_WALKS, GLTF_SOURCE_ALBEDO_IDENTITIES, GLTF_VARIANT_PLAN, GLTF_MESH_PLAN } from "../../gltf-document.js";
import type { GltfLoaderOptions } from "../gltf-lowerer.js";
import { gltfMaterialProjection } from "../gltf/material-projection.js";
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
    /** Complete pinned DataView component reader, including normalization. */
    accessorNormalization: string;
    /** Pinned accessor component counts and typed-array constructor widths. */
    accessorShape: string;
    hierarchy: string;
    parserJson: string;
    inverseBindMatrices: string;
    animationNodeRest: string;
    animationClips: string;
    materialAssembly: string;
    materialTextures: string;
    materialProperties: string;
    iblLoading: string;
    /** Pinned sRGB byte conversion. */
    factorBake: string;
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
     * The glTF `camera` node property (`_camera` feature), lowered from
     * `src/loader-gltf/gltf-feature-camera.ts#applyAsset`: the fold that
     * writes an imported camera's fixup-node world, the load-time walk
     * that builds one parented FreeCamera per referencing node, and the
     * per-pose refresh that keeps a live node's camera following it.
     * Empty strings when the scene never reached `enableGltfCameras`.
     */
    gltfCameraParentWriter: string;
    gltfCameraLoading: string;
    gltfCameraPoseRefresh: string;
    /**
     * The opt-in bone-control chunk: the skeleton build with its eager
     * bake, and the two entry points a scene reaches it through. Empty
     * strings when the scene never reached `enableBoneControl`.
     */
    boneControlLoading: string;
    boneControlEntryPoints: string;
}

/** One lowered glTF extension default: the JSON key and the C++ literal. */
export function gltfLoaderCpp(
    provenance: string,
    lowered: GltfLoaderLoweredSegments,
    options: GltfLoaderOptions = {},
): string {
    const {
        animationBlending = false,
        animationAdditive = false,
        managedGroups = false,
        vat = false,
        deformPicking = false,
        pinnedSkeletonPalette = false,
        dynamicThinInstances = false,
        meshClones = false,
        retainLocalNormals = false,
        sourceTextureReads = false,
        sourceMeshWalks = false,
        nonTrianglePrimitives = false,
        gaussianSplats = false,
        animationMask = false,
        animationSpeedRatio = false,
        nodeVisibility = false,
        interactivity = false,
        animationPointer = false,
        animatedWorldBounds = false,
        animationPointerMaterials = false,
        assetTransmission = false,
        selectedMaterialVariant = "",
        gltfCameras = false,
        boneControl = false,
        compressedImages = false,
    } = options;
    // The scene selected a variant, so the loader resolves each mapped
    // primitive's material. `JSON.stringify` is the C++ string literal: the
    // name is asset-declared text, and every other interpolated literal in
    // this template is a pin-derived JSON key that needs no escaping.
    const materialVariants = selectedMaterialVariant !== "";
    const selectedVariantLiteral = JSON.stringify(selectedMaterialVariant);
    // The features that contribute scene wiring the container chains at
    // add; the helper is emitted with its callers.
    const chainsSceneSetup = assetTransmission || gaussianSplats || interactivity;

    const factorBake = lowered.factorBake;
    return `// ${provenance}
#include <bblite/pal_gltf.hpp>
#include <bblite/pal_image_canvas.hpp>
#include <bblite/runtime.hpp>
#include <bblite/ts_runtime.hpp>
#include <bblite/upstream/gltf_glb_parser.hpp>
#include <bblite/upstream/pinned_matrix.hpp>
${compressedImages ? "#include <bblite/upstream/compressed_texture.hpp>\n" : ""}#include <bblite/upstream/pinned_world_transform.hpp>
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
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <unordered_map>
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

${lowered.parserJson}

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
${sourceMeshWalks ? `
void load_source_mesh_walks(AssetRecord& asset, const JsonObject& document) {
    const auto* packed = optional(document, ${JSON.stringify(GLTF_MESH_WALKS)});
    if (!packed) return; // This file has no reached source collector.
    std::vector<std::vector<double>> walks;
    for (const auto& row : packed->as_array()) {
        auto& walk = walks.emplace_back();
        for (const auto& entry : row.as_array()) walk.push_back(entry.as_number());
    }
    install_asset_mesh_walks(asset, walks);
}
` : ""}

bool bool_or(const JsonObject& object, const std::string& key, bool fallback) {
    const ts::JsonValue* value = optional(object, key);
    return value ? value->as_boolean() : fallback;
}

std::string string_or(const JsonObject& object, const std::string& key, std::string fallback = {}) {
    const ts::JsonValue* value = optional(object, key);
    return value ? value->as_string() : std::move(fallback);
}

${gaussianSplats ? `std::vector<float> float_array(const ts::JsonValue* value) {
    if (!value) return {};
    std::vector<float> result;
    for (const ts::JsonValue& element : value->as_array()) {
        result.push_back(static_cast<float>(element.as_number()));
    }
    return result;
}
` : ""}

std::vector<double> double_array(const ts::JsonValue* value) {
    if (!value) return {};
    std::vector<double> result;
    for (const ts::JsonValue& element : value->as_array()) {
        result.push_back(element.as_number());
    }
    return result;
}

${lowered.animationNodeRest}

${chainsSceneSetup ? `
/**
 * Appends one feature's scene wiring to the container's.
 *
 * Upstream every loader feature contributes its own _sceneSetup and
 * addToScene runs them; this port keeps one slot and chains, so the rule
 * -- earlier contributors run first, and an empty slot is not called -- is
 * spelled once rather than per feature.
 *
 * Emitted with its callers: a document with neither contributor chains
 * nothing, and an unused static function is an error under -Werror.
 */
void chain_scene_setup(
    AssetRecord& asset,
    std::function<void(Scene&)> next) {
    asset.scene_setup =
        [previous = std::move(asset.scene_setup),
         next = std::move(next)](Scene& scene) {
        if (previous) previous(scene);
        next(scene);
    };
}
` : ""}

struct BufferViewInfo {
    std::size_t offset = 0;
    std::size_t length = 0;
    std::size_t stride = 0;
};

struct AccessorInfo {
    std::size_t buffer_view = std::numeric_limits<std::size_t>::max();
    std::size_t offset = 0;
    std::size_t count = 0;
    std::uint32_t component_type = 0;
    std::string type;
    bool normalized = false;
};

using Matrix = std::array<float, 16>;

// The pin's own sampler interpolation (src/animation/types.ts:
// INTERP_LINEAR, INTERP_STEP, INTERP_CUBICSPLINE), which is what
// evaluateSampler branches on.
enum class TrackInterpolation : std::uint8_t {
    linear,
    step,
    cubic,
};

struct RotationTrack {
    std::size_t clip = 0;
    std::size_t node = 0;
    TrackInterpolation interpolation = TrackInterpolation::linear;
    std::vector<float> times;
    std::vector<Vec4> values;
    std::vector<Vec4> in_tangents;
    std::vector<Vec4> out_tangents;
};

struct TranslationTrack {
    std::size_t clip = 0;
    std::size_t node = 0;
    TrackInterpolation interpolation = TrackInterpolation::linear;
    std::vector<float> times;
    std::vector<Vec3> values;
    std::vector<Vec3> in_tangents;
    std::vector<Vec3> out_tangents;
};

struct WeightTrack {
    std::size_t clip = 0;
    std::size_t node = 0;
    TrackInterpolation interpolation = TrackInterpolation::linear;
    std::size_t target_count = 0;
    std::vector<float> times;
    std::vector<float> values;
};${gltfCameras ? `

// An imported glTF camera on a reachable node: the pinned feature parents
// its fixup TransformNode to that node, so the camera's parent world
// follows the animated pose. The lanes are the fixup diagonal, resolved
// once at load from the node's rest scale.
struct AnimatedCameraBinding {
    CameraHandle camera{};
    std::size_t node = 0;
    Matrix local{};
};` : ""}${animationPointer ? `

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
    occlusion,
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
    anisotropy,
    translucency_color,
    translucency_intensity,
    metallic_reflectance,
    reflectance,
};

enum class TextureTransformResolution {
    resolved,
    ignored,
    unsupported,
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
// so does this. The extension slots mirror resolveExtTexture. Occlusion uses
// its independent texture when the loader built one, otherwise the ORM slot.
TextureTransformResolution material_transform_slot(
    const std::string& path,
    TextureTransformSlot& slot) {
    if (path == "/pbrMetallicRoughness/metallicRoughnessTexture") {
        return TextureTransformResolution::ignored;
    } else if (path == "/pbrMetallicRoughness/baseColorTexture") {
        slot = TextureTransformSlot::base_color;
    } else if (path == "/emissiveTexture") {
        slot = TextureTransformSlot::emissive;
    } else if (path == "/normalTexture") {
        slot = TextureTransformSlot::normal;
    } else if (path == "/occlusionTexture") {
        slot = TextureTransformSlot::occlusion;
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
    } else if (path == "/extensions/KHR_materials_anisotropy/anisotropyTexture") {
        slot = TextureTransformSlot::anisotropy;
    } else if (path == "/extensions/KHR_materials_diffuse_transmission/diffuseTransmissionColorTexture") {
        slot = TextureTransformSlot::translucency_color;
    } else if (path == "/extensions/KHR_materials_diffuse_transmission/diffuseTransmissionTexture") {
        slot = TextureTransformSlot::translucency_intensity;
    } else if (path == "/extensions/KHR_materials_specular/specularTexture") {
        slot = TextureTransformSlot::metallic_reflectance;
    } else if (path == "/extensions/KHR_materials_specular/specularColorTexture") {
        slot = TextureTransformSlot::reflectance;
    } else {
        return TextureTransformResolution::unsupported;
    }
    return TextureTransformResolution::resolved;
}

TextureTransform& material_transform(
    MaterialRecord& material,
    TextureTransformSlot slot) {
    switch (slot) {
        case TextureTransformSlot::base_color:
            return material.base_color_transform;
        case TextureTransformSlot::occlusion:
            return material.has_occlusion_transform
                ? material.occlusion_transform : material.orm_transform;
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
        case TextureTransformSlot::anisotropy:
            return material.anisotropy_transform;
        case TextureTransformSlot::translucency_color:
            return material.translucency_color_transform;
        case TextureTransformSlot::translucency_intensity:
            return material.translucency_intensity_transform;
        case TextureTransformSlot::metallic_reflectance:
            return material.metallic_reflectance_transform;
        case TextureTransformSlot::reflectance:
            return material.reflectance_transform;
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
    std::optional<std::vector<float>> weights;${animationBlending || animationMask || boneControl ? `
    // The rest pose the authored TRS is: the mixer resets to it each tick
    // before a clip accumulates, a masked node holds it, and the
    // bone-control bake starts from it — the pin's own \`resetTRS\`, which
    // is why its working pose is the file's rather than the last frame's.
    Vec3 rest_translation{};
    Vec4 rest_rotation{0.0f, 0.0f, 0.0f, 1.0f};
    Vec3 rest_scale{1.0f, 1.0f, 1.0f};` : ""}${animationBlending ? `
    // The partial-weight rotation slerp blends against that rest
    // rotation, which is what upstream's uploadTarget does when a node's
    // weights sum below one.
    float translation_weight = 0.0f;
    float rotation_weight = 0.0f;
    float scale_weight = 0.0f;` : ""}
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
    std::vector<float> morph_default_weights;
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
    // AnimationGroup.loopAnimation, which both advances read; the pinned
    // group default is true.
    bool loop = true;
${animationSpeedRatio ? `
    // AnimationGroup.speedRatio, at the pinned group default. The manager
    // advance scales its own delta by it; the scene's master-clock fan-out
    // scales the elapsed span since the ratio was written, which is the
    // same accumulation for a ratio that does not move.
    float speed_ratio = 1.0f;
    // Where the scene's master clock was when the ratio last changed, and
    // the clip time it stood at -- so a write moves the future and never
    // the past, exactly as the pin's own time += dt * speedRatio does.
    float speed_origin = 0.0f;
    float speed_base = 0.0f;` : ""}${animationMask ? `
    // The pin's resolveAnimationMask output: one skip flag per node, and
    // whether a mask is attached at all. A masked node's channels are
    // skipped, so it keeps the rest-pose TRS the tick reset it to.
    std::vector<std::uint8_t> masked_nodes;
    // The same set as an index list, because the pose pass restores only
    // the masked nodes and would otherwise rescan every node each frame.
    std::vector<std::uint32_t> masked_node_indices;
    bool mask_active = false;` : ""}${animationAdditive ? `
    // group._additive (src/animation/weighted-gltf-mixer.ts): set by
    // setAnimationAdditive through the writer below, read by the
    // weighted pass — an additive clip contributes each channel's
    // difference from its reference-time sample instead of joining the
    // weighted base sums.
    bool additive = false;
    float additive_reference_time = 0.0f;` : ""}
};
${animationBlending ? `
// The clip loop below appends the transform tracks clip by clip in
// ascending order, so each clip's tracks are one contiguous run of the
// vectors. [first, last) per channel, recorded beside the vectors so
// the weighted mixer walks only the clip's own run instead of
// rejecting every other clip's tracks by track.clip once per blended
// clip -- the walk keeps that test, so correctness never depends on
// this grouping.
struct TrackRange {
    std::size_t first = 0;
    std::size_t last = 0;
};

struct ClipTrackRanges {
    TrackRange rotation;
    TrackRange translation;
    TrackRange scale;
};
` : ""}
struct AnimationRuntime {
    float time = 0.0f;
    bool paused = false;${animationMask ? `
    // The glTF node names, in document order -- what an AnimationGroupMask
    // matches its target names against (parseAnimationData's nodeNames).
    std::vector<std::string> node_names;` : ""}
    std::vector<AnimationClip> clips;
    std::vector<RotationTrack> rotation_tracks;
    std::vector<TranslationTrack> translation_tracks;
    std::vector<TranslationTrack> scale_tracks;${animationBlending ? `
    // One entry per clip, indexed like clips.
    std::vector<ClipTrackRanges> clip_track_ranges;` : ""}
    std::vector<WeightTrack> weight_tracks;${animationPointer ? `
    std::vector<VisibilityTrack> visibility_tracks;
    std::vector<LightTrack> light_tracks;
    std::vector<AnimatedLightBinding> light_nodes;` : ""}${animationPointerMaterials ? `
    std::vector<MaterialTrack> material_tracks;` : ""}${gltfCameras ? `
    std::vector<AnimatedCameraBinding> camera_nodes;` : ""}
    std::vector<std::vector<std::uint32_t>> node_meshes;
    std::vector<AnimatedNode> nodes;
    std::vector<SkinRuntime> skins;
    std::vector<AnimatedMeshBinding> meshes;
};

${lowered.accessorShape}

template <typename T>
T read_value(const std::uint8_t* data) {
    T value{};
    std::memcpy(&value, data, sizeof(T));
    return value;
}

${lowered.accessorNormalization}

const std::uint8_t* accessor_component_address(
    const ts::ArrayBuffer& buffer,
    const upstream::ParsedGlbContainer& container,
    const std::vector<BufferViewInfo>& views,
    const AccessorInfo& accessor,
    std::size_t element,
    std::size_t component) {
    const std::size_t component_bytes =
        component_size(accessor.component_type);
    const std::size_t components =
        component_count(accessor.type);
    if (element >= accessor.count || component >= components) {
        throw std::runtime_error(
            "glTF accessor element or component is out of range.");
    }
    if (accessor.buffer_view == std::numeric_limits<std::size_t>::max()) return nullptr;
    const BufferViewInfo& view = views.at(accessor.buffer_view);
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
    if (container.bin_offset > buffer.byte_length() || container.bin_length > buffer.byte_length() - container.bin_offset ||
        view.offset > container.bin_length || view.length > container.bin_length - view.offset) {
        throw std::runtime_error("glTF bufferView exceeds its buffer.");
    }
    return buffer.data() + container.bin_offset + view.offset + accessor.offset + element_offset + component_offset;
}

double read_accessor_component(
    const ts::ArrayBuffer& buffer,
    const upstream::ParsedGlbContainer& container,
    const std::vector<BufferViewInfo>& views,
    const AccessorInfo& accessor,
    std::size_t element,
    std::size_t component,
    bool normalized) {
    const auto* data = accessor_component_address(buffer, container, views, accessor, element, component);
    if (!data) return 0.0;
    return accessor.component_type == 5125
        ? static_cast<double>(read_value<std::uint32_t>(data))
        : read_quantized_component(data, 0, accessor.component_type, normalized);
}

float read_component(
    const ts::ArrayBuffer& buffer,
    const upstream::ParsedGlbContainer& container,
    const std::vector<BufferViewInfo>& views,
    const AccessorInfo& accessor,
    std::size_t element,
    std::size_t component) {
    return static_cast<float>(read_accessor_component(buffer, container, views, accessor, element, component, accessor.normalized));
}

std::uint32_t read_index(
    const ts::ArrayBuffer& buffer,
    const upstream::ParsedGlbContainer& container,
    const std::vector<BufferViewInfo>& views,
    const AccessorInfo& accessor,
    std::size_t element) {
    return js::to_uint32(read_accessor_component(buffer, container, views, accessor, element, 0, false));
}

struct GltfAccessorView {
    const ts::ArrayBuffer& buffer;
    const upstream::ParsedGlbContainer& container;
    const std::vector<BufferViewInfo>& views;
    const AccessorInfo& accessor;
    double operator[](std::size_t index) const {
        const auto components = component_count(accessor.type);
        return read_accessor_component(buffer, container, views, accessor, index / components, index % components, false);
    }
};

std::vector<float> gltf_skin_float32_view(const GltfAccessorView& view, double length) {
    const auto count = gltf_checked_index(length);
    const auto& accessor = view.accessor;
    if (accessor.type != "MAT4" || accessor.component_type != 5126 || accessor.normalized ||
        accessor.count > std::numeric_limits<std::size_t>::max() / 16 || count > accessor.count * 16 ||
        (accessor.buffer_view != std::numeric_limits<std::size_t>::max() &&
            view.views.at(accessor.buffer_view).stride != 0 && view.views.at(accessor.buffer_view).stride != 64)) {
        throw std::runtime_error("glTF skin requires a contiguous FLOAT MAT4 accessor view.");
    }
    std::vector<float> result(count);
    for (std::size_t index = 0; index < count; ++index) result[index] = static_cast<float>(view[index]);
    return result;
}

${lowered.inverseBindMatrices}

${animationPointer ? `// Animated light refresh keeps zero forward vectors unchanged. Initial light
// matrices come from the source constructors; vertex normals use
// upstream::normalize_baked_direction.
Vec3 normalize(Vec3 value) {
    const double length = js::or_number(
        js::hypot_js({value.x, value.y, value.z}), 1.0);
    return Vec3{
        static_cast<float>(value.x / length),
        static_cast<float>(value.y / length),
        static_cast<float>(value.z / length),
    };
}
` : ""}
${lowered.animationInterpolation}

/**
 * One transform track sampled at a clip time: the keyframe pair around
 * it and the interpolation evaluateSampler performs
 * (src/animation/evaluate.ts), CUBICSPLINE included. Both the direct
 * per-clip pass and the weighted mixer read a channel through these.
 */
std::size_t track_key_at(
    const std::vector<float>& times,
    float time) {
    // The first key at or after the time, never index 0, clamped to the
    // last. Binary rather than linear because glTF requires a sampler's
    // input times to be strictly increasing, so the two agree exactly --
    // and because a VAT bake walks every frame of every clip through
    // every channel, which made this the bake's dominant cost at tens of
    // millions of comparisons for one shark.
    std::size_t right = static_cast<std::size_t>(
        std::lower_bound(times.begin() + 1, times.end(), time) -
        times.begin());
    if (right >= times.size()) {
        right = times.size() - 1;
    }
    return right;
}

double track_amount_at(
    const std::vector<float>& times,
    std::size_t left,
    std::size_t right,
    float time) {
    const double span =
        static_cast<double>(times[right]) - times[left];
    return span > 0.0
        ? std::clamp(
              (static_cast<double>(time) - times[left]) /
                  span,
              0.0,
              1.0)
        : 0.0;
}

// evaluateSampler's STEP branch: the later key once the time reaches its
// own, the earlier one inside the span. track_key_at returns the first key at
// or after the time (clamped, never zero), so its own pair is exactly the two
// the pin's (t >= t1 ? idx + 1 : idx) chooses between.
${animationMask ? `// animationGroupMaskRetainsTarget, resolved per node at the write and
// read here per channel: a masked node keeps the rest-pose TRS the tick
// reset it to, which is what upstream's own \`continue\` leaves behind.
bool clip_masks_node(
    const AnimationClip& clip,
    std::size_t node) {
    return clip.mask_active &&
        node < clip.masked_nodes.size() &&
        clip.masked_nodes[node] != 0;
}

` : ""}std::size_t track_step_key_at(
    const std::vector<float>& times,
    std::size_t left,
    std::size_t right,
    float time) {
    return times[right] <= time ? right : left;
}

Vec4 sample_rotation_track(
    const RotationTrack& track,
    float time) {
    const std::size_t right = track_key_at(track.times, time);
    const std::size_t left = right > 0 ? right - 1 : 0;
    if (track.interpolation == TrackInterpolation::step) {
        return track.values[
            track_step_key_at(track.times, left, right, time)];
    }
    const double span =
        static_cast<double>(track.times[right]) -
        track.times[left];
    const double amount =
        track_amount_at(track.times, left, right, time);
    return track.interpolation == TrackInterpolation::cubic
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

Vec3 sample_vec3_track(
    const TranslationTrack& track,
    float time) {
    const std::size_t right = track_key_at(track.times, time);
    const std::size_t left = right > 0 ? right - 1 : 0;
    if (track.interpolation == TrackInterpolation::step) {
        return track.values[
            track_step_key_at(track.times, left, right, time)];
    }
    const double span =
        static_cast<double>(track.times[right]) -
        track.times[left];
    const double amount =
        track_amount_at(track.times, left, right, time);
    const Vec3 left_value = track.values[left];
    const Vec3 right_value = track.values[right];
    return track.interpolation == TrackInterpolation::cubic
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
                  (static_cast<double>(right_value.x) -
                   left_value.x) *
                      amount),
              static_cast<float>(
                  left_value.y +
                  (static_cast<double>(right_value.y) -
                   left_value.y) *
                      amount),
              static_cast<float>(
                  left_value.z +
                  (static_cast<double>(right_value.z) -
                   left_value.z) *
                      amount),
          };
}

Matrix identity_matrix() {
    Matrix result{};
    result[0] = result[5] = result[10] = result[15] = 1.0f;
    return result;
}

${gltfCameras ? lowered.gltfCameraParentWriter : ""}

${lowered.matrixLocal}

${lowered.matrixCompose}

${lowered.matrixNative}

${lowered.hierarchy}

// The raw world multiplies live in the always-emitted
// upstream::transform_position/transform_direction pair; these wrappers add
// only the loader's RH->LH x-negation.
Vec3 transform_point(const Matrix& matrix, Vec3 value) {
    const Vec3 transformed = upstream::transform_position(matrix, value);
    return Vec3{-transformed.x, transformed.y, transformed.z};
}

// Babylon Lite normalizes the object-space direction (pbr-template.ts:
// \`finalWorld * vec4<f32>(normalize(normal), 0.0)\`) and interpolates the
// transformed vector unnormalized; only the fragment renormalizes.
Vec3 transform_direction(const Matrix& matrix, Vec3 value) {
    const Vec3 transformed = upstream::transform_direction(
        matrix, upstream::normalize_baked_direction(value));
    return Vec3{-transformed.x, transformed.y, transformed.z};
}

${materialVariants ? `
// src/loader-gltf/material-variants.ts#selectVariant composed with
// gltf-feature-variants.ts's mapping walk: the selection restores every
// original material and then applies the entries the chosen variant maps, so
// a primitive that variant does not map keeps its own material. The chosen
// name is the scene's; the variant order and the mappings are the
// document's.
std::size_t variant_material_slot(const JsonObject& document, std::size_t mesh_index, std::size_t original) {
    const auto* plan = optional(document, "${GLTF_VARIANT_PLAN}");
    if (!plan) return original;
    const auto& selections = required(plan->as_object(), "selections").as_object();
    const auto* selected = optional(selections, ${selectedVariantLiteral});
    if (!selected) return original;
    const auto& slots = selected->as_array();
    if (mesh_index >= slots.size()) throw std::runtime_error("Invalid glTF variant mesh slot.");
    return unsigned_value(slots.at(mesh_index));
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
        string_or(image, "mimeType");${compressedImages ? `
    // The pin's transcoded blocks and parsed mip list, packaged together.
    // KTX2 invertY is a texture-object property, not an upload flip.
    if (mime_type == "${compressedTextureFormat.mimeType}") {
        result.compressed = upstream::read_compressed_texture(
            std::vector<std::uint8_t>(
                buffer.bytes().begin() + start,
                buffer.bytes().begin() + end));
        result.uv_invert_y = true;
        return result;
    }` : ""}
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

${factorBake}

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

${lowered.materialAssembly}
${lowered.materialTextures}

${lowered.materialProperties}
${lowered.animationClips}
${gltfMaterialProjection(animationPointerMaterials)}

} // namespace

${gltfCameras ? `AssetHandle load_gltf(Engine& engine, const std::string& path) {
    return load_gltf(engine, path, false);
}

` : ""}AssetHandle load_gltf(Engine& engine, const std::string& path${gltfCameras ? ", bool load_cameras" : ""}) {
    ts::ArrayBuffer buffer = ts::await(pal::fetch_array_buffer(path));
    const upstream::ParsedGlbContainer container = upstream::parse_glb_container(buffer);
    const JsonObject& document = container.json.as_object();
    const auto material_features = gltf_pbr_material_features(GltfPbrValue{&container.json});
    const bool material_texture_wrap = gltf_pbr_has_texture_wrap(GltfPbrValue{&container.json});
    const bool extended_material = gltf_pbr_needs_extended(GltfPbrValue{&container.json}, GltfPbrValue{material_texture_wrap}, GltfPbrValue{false}).truthy();
    const bool sampled_material = gltf_pbr_needs_sampler(GltfPbrValue{&container.json}).truthy();
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
        // Packaging resolves every sparse accessor through the pin's own
        // preParse hook, so a packaged document carries none. This is the
        // BBLITE_ASSET_DIR defense: an unpackaged asset would otherwise read
        // its unpatched base values here, exactly as the pinned
        // resolveAccessor would without the hook.
        if (optional(object, "sparse")) {
            throw std::runtime_error(
                "glTF accessor is sparse; this asset was not packaged by "
                "bblitec, which resolves sparse accessors at generation.");
        }
        const std::size_t buffer_view =
            unsigned_or(object, "bufferView", std::numeric_limits<std::size_t>::max());
        if (buffer_view != std::numeric_limits<std::size_t>::max() && buffer_view >= views.size()) {
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
    const auto& mesh_plan = required(document, "${GLTF_MESH_PLAN}").as_object();
    const auto& planned_materials = required(mesh_plan, "materials").as_array();
    const auto& planned_meshes = required(mesh_plan, "meshes").as_array();
    const auto& planned_geometries = required(mesh_plan, "geometries").as_array();
    std::vector<MaterialHandle> materials;
    materials.reserve(planned_materials.size());
${animationPointerMaterials || interactivity ? `    std::vector<MaterialHandle> source_materials(material_json.size());` : ""}
    GltfMaterialImageCache material_image_cache;
    GltfTextureCache material_texture_cache;
    GltfSamplerContext material_sampler_context(texture_json, sampler_json);
    const auto resolve_material_image = [&](std::size_t index) -> GltfMaterialImage {
        if (index >= image_json.size()) throw std::runtime_error("Invalid glTF material image index.");
        return std::make_shared<GltfMaterialImageSource>(GltfMaterialImageSource{index});
    };
    const auto extension_image_fetcher = make_gltf_extension_image_fetcher(document, double(material_features.size()), resolve_material_image);
${sourceTextureReads ? `
    // Association IDs come from the pin's image cache and Texture2D wrappers
    // at packaging. Each load allocates fresh public producer identities.
    const auto& source_albedo = required(document, "${GLTF_SOURCE_ALBEDO_IDENTITIES}").as_object();
    const auto& source_associations = required(source_albedo, "materials").as_array();
    const auto& source_fallbacks = required(source_albedo, "fallbackTexels").as_object();
    if (source_associations.size() != material_json.size() + 1) {
        throw std::runtime_error("Invalid glTF albedo association count.");
    }
    std::unordered_map<std::size_t, std::uint64_t> source_texture_identities;
    const auto retain_source_albedo = [&](MaterialHandle handle, std::size_t material_index) {
        const auto association = unsigned_value(source_associations.at(material_index));
        auto [identity, inserted] = source_texture_identities.try_emplace(association, 0);
        if (inserted) identity->second = engine.next_file_texture_identity++;
        auto texture = material_texture(engine, handle, MaterialTextureSlot::base_color);
        texture.identity = identity->second;
        if (const auto* fallback = optional(source_fallbacks, std::to_string(association))) {
            const auto& lanes = fallback->as_array();
            if (lanes.size() != 4) throw std::runtime_error("Invalid glTF albedo fallback texel.");
            std::vector<std::uint8_t> texel(4);
            for (std::size_t lane = 0; lane < texel.size(); ++lane) {
                const auto byte = unsigned_value(lanes[lane]);
                if (byte > 255) throw std::runtime_error("Invalid glTF albedo fallback byte.");
                texel[lane] = static_cast<std::uint8_t>(byte);
            }
            texture.data.bytes = std::move(texel);
            texture.width = texture.data.rgba_width = 1;
            texture.height = texture.data.rgba_height = 1;
        }
        engine.materials.at(handle.value).source_albedo_texture = std::move(texture);
    };` : ""}
    const std::vector<bool> animated_base_color =
        collect_animated_base_color(document, material_json.size());
    const auto decode_material_image = [](const TextureData& texture) {
        if (!texture.compressed.mips.empty()) throw std::runtime_error("Canvas2D composition of compressed glTF images is unsupported.");
        return pal::decode_image(js::ArrayBuffer(texture.bytes));
    };
    std::vector<GltfCoreMaterial> core_materials;
    for (const auto& source : required(mesh_plan, "cores").as_array()) {
        const auto selected = source.as_number();
        const auto source_index = selected == -1.0 ? std::numeric_limits<std::size_t>::max() : gltf_checked_index(selected);
        if (selected != -1.0 && source_index >= material_json.size()) throw std::runtime_error("Invalid glTF core material source.");
        core_materials.push_back(assemble_gltf_material(document, source_index, material_image_cache, resolve_material_image));
    }
    for (const auto& core_index : planned_materials) {
            const auto& material = core_materials.at(unsigned_value(core_index));
            const auto source_material_index = material._rawMatDef ? static_cast<std::size_t>(material._rawMatDef - material_json.data()) : material_json.size();
            const auto handle = load_material(engine, gltf_material_object(material._rawMatDef), material, buffer, container, views,
                image_json, texture_json, sampler_json, extension_image_fetcher,
                source_material_index < animated_base_color.size() && animated_base_color[source_material_index],
                material_features, extended_material, material_texture_wrap, sampled_material, &material_texture_cache, &material_sampler_context,
                decode_material_image);
${sourceTextureReads ? `            retain_source_albedo(handle, source_material_index);` : ""}
            materials.push_back(handle);
    }
${animationPointerMaterials || interactivity ? `    // Pointer and interactivity indices refer to original glTF definitions.
    for (const auto& entry : planned_meshes) {
        const auto& planned = entry.as_object();
        const auto& node = node_json.at(unsigned_value(required(planned, "node"))).as_object();
        const auto& mesh = mesh_json.at(unsigned_value(required(node, "mesh"))).as_object();
        const auto& primitive = required(mesh, "primitives").as_array().at(unsigned_value(required(planned, "primitive"))).as_object();
        if (const auto* source = optional(primitive, "material"))
            source_materials.at(unsigned_value(*source)) = materials.at(unsigned_value(required(planned, "material")));
    }` : ""}
    const auto* variant_plan_value = optional(document, "${GLTF_VARIANT_PLAN}");
    const auto* variant_names = gltf_json_path(document, {"extensions", "KHR_materials_variants", "variants"});
    if (variant_names && !variant_names->as_array().empty() && !variant_plan_value)
        throw std::runtime_error("Material variants require packaged source scheduling metadata.");
    if (variant_plan_value) {
        const auto& plan = variant_plan_value->as_object();
        const auto base_count = unsigned_value(required(plan, "baseCount"));
        if (base_count != materials.size()) throw std::runtime_error("Invalid glTF variant base material count.");
        GltfMaterialImageCache variant_image_cache;
        GltfSamplerContext variant_sampler_context(std::make_shared<const TextureSamplerState>(gltf_variant_sampler_state()));
        const auto variant_fetcher = make_gltf_variant_image_fetcher(document, variant_image_cache, resolve_material_image);
        for (const auto& source : required(plan, "materials").as_array()) {
            const auto index = unsigned_value(source);
            if (index >= material_json.size()) throw std::runtime_error("Invalid glTF variant material index.");
            const auto core = assemble_gltf_material(document, index, variant_image_cache, resolve_material_image);
            materials.push_back(load_material(engine, material_json.at(index).as_object(), core, buffer, container, views,
                image_json, texture_json, sampler_json, variant_fetcher, false, material_features,
                true, material_texture_wrap, false, nullptr, &variant_sampler_context,
                decode_material_image, true));
        }
    }

    const auto parents = build_gltf_parents(document);
    validate_gltf_parents(parents);

    AssetRecord asset;${interactivity ? `
    // KHR_interactivity's node-to-meshes table, filled by the mesh walk
    // below; the rest of the asset's tables join it once the document is
    // loaded (see the scene-setup chain).
    asset.node_meshes.resize(node_json.size());` : ""}
${lowered.iblLoading}${assetTransmission ? `
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
            chain_scene_setup(asset, [](Scene& scene) {
                enable_scene_transmission(scene);
            });
        }
    }` : ""}${gaussianSplats ? `
    // KHR_gaussian_splatting: packaging ran the pin's own preParse and
    // applyAsset over this document (compressed-geometry.ts), so what is left
    // of the extension is the 32-byte-per-splat row buffer each GS primitive
    // converted to, appended as an ordinary bufferView. Building the cloud is
    // the engine half of the pin's attachParsedSplat; registering it on a
    // scene is the scene half, which the container's own scene hook performs
    // -- exactly where the pinned feature's _sceneSetup performs it.
    if (const ts::JsonValue* gaussian_splat_value =
            optional(document, "${GAUSSIAN_SPLAT_DOCUMENT_KEY}")) {
        for (const ts::JsonValue& entry_value :
                gaussian_splat_value->as_array()) {
            const JsonObject& entry = entry_value.as_object();
            const BufferViewInfo& view =
                views.at(unsigned_value(required(entry, "bufferView")));
            const std::uint8_t* rows =
                buffer.data() + container.bin_offset + view.offset;
            const SplatMeshHandle splat = create_gaussian_splatting_mesh(
                engine,
                string_or(entry, "name"),
                std::vector<std::uint8_t>(rows, rows + view.length));
            // The TRS the pinned scene wiring writes on the cloud it just
            // attached, observed at generation rather than restated: the glTF
            // splat convention and the .ply one differ by a half turn about
            // Z, and the pin corrects it on the node rather than in the rows.
            const std::vector<float> rotation =
                float_array(optional(entry, "rotation"));
            if (rotation.size() == 3u) {
                engine.splat_meshes[splat.value].rotation =
                    Vec3{rotation[0], rotation[1], rotation[2]};
            }
            asset.gaussian_splats.push_back(splat);
        }
        chain_scene_setup(
            asset,
            [attached = asset.gaussian_splats](Scene& scene) {
            for (const SplatMeshHandle splat : attached) {
                attach_gaussian_splatting_mesh(scene, splat);
            }
        });
    }` : ""}
    const auto read_matrix = [&](const AccessorInfo& value, std::size_t index) {
        Matrix matrix{};
        for (std::size_t lane = 0; lane < matrix.size(); ++lane)
            matrix[lane] = read_component(buffer, container, views, value, index * 4 + lane / 4, lane % 4);
        return matrix;
    };
${animationPointer ? `    std::vector<AnimatedLightBinding> light_node_bindings;
` : ""}${gltfCameras ? `    std::vector<AnimatedCameraBinding> camera_node_bindings;
` : ""}    std::vector<LightHandle> loaded_lights;
    for (const auto& entry : required(mesh_plan, "lights").as_array()) {
        const auto& prepared = entry.as_object();
        LightRecord light;
        const auto& type = required(prepared, "kind").as_string();
        if (type == "point") light.kind = LightKind::point;
        else if (type == "directional") light.kind = LightKind::directional;
        else if (type == "spot") light.kind = LightKind::spot;
        else throw std::runtime_error("Unsupported prepared glTF light kind.");
        const auto& world = accessors.at(unsigned_value(required(prepared, "world")));
        if (world.type != "VEC4" || world.component_type != 5126 || world.count != 4)
            throw std::runtime_error("Invalid glTF light world storage.");
        const auto matrix = read_matrix(world, 0);
        light.position = Vec3{matrix[12], matrix[13], matrix[14]};
        light.direction = Vec3{matrix[8], matrix[9], matrix[10]};
        const auto color = [&](const char* name) {
            const auto& values = required(prepared, name).as_array();
            if (values.size() != 3) throw std::runtime_error("Invalid glTF light color.");
            return Color3{static_cast<float>(values[0].as_number()), static_cast<float>(values[1].as_number()), static_cast<float>(values[2].as_number())};
        };
        light.diffuse_color = color("diffuse");
        light.specular_color = color("specular");
        light.intensity = static_cast<float>(required(prepared, "intensity").as_number());
        if (const auto* range = optional(prepared, "range"))
            light.range = static_cast<float>(std::min(range->as_number(), static_cast<double>(std::numeric_limits<float>::max())));
        if (light.kind == LightKind::spot) {
            const auto& spot = required(prepared, "spot").as_object();
            light.angle = required(spot, "angle").as_number();
            light.cos_half_angle = static_cast<float>(required(spot, "cosine").as_number());
            light.exponent = static_cast<float>(required(spot, "exponent").as_number());
        }
        const LightHandle handle{static_cast<std::uint32_t>(engine.lights.size())};
        engine.lights.push_back(light);
        loaded_lights.push_back(handle);${animationPointer ? `
        const auto& node = required(prepared, "node");
        if (!node.is_null()) light_node_bindings.push_back(AnimatedLightBinding{handle, unsigned_value(node)});` : ""}
    }
    for (const auto& index : required(mesh_plan, "sceneLights").as_array())
        asset.lights.push_back(loaded_lights.at(unsigned_value(index)));
${animationPointer ? `    std::vector<LightHandle> punctual_lights;
    for (const auto& index : required(mesh_plan, "lightTargets").as_array())
        punctual_lights.push_back(index.is_null() ? LightHandle{} : loaded_lights.at(unsigned_value(index)));
` : ""}
${gltfCameras ? `${lowered.gltfCameraLoading}
` : ""}    const auto animation_runtime =
        std::make_shared<AnimationRuntime>();
${animationPointer ? `    animation_runtime->light_nodes =
        std::move(light_node_bindings);
` : ""}${gltfCameras ? `    animation_runtime->camera_nodes =
        std::move(camera_node_bindings);
` : ""}    animation_runtime->node_meshes.resize(node_json.size());
    {
    const auto node_rest = gltf_animation_node_rest(document,
        [&](double index) { gltf_checked_index(index); return find_gltf_parent(parents, index); });
    animation_runtime->nodes.resize(node_rest.size());
    for (std::size_t index = 0; index < node_rest.size(); ++index) {
        const auto& rest = node_rest[index];
        AnimatedNode& animated_node =
            animation_runtime->nodes[index];
        if (!std::isfinite(rest.parentIdx) || std::floor(rest.parentIdx) != rest.parentIdx || rest.parentIdx < -1 ||
            rest.parentIdx > static_cast<double>(std::numeric_limits<int>::max()))
            throw std::runtime_error("glTF animation parent index is not representable.");
        animated_node.parent = static_cast<int>(rest.parentIdx);
        if (rest.matrix && !rest.matrix->is_null()) {
            animated_node.has_matrix = true;
            animated_node.matrix = gltf_matrix_from_json(rest.matrix);
        }
        animated_node.translation = Vec3{static_cast<float>(rest.tx), static_cast<float>(rest.ty), static_cast<float>(rest.tz)};
        animated_node.rotation = Vec4{static_cast<float>(rest.rx), static_cast<float>(rest.ry), static_cast<float>(rest.rz), static_cast<float>(rest.rw)};
        animated_node.scale = Vec3{static_cast<float>(rest.sx), static_cast<float>(rest.sy), static_cast<float>(rest.sz)};
${animationBlending || animationMask || boneControl ? `
        // The node's authored TRS is the rest pose the weighted mixer
        // resets to each tick before any clip accumulates into it, and the
        // pose a masked node holds: the pin's controller resets every node
        // to it before walking a clip's channels, so skipping a masked
        // channel leaves exactly this.
        animated_node.rest_translation = animated_node.translation;
        animated_node.rest_rotation = animated_node.rotation;
        animated_node.rest_scale = animated_node.scale;` : ""}
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
        const auto inverse_bind = gltf_inverse_bind_matrices(skin,
            [&](double index) { return GltfAccessorView{buffer, container, views, accessors.at(gltf_checked_index(index))}; },
            gltf_skin_float32_view);
        if (inverse_bind.size() != runtime_skin.joints.size() * 16)
            throw std::runtime_error("glTF skin matrix storage does not match its joints.");
        runtime_skin.inverse_bind_matrices.resize(runtime_skin.joints.size());
        for (std::size_t index = 0; index < inverse_bind.size(); ++index) {
            runtime_skin.inverse_bind_matrices[index / 16][index % 16] = inverse_bind[index];
        }
        animation_runtime->skins.push_back(
            std::move(runtime_skin));
    }
    for (std::size_t gltf_mesh_counter = 0; gltf_mesh_counter < planned_meshes.size(); ++gltf_mesh_counter) {
            const auto& planned = planned_meshes[gltf_mesh_counter].as_object();
            const auto node_index = unsigned_value(required(planned, "node"));
            const auto& node = node_json.at(node_index).as_object();
            const auto& mesh = mesh_json.at(unsigned_value(required(node, "mesh"))).as_object();
            const auto& setup = required(planned, "setup").as_object();
            const std::string topology = required(setup, "topology").as_string();
            const bool source_clockwise = required(setup, "clockwise").as_boolean();
${nonTrianglePrimitives
            ? `            // Convert the source WebGPU topology to native transport.
            MeshTopology primitive_topology = MeshTopology::triangles;
            if (topology == "point-list") primitive_topology = MeshTopology::points;
            else if (topology == "line-list") primitive_topology = MeshTopology::lines;
            else if (topology == "line-strip") primitive_topology = MeshTopology::line_strip;
            else if (topology != "triangle-list" && topology != "triangle-strip")
                throw std::runtime_error("Unsupported prepared glTF topology.");`
            : `            if (topology != "triangle-list")
                throw std::runtime_error("Only triangle-list glTF primitives are supported.");`}
            const auto& planned_geometry = planned_geometries.at(unsigned_value(required(planned, "geometry"))).as_object();
            const JsonObject& attributes = required(planned_geometry, "attributes").as_object();
            const auto* planned_skin = optional(planned, "skin");
            const auto* planned_morph = optional(planned, "morph");
            if (planned_skin && unsigned_value(required(planned_skin->as_object(), "boneCount")) !=
                animation_runtime->skins.at(unsigned_value(required(planned_skin->as_object(), "index"))).joints.size())
                throw std::runtime_error("glTF skeleton storage disagrees with its joint bindings.");
            const AccessorInfo& positions = accessors.at(unsigned_value(required(attributes, "POSITION")));
            const AccessorInfo* normals = required(planned, "flatNormal").as_boolean()
                ? nullptr : &accessors.at(unsigned_value(required(attributes, "NORMAL")));
            const AccessorInfo* tangents = optional(attributes, "TANGENT")
                ? &accessors.at(unsigned_value(*optional(attributes, "TANGENT")))
                : nullptr;
            const AccessorInfo& texcoords = accessors.at(unsigned_value(required(attributes, "TEXCOORD_0")));
            const AccessorInfo* texcoords1 = optional(attributes, "TEXCOORD_1")
                ? &accessors.at(unsigned_value(*optional(attributes, "TEXCOORD_1")))
                : nullptr;
            const AccessorInfo* colors = optional(attributes, "COLOR_0")
                ? &accessors.at(unsigned_value(*optional(attributes, "COLOR_0")))
                : nullptr;
            const AccessorInfo* joints = planned_skin
                ? &accessors.at(unsigned_value(required(planned_skin->as_object(), "joints"))) : nullptr;
            const AccessorInfo* weights = planned_skin
                ? &accessors.at(unsigned_value(required(planned_skin->as_object(), "weights"))) : nullptr;
            std::vector<const AccessorInfo*> morph_positions;
            std::vector<const AccessorInfo*> morph_normals;
            std::vector<float> morph_default_weights;
            if (planned_morph) {
                const auto& morph = planned_morph->as_object();
                for (const auto& index : required(morph, "positions").as_array())
                    morph_positions.push_back(&accessors.at(unsigned_value(index)));
                for (const auto& index : required(morph, "normals").as_array())
                    morph_normals.push_back(&accessors.at(unsigned_value(index)));
                const auto& initial_weights = accessors.at(unsigned_value(required(morph, "weights")));
                morph_default_weights.resize(initial_weights.count);
                for (std::size_t index = 0; index < initial_weights.count; ++index)
                    morph_default_weights[index] = read_component(buffer, container, views, initial_weights, index, 0);
                if (morph_positions.size() != morph_normals.size() || morph_positions.size() != morph_default_weights.size())
                    throw std::runtime_error("Invalid glTF morph storage counts.");
            }
            const auto setup_accessor = [&](const char* name, const char* type, std::size_t count) -> const AccessorInfo& {
                const auto& value = accessors.at(unsigned_value(required(setup, name)));
                if (value.type != type || value.component_type != 5126 || value.count != count)
                    throw std::runtime_error("Invalid glTF mesh placement storage.");
                return value;
            };
            const auto& source_world = setup_accessor("world", "VEC4", 4);
            Matrix mesh_world = read_matrix(source_world, 0);
            // The source hierarchy includes its RH-to-LH root. Vertex baking
            // applies that mirror separately, so recover the unmirrored world.
            for (std::size_t column = 0; column < 4; ++column) mesh_world[column * 4] = -mesh_world[column * 4];
            const Matrix instance_parent_matrix = native_matrix(mesh_world);
            std::vector<Matrix> instance_matrices;
            if (const auto* instance_value = optional(setup, "instances")) {
                if (animated || planned_skin || planned_morph)
                    throw std::runtime_error("Animated or deformed GPU instances are not supported.");
                const auto& instances = instance_value->as_object();
                const auto count = unsigned_value(required(instances, "count"));
                const auto& matrices = accessors.at(unsigned_value(required(instances, "matrices")));
                if (matrices.type != "VEC4" || matrices.component_type != 5126 || matrices.count != count * 4)
                    throw std::runtime_error("Invalid glTF instance matrix storage.");
                instance_matrices.reserve(count);
                for (std::size_t instance = 0; instance < count; ++instance)
                    instance_matrices.push_back(native_matrix(read_matrix(matrices, instance)));
            }
            ModelGeometry geometry;${nonTrianglePrimitives
            ? `
            geometry.topology = primitive_topology;`
            : ""}
            geometry.vertices.resize(positions.count);
            const bool instanced =
                !instance_matrices.empty();
            const Matrix matrix = instanced
                ? identity_matrix()
                : mesh_world;
            // The pin's own mat4Determinant3, from the shared emission --
            // double, expanded along the same cofactor column as the
            // run-time mirrored-mesh watcher, so the load-time and
            // run-time answers to "is this basis mirrored" round alike.
            const double determinant =
                upstream::pinned_mat4_determinant3(matrix);
            const std::size_t material_index =
                ${materialVariants
                    ? `variant_material_slot(document, gltf_mesh_counter, unsigned_value(required(planned, "material")))`
                    : `unsigned_value(required(planned, "material"))`};
            if (material_index >= materials.size()) throw std::runtime_error("Invalid glTF mesh material slot.");
            const std::string authored_name = string_or(mesh, "name");
            const bool retains_live_wheel_vertices =
                authored_name.rfind("wheel", 0) == 0;
            // A hierarchy pool is attached after a static glTF has already
            // baked this node world into geometry.vertices. Keep the loader's
            // mirrored-local copy so that later thin-instance draws can use
            // the same local attribute bytes the browser retained.
            const bool retains_runtime_instance_vertices =
                ${dynamicThinInstances || meshClones ? "true" : "false"};
            const bool retains_local_vertices =
                retains_live_wheel_vertices ||
                retains_runtime_instance_vertices;
            if (retains_local_vertices) {
                geometry.bind_vertices.resize(positions.count);
            }${retainLocalNormals ? `
            if (normals) {
                geometry.local_normals.resize(positions.count);
            }` : ""}
            const bool clockwise_front_face =
                source_clockwise &&
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
                Vec3 live_local_normal = vertex.normal;
                if (normals) {
                    const Vec3 local_normal{
                        read_component(buffer, container, views, *normals, index, 0),
                        read_component(buffer, container, views, *normals, index, 1),
                        read_component(buffer, container, views, *normals, index, 2),
                    };${retainLocalNormals ? `
                    geometry.local_normals[index] = local_normal;` : ""}
                    // The vertex stage's own normalize (pbr-template.ts
                    // \`normalize(normal)\`), on the lanes the pin uploads.
                    live_local_normal = upstream::normalize_baked_direction(Vec3{
                        -local_normal.x,
                        local_normal.y,
                        local_normal.z,
                    });
                    vertex.normal = animated || instanced
                        ? upstream::normalize_baked_direction(Vec3{
                              -local_normal.x,
                              local_normal.y,
                              local_normal.z,
                          })
                        : transform_direction(matrix, local_normal);
                }
                Vec4 live_local_tangent = vertex.tangent;
                if (tangents) {
                    const Vec3 local_tangent{
                        read_component(buffer, container, views, *tangents, index, 0),
                        read_component(buffer, container, views, *tangents, index, 1),
                        read_component(buffer, container, views, *tangents, index, 2),
                    };
                    const float local_tangent_w =
                        read_component(buffer, container, views, *tangents, index, 3);
                    live_local_tangent = Vec4{
                        -local_tangent.x,
                        local_tangent.y,
                        local_tangent.z,
                        -local_tangent_w,
                    };
                    const Vec3 tangent = animated || instanced
                        ? upstream::normalize_baked_direction(Vec3{
                              -local_tangent.x,
                              local_tangent.y,
                              local_tangent.z,
                          })
                        : transform_direction(matrix, local_tangent);
                    vertex.tangent = Vec4{
                        tangent.x,
                        tangent.y,
                        tangent.z,
                        (determinant < 0.0 ? 1.0f : -1.0f) *
                            local_tangent_w,
                    };
                }
                vertex.uv = Vec2{
                    read_component(buffer, container, views, texcoords, index, 0),
                    read_component(buffer, container, views, texcoords, index, 1),
                };
                if (texcoords1) {
                    vertex.uv2 = Vec2{
                        read_component(buffer, container, views, *texcoords1, index, 0),
                        read_component(buffer, container, views, *texcoords1, index, 1),
                    };
                }
                if (colors) {
                    vertex.color = Vec4{
                        read_component(buffer, container, views, *colors, index, 0),
                        read_component(buffer, container, views, *colors, index, 1),
                        read_component(buffer, container, views, *colors, index, 2),
                        read_component(buffer, container, views, *colors, index, 3),
                    };
                }
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
                geometry.vertices[index] = vertex;
                if (retains_local_vertices) {
                    ModelVertex local_vertex = vertex;
                    local_vertex.position = Vec3{
                        -local_position.x,
                        local_position.y,
                        local_position.z,
                    };
                    local_vertex.normal = live_local_normal;
                    local_vertex.tangent = live_local_tangent;
                    geometry.bind_vertices[index] = local_vertex;
                }
            }
            for (std::size_t target = 0; target < morph_positions.size(); ++target) {
                auto& position_deltas = geometry.morph_positions.emplace_back(positions.count);
                auto& normal_deltas = geometry.morph_normals.emplace_back(positions.count);
                for (std::size_t index = 0; index < positions.count; ++index) {
                    position_deltas[index] = Vec3{
                        read_component(buffer, container, views, *morph_positions[target], index, 0),
                        read_component(buffer, container, views, *morph_positions[target], index, 1),
                        read_component(buffer, container, views, *morph_positions[target], index, 2),
                    };
                    normal_deltas[index] = Vec3{
                        read_component(buffer, container, views, *morph_normals[target], index, 0),
                        read_component(buffer, container, views, *morph_normals[target], index, 1),
                        read_component(buffer, container, views, *morph_normals[target], index, 2),
                    };
                }
            }
            {
                const AccessorInfo& indices = accessors.at(unsigned_value(required(planned_geometry, "indices")));
                geometry.indices.resize(indices.count);
                for (std::size_t index = 0; index < indices.count; ++index) {
                    geometry.indices[index] = read_index(buffer, container, views, indices, index);
                }
            }${nonTrianglePrimitives
            ? `
            if (topology == "triangle-strip") {
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
            if (
                geometry.topology == MeshTopology::triangles &&
                geometry.indices.size() % 3 != 0) {
                throw std::runtime_error("Triangle-list glTF indices must be divisible by three.");
            }
            if (
                geometry.topology == MeshTopology::lines &&
                geometry.indices.size() % 2 != 0) {
                throw std::runtime_error(
                    "Line-list glTF indices must be divisible by two.");
            }
            for (const std::uint32_t index : geometry.indices) {
                if (index >= geometry.vertices.size()) {
                    throw std::runtime_error(
                        "glTF primitive index exceeds its vertex count.");
                }
            }
            // The winding swap and the flat-normal fold below are both
            // triangle facts: a mirrored transform reverses a face's winding,
            // and a face normal is a property of a triangle. A point or a
            // line has neither, and the pin's own flat-normal expression --
            // normalize(cross(dpdx(worldPos), dpdy(worldPos))) -- needs a
            // fragment quad with area to differentiate over, which a
            // one-pixel line and a point do not give it. So a non-triangle
            // primitive with no NORMAL is refused rather than shaded from a
            // derivative both backends would evaluate at zero.
            if (
                geometry.topology != MeshTopology::triangles &&
                !normals) {
                throw std::runtime_error(
                    "A glTF point or line primitive with no NORMAL "
                    "accessor reaches the pinned flat-normal path, whose "
                    "screen-space derivative has no area to read.");
            }
            if (
                geometry.topology == MeshTopology::triangles &&
                source_clockwise &&
                !clockwise_front_face) {
                for (std::size_t index = 0; index < geometry.indices.size(); index += 3) {
                    std::swap(geometry.indices[index + 1], geometry.indices[index + 2]);
                }${retainLocalNormals || meshClones ? `
                geometry.source_indices_reversed = true;` : ""}
            }
            if (!normals) {
                geometry.flat_normals = true;
                std::vector<ModelVertex> flat_vertices;
                flat_vertices.reserve(geometry.indices.size());
                std::vector<ModelVertex> flat_bind_vertices;
                if (!geometry.bind_vertices.empty()) {
                    flat_bind_vertices.reserve(geometry.indices.size());
                }
                std::vector<std::vector<Vec3>> flat_morph_positions(
                    geometry.morph_positions.size());
                std::vector<std::vector<Vec3>> flat_morph_normals(
                    geometry.morph_normals.size());
                for (const std::uint32_t index : geometry.indices) {
                    flat_vertices.push_back(
                        geometry.vertices.at(index));
                    if (!geometry.bind_vertices.empty()) {
                        flat_bind_vertices.push_back(
                            geometry.bind_vertices.at(index));
                    }
                    for (std::size_t target = 0; target < flat_morph_positions.size(); ++target) {
                        flat_morph_positions[target].push_back(
                            geometry.morph_positions[target].at(index));
                        flat_morph_normals[target].push_back(
                            geometry.morph_normals[target].at(index));
                    }
                }
                geometry.vertices = std::move(flat_vertices);
                if (!geometry.bind_vertices.empty()) {
                    geometry.bind_vertices =
                        std::move(flat_bind_vertices);
                }
                geometry.morph_positions =
                    std::move(flat_morph_positions);
                geometry.morph_normals =
                    std::move(flat_morph_normals);
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
                    // The pin's flat normal is the fragment stage's
                    // normalize(cross(dpdx(worldPos), dpdy(worldPos)));
                    // its CPU stand-in normalizes the face through the
                    // same guarded shader normalize the vertex bake uses.
                    const Vec3 normal =
                        upstream::normalize_baked_direction(face);
                    a.normal = normal;
                    b.normal = normal;
                    c.normal = normal;
                }
            }
            geometry.has_tangents = tangents != nullptr;
            geometry.has_uvs = true;
            geometry.has_vertex_colors = colors != nullptr;
            // The same fork the position store above took: a static
            // primitive carries its mirrored node world, an animated or
            // instanced one carries the mirror alone and receives the
            // node matrix per draw.
            geometry.vertex_space = animated || instanced
                ? VertexSpace::mirrored_local
                : VertexSpace::world;
            if (animated) {
                geometry.bind_vertices = geometry.vertices;
            }
            const auto& local_bounds = setup_accessor("bounds", "VEC3", 2);
            const auto& world_bounds = setup_accessor("worldBounds", "VEC3", 2);
            const auto read_bound = [&](const AccessorInfo& value, std::size_t index) {
                return Vec3{
                    read_component(buffer, container, views, value, index, 0),
                    read_component(buffer, container, views, value, index, 1),
                    read_component(buffer, container, views, value, index, 2),
                };
            };
            const Vec3 world_min = read_bound(world_bounds, 0);
            const Vec3 world_max = read_bound(world_bounds, 1);
            if (animated) {
                const Vec3 local_min = read_bound(local_bounds, 0);
                const Vec3 local_max = read_bound(local_bounds, 1);
                geometry.bounds_min = Vec3{-local_max.x, local_min.y, local_min.z};
                geometry.bounds_max = Vec3{-local_min.x, local_max.y, local_max.z};
            } else {
                geometry.bounds_min = world_min;
                geometry.bounds_max = world_max;
            }
${animatedWorldBounds ? `            geometry.world_bounds_min = world_min;
            geometry.world_bounds_max = world_max;
` : ""}            engine.geometries.push_back(std::move(geometry));
            MeshRecord record;
            record.scene_node_name = string_or(node, "name");
            if (record.scene_node_name.empty()) {
                record.scene_node_name = "gltf_node_" +
                    std::to_string(node_index);
            }
            record.name = required(planned, "name").as_string();
            record.primitive = PrimitiveKind::gltf;
            record.geometry = static_cast<std::uint32_t>(engine.geometries.size() - 1);
            // src/material/pbr/fragments/refraction-rtt-fragment.ts,
            // makeRefractionMod/thicknessScaleLine: the refraction fragment scales its
            // thickness lanes by \`ts = max(length(mesh.world[0].xyz),
            // max(length(mesh.world[1].xyz), length(mesh.world[2].xyz)))\`,
            // the mesh world's longest basis column. This loader bakes the
            // node world into the vertices, so the draw's mesh.world carries
            // no scale and the fragment's \`ts\` is one; the pinned product is
            // kept by reading that column length off the baked node world
            // here and scaling the material block per draw with it.
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
            record.material = materials[material_index];
            record.authored_clockwise_front_face =
                clockwise_front_face;
            record.clockwise_front_face =
                clockwise_front_face;
            // The node matrix's handedness. Our vertices are stored in the
            // native mirrored convention and the tangent sign is reconciled
            // against it at load, where the pin keeps both unmirrored and puts
            // the mirror in the mesh block's own world matrix. A PAL feeding
            // the pin's composed stages has to undo one to supply the other,
            // and the sign is only known here.
            record.mirrored_x = determinant < 0.0;
            record.visible = required(setup, "visible").as_boolean();${!nodeVisibility ? `
            if (!record.visible) throw std::runtime_error("Prepared glTF visibility requires visibility support.");` : ""}
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
                    planned_skin
                        ? unsigned_value(required(planned_skin->as_object(), "index"))
                        : std::numeric_limits<std::size_t>::max();
                ${pinnedSkeletonPalette
                    ? `// A composed skeleton variant reads the pin's own
                // palette texture, sized per bone by
                // bone_palette_layout, so it carries any joint count and
                // has no size to refuse.`
                    : `// Deformation runs on the GPU or not at all, and the
                // uniform-array palette the transcribed vertex stage
                // reads holds ${DEFORMATION_BONE_SLOTS} matrices. Generation already
                // refuses a larger skin by name; this is the load-time
                // defense for a BBLITE_ASSET_DIR override, the same
                // split asset-specializer.ts documents for every other
                // unsupported-asset check.
                if (
                    skin_index !=
                        std::numeric_limits<std::size_t>::max() &&
                    animation_runtime
                            ->skins.at(skin_index)
                            .joints.size() > ${DEFORMATION_BONE_SLOTS}) {
                    throw std::runtime_error(
                        "Skin exceeds the ${DEFORMATION_BONE_SLOTS}-matrix vertex-stage bone "
                        "palette. That palette is the transport for a "
                        "scene composing no pinned skeleton variant; "
                        "the pin's own per-bone palette texture caps "
                        "nothing.");
                }`}
                engine.meshes[mesh_record_index]
                    .gpu_deformation = true;
                // mesh.skeleton upstream: the node named a skin, so the
                // pose pass writes this record a joint palette rather than
                // its own world matrix.
${vat || deformPicking ? `                engine.meshes[mesh_record_index].skinned =
                    skin_index !=
                    std::numeric_limits<std::size_t>::max();` : ""}${pinnedSkeletonPalette ? `
                // A mesh with no skin publishes no palette at all, so the
                // flag is about the transport rather than about this mesh.
                engine.meshes[mesh_record_index]
                    .pinned_bone_palette = true;` : ""}
                animation_runtime
                    ->node_meshes[node_index]
                    .push_back(mesh_record_index);
                animation_runtime->meshes.push_back(
                    AnimatedMeshBinding{
                        mesh_record_index,
                        record.geometry,
                        node_index,
                        skin_index,
                        std::move(morph_default_weights),
                    });
            }
            asset.meshes.push_back(MeshHandle{mesh_record_index});${interactivity ? `
            // mesh._gltfNodeIndex, in the same node-then-primitive walk.
            asset.mesh_nodes.push_back(node_index);
            asset.node_meshes[node_index].push_back(MeshHandle{mesh_record_index});` : ""}
    }
    if (animated) {
        {
        const bool sampler_converter_enabled = gltf_needs_animation_sampler_converter(GltfPbrValue{&container.json}).truthy() || ${animationPointer};
        const auto parsed = gltf_animation_clips(GltfPbrValue{&container.json},
            [&](double index) { return GltfAccessorView{buffer, container, views, accessors.at(gltf_checked_index(index))}; },
            [&](const GltfAccessorView& view, double length, bool normalized) {
                auto values = gltf_animation_sampler_float32(view, length, normalized, sampler_converter_enabled);
                return GltfAnimationSamples{std::move(values), view.accessor.type};
            }, ${animationPointer}, [](const GltfPbrValue& pointer, const GltfPbrValue& channel) {
                auto parsed_channel = js::make_ref<GltfParsedChannel>();
                parsed_channel->samplerIdx = channel.get("sampler").number();
                parsed_channel->nodeIdx = -1.0;
                parsed_channel->path = -1.0;
                parsed_channel->pointer = pointer;
                return parsed_channel;
            });
        for (const auto& parsed_clip : parsed.clips) {
            // One clip per glTF animation, named the way
            // createAnimationGroups names it, and started only for the first.
            const std::size_t clip_index =
                animation_runtime->clips.size();
            AnimationClip clip;
            clip.name = parsed_clip->name.empty() ? "animation_" + std::to_string(clip_index) : parsed_clip->name;
            clip.duration = static_cast<float>(parsed_clip->duration);
            clip.playing = clip_index == 0;
            clip.stopped = !clip.playing;
            animation_runtime->clips.push_back(std::move(clip));${animationBlending ? `
            // Where this clip's contiguous run of each track vector
            // starts; the ends land after the channel loop, and the
            // pair is pushed in clip order so the ranges index like
            // clips.
            ClipTrackRanges clip_track_range;
            clip_track_range.rotation.first =
                animation_runtime->rotation_tracks.size();
            clip_track_range.translation.first =
                animation_runtime->translation_tracks.size();
            clip_track_range.scale.first =
                animation_runtime->scale_tracks.size();` : ""}
            for (const auto& parsed_channel : parsed_clip->channels) {
                std::string path_name = gltf_animation_path_name(parsed_channel->path);
                const auto& parsed_sampler = parsed_clip->samplers.at(gltf_checked_index(parsed_channel->samplerIdx));
                // A node-TRS pointer resolves to the same thing a standard
                // channel does, so it carries a node index the standard path
                // reads in place of the target's own.
                bool pointer_node_override = false;
                std::size_t pointer_node_index = 0;${animationPointer ? `
                if (path_name == "pointer") {
                    const std::string& pointer_target = parsed_channel->pointer.string();
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
                            const auto& light_sampler = parsed_sampler;
                            const std::string light_interpolation =
                                gltf_animation_interpolation_name(light_sampler->interpolation);
                            if (light_interpolation != "LINEAR") {
                                throw std::runtime_error(
                                    "Reached KHR_animation_pointer light targets support LINEAR interpolation only.");
                            }
                            const GltfAnimationSamples& light_input = light_sampler->input;
                            const GltfAnimationSamples& light_output = light_sampler->output;
                            if (
                                light_input.type != "SCALAR" ||
                                light_input.count != light_output.count ||
                                light_output.components !=
                                    components) {
                                throw std::runtime_error(
                                    "glTF light pointer accessors have an unsupported layout.");
                            }
                            for (
                                std::size_t index = 0;
                                index < light_input.count;
                                ++index) {
                                const float time = light_input.component(index, 0);
                                track.times.push_back(time);
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
                                    *channels[component] = light_output.component(index, component);
                                }
                                track.values.push_back(value);
                            }
                            animation_runtime->light_tracks.push_back(
                                std::move(track));
                            continue;
                        }
                    }
                    if (!pointer_node_override) {
                    const std::string& pointer = pointer_target;
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
                                const auto resolution = material_transform_slot(slot_path, track.slot);
                                if (resolution == TextureTransformResolution::ignored) continue;
                                if (resolution == TextureTransformResolution::resolved) {
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
                        if (material_index >= source_materials.size()) {
                            throw std::runtime_error(
                                "glTF animation pointer targets a material that does not exist.");
                        }
                        if (source_materials[material_index].value == invalid_handle) continue;
                        track.material = source_materials[material_index].value;
                        const auto& material_sampler = parsed_sampler;
                        if (
                            gltf_animation_interpolation_name(material_sampler->interpolation) != "LINEAR") {
                            throw std::runtime_error(
                                "glTF material animation supports LINEAR interpolation.");
                        }
                        const GltfAnimationSamples& material_input = material_sampler->input;
                        const GltfAnimationSamples& material_output = material_sampler->output;
                        if (
                            material_input.type != "SCALAR" ||
                            material_output.components !=
                                components ||
                            material_output.count != material_input.count) {
                            throw std::runtime_error(
                                "glTF material animation accessor layout is invalid.");
                        }
                        for (
                            std::size_t index = 0;
                            index < material_input.count;
                            ++index) {
                            const float time = material_input.component(index, 0);
                            track.times.push_back(time);
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
                                *channels[component] = material_output.component(index, component);
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
                    const auto& pointer_sampler = parsed_sampler;
                    if (
                        gltf_animation_interpolation_name(pointer_sampler->interpolation) != "STEP") {
                        // Visibility is a boolean; the pin authors it STEP
                        // and interpolating one would have no meaning.
                        throw std::runtime_error(
                            "glTF node-visibility animation requires STEP interpolation.");
                    }
                    const GltfAnimationSamples& pointer_input = pointer_sampler->input;
                    const GltfAnimationSamples& pointer_output = pointer_sampler->output;
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
                        const float time = pointer_input.component(index, 0);
                        track.times.push_back(time);
                        track.values.push_back(
                            pointer_output.component(index, 0) != 0.0f);
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
                const auto& sampler = parsed_sampler;
                const std::string interpolation =
                    gltf_animation_interpolation_name(sampler->interpolation);
                const TrackInterpolation track_interpolation =
                    interpolation == "STEP"
                        ? TrackInterpolation::step
                        : interpolation == "CUBICSPLINE"
                            ? TrackInterpolation::cubic
                            : TrackInterpolation::linear;
                const GltfAnimationSamples& input = sampler->input;
                const GltfAnimationSamples& output = sampler->output;
                const std::size_t target_node =
                    pointer_node_override
                        ? pointer_node_index
                        : gltf_checked_index(parsed_channel->nodeIdx);
                if (input.type != "SCALAR") {
                    throw std::runtime_error(
                        "glTF animation input accessor must be SCALAR.");
                }
                if (path_name == "rotation") {
                    const bool cubic =
                        track_interpolation == TrackInterpolation::cubic;
                    if (
                        output.type != "VEC4" ||
                        output.count !=
                            input.count * (cubic ? 3u : 1u)) {
                        throw std::runtime_error(
                            "glTF rotation animation accessor layout is invalid.");
                    }
                    RotationTrack track;
                    track.node = target_node;
                    track.interpolation = track_interpolation;
                    for (std::size_t index = 0; index < input.count; ++index) {
                        track.times.push_back(
                            input.component(index, 0));
                        const std::size_t value_index =
                            cubic ? index * 3 + 1 : index;
                        const auto read_quaternion =
                            [&](std::size_t output_index) {
                            return Vec4{
                                output.component(output_index, 0),
                                output.component(output_index, 1),
                                output.component(output_index, 2),
                                output.component(output_index, 3),
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
                        track_interpolation == TrackInterpolation::cubic;
                    if (
                        output.type != "VEC3" ||
                        output.count !=
                            input.count * (cubic ? 3u : 1u)) {
                        throw std::runtime_error(
                            "glTF translation or scale animation accessor layout is invalid.");
                    }
                    TranslationTrack track;
                    track.node = target_node;
                    track.interpolation = track_interpolation;
                    for (std::size_t index = 0; index < input.count; ++index) {
                        track.times.push_back(
                            input.component(index, 0));
                        const std::size_t value_index =
                            cubic ? index * 3 + 1 : index;
                        const auto read_translation =
                            [&](std::size_t output_index) {
                            return Vec3{
                                output.component(output_index, 0),
                                output.component(output_index, 1),
                                output.component(output_index, 2),
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
                    if (
                        track_interpolation ==
                            TrackInterpolation::cubic) {
                        throw std::runtime_error(
                            "glTF weights animation currently requires LINEAR or STEP interpolation.");
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
                    track.interpolation = track_interpolation;
                    track.target_count =
                        output.count / input.count;
                    for (std::size_t index = 0; index < input.count; ++index) {
                        track.times.push_back(
                            input.component(index, 0));
                        for (std::size_t target_index = 0; target_index < track.target_count; ++target_index) {
                            track.values.push_back(
                                output.component(index * track.target_count + target_index, 0));
                        }
                    }
                    track.clip = clip_index;
                    animation_runtime
                        ->weight_tracks
                        .push_back(std::move(track));
                }
            }${animationBlending ? `
            clip_track_range.rotation.last =
                animation_runtime->rotation_tracks.size();
            clip_track_range.translation.last =
                animation_runtime->translation_tracks.size();
            clip_track_range.scale.last =
                animation_runtime->scale_tracks.size();
            animation_runtime->clip_track_ranges.push_back(
                clip_track_range);` : ""}
        }
        }
${animationMask ? `        // parseAnimationData's own nodeNames, in document order: what an
        // AnimationGroupMask matches against. A node with no name matches
        // the empty string, which is what the pin's resolver reads too.
        animation_runtime->node_names.reserve(node_json.size());
        for (const ts::JsonValue& node_value : node_json) {
            animation_runtime->node_names.push_back(
                string_or(node_value.as_object(), "name", ""));
        }
` : ""}        // The pose half of a tick: node worlds, skin palettes, morph
        // weights and the CPU deformation fallbacks, from whatever the
        // node TRS currently holds. Split out because the weighted mixer
        // (src/animation/weighted-gltf-mixer.ts) accumulates a blended
        // TRS and then needs exactly this pass.
        const auto apply_animation_pose =
            [animation_runtime, &engine]() {
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
                    ? upstream::matrix_product(
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
            }` : ""}${gltfCameras ? `
${lowered.gltfCameraPoseRefresh}` : ""}
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
                MeshRecord& mesh_record =
                    engine.meshes.at(binding.mesh);
                // attachVat sets mesh.skeleton = null: a baked mesh has no
                // live skinning left, so the pose pass stops solving it a
                // palette at all. Placed after the mesh world above and
                // before the joint loop below, because a baked mesh still
                // needs its own animated transform -- the VAT shader
                // multiplies by it -- but not the palette, which is what
                // the bake replaced. Solving one and discarding it cost a
                // skin's worth of matrix products and a heap allocation
                // per baked mesh per frame, and as many again for every
                // pose the bake itself steps through.
${vat ? `                if (mesh_record.has_vat) continue;` : ""}
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
                            upstream::matrix_product(
                                compute_animated_world(
                                    skin->joints[joint]),
                                skin->inverse_bind_matrices[joint]));
                    }
                }
${deformPicking ? `                // The pin's detailed pick reads \`mesh.worldMatrix\` for the
                // rest normal, and a skinned record's own transform stays
                // at rest because its palette carries this. Kept here, in
                // the one place that computes it, for that reader alone.
                mesh_record.deform_node_world = native_matrix(mesh_world);
` : ""}                mesh_record.bone_matrices.clear();
                if (skin) {
                    for (const Matrix& joint_matrix : joint_matrices) {
                        mesh_record.bone_matrices.push_back(
                            native_matrix(joint_matrix));
                    }
                } else {
                    mesh_record.bone_matrices.push_back(
                        native_matrix(mesh_world));
                }
                ++mesh_record.bone_matrices_version;
                mesh_record.morph_weights = {};
                const auto& sampled_weights = animation_runtime->nodes[binding.node].weights;
                const auto& node_weights = sampled_weights ? *sampled_weights : binding.morph_default_weights;
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
                // Positions deform on the GPU. A primitive with no
                // source normals was deindexed at load, so only its face
                // normals still have to be recomputed here, from the
                // positions this loop skins CPU-side for that purpose.
                if (!geometry.flat_normals) {
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
                    const auto& morph_weights = node_weights;
                    for (
                        std::size_t target = 0;
                        target < morph_weights.size() &&
                        target < geometry.morph_positions.size();
                        ++target) {
                        const float weight = morph_weights[target];
                        const Vec3 position_delta =
                            geometry.morph_positions[target][vertex_index];
                        morphed_position.x +=
                            position_delta.x * weight;
                        morphed_position.y +=
                            position_delta.y * weight;
                        morphed_position.z +=
                            position_delta.z * weight;
                    }
                    Vec3 position{};
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
                                upstream::transform_position(
                                    joint_matrices[joint],
                                    morphed_position);
                            position.x += joint_position.x * weight;
                            position.y += joint_position.y * weight;
                            position.z += joint_position.z * weight;
                        }
                    } else {
                        position = upstream::transform_position(
                            mesh_world,
                            morphed_position);
                    }
                    ModelVertex& vertex =
                        geometry.vertices[vertex_index];
                    vertex.position = Vec3{
                        -position.x,
                        position.y,
                        position.z,
                    };
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
                    const Vec3 face = upstream::normalize_baked_direction(Vec3{
                        edge2.y * edge1.z - edge2.z * edge1.y,
                        edge2.z * edge1.x - edge2.x * edge1.z,
                        edge2.x * edge1.y - edge2.y * edge1.x,
                    });
                    a.normal = face;
                    b.normal = face;
                    c.normal = face;
                }
                ++mesh_record.transform_version;
            }
        };
${animationBlending ? `        // src/animation/weighted-gltf-mixer.ts: the manager's weighted
        // pass over the clips attached to it. Returns whether it drove
        // this tick — false when nothing qualifies, which is the pin's
        // own category-handler contract and hands the tick back to the
        // ordinary per-clip advance.
        //
        // Only the accumulation differs from the direct path: each
        // contributing clip's channels are summed into the node TRS by
        // weight (rotations by incremental slerp), and the pose pass
        // then composes exactly as it does for a single clip.
        const auto apply_blended_animation =
            [animation_runtime, apply_animation_pose](
                const std::vector<BlendedClip>& blended,
                float delta_ms) -> bool {
            bool qualifies = false;
            for (const BlendedClip& entry : blended) {
                if (entry.clip >= animation_runtime->clips.size()) {
                    continue;
                }
                if (animation_runtime->clips[entry.clip].stopped) {
                    continue;
                }${animationAdditive ? `
                // A clip at full weight leaves the pose it would have
                // written alone — unless it is additive, whose whole
                // point is contributing beside the base
                // (the pinned skip: weight === 1 && !_additive).
                if (
                    entry.weight != 1.0f ||
                    animation_runtime->clips[entry.clip].additive) {
                    qualifies = true;
                }` : `
                // A clip at full weight leaves the pose it would have
                // written alone, so it does not make the mixer the
                // handler for this tick.
                if (entry.weight != 1.0f) qualifies = true;`}
            }
            if (!qualifies) return false;
            for (AnimatedNode& node : animation_runtime->nodes) {
                node.translation = node.rest_translation;
                node.rotation = node.rest_rotation;
                node.scale = node.rest_scale;
                node.translation_weight = 0.0f;
                node.rotation_weight = 0.0f;
                node.scale_weight = 0.0f;
            }
            for (const BlendedClip& entry : blended) {
                if (entry.clip >= animation_runtime->clips.size()) {
                    continue;
                }
                AnimationClip& clip =
                    animation_runtime->clips[entry.clip];
                if (clip.stopped) continue;
                if (clip.playing) {
                    clip.time += delta_ms * 0.001f;
                }
                if (clip.duration <= 0.0f) {
                    clip.time = 0.0f;
                } else if (clip.loop && clip.playing) {
                    clip.time = std::fmod(clip.time, clip.duration);
                    if (clip.time < 0.0f) clip.time += clip.duration;
                } else {
                    clip.time = std::min(
                        std::max(clip.time, 0.0f),
                        clip.duration);
                }${animationAdditive ? `
                // An additive group only advances its time here — the
                // pin marks the target active and moves on; its channels
                // contribute in the pass below, on top of whatever the
                // base groups accumulated.
                if (clip.additive) continue;` : ""}
                const float weight = entry.weight;
                if (weight == 0.0f) continue;
                // The clip's own contiguous run of each vector; the
                // track.clip test below stays, so a grouping this
                // bookkeeping got wrong could only skip work, never
                // blend another clip's track.
                const ClipTrackRanges& clip_range =
                    animation_runtime->clip_track_ranges[entry.clip];
                for (std::size_t track_index =
                         clip_range.rotation.first;
                     track_index < clip_range.rotation.last;
                     ++track_index) {
                    const RotationTrack& track =
                        animation_runtime
                            ->rotation_tracks[track_index];
                    if (
                        track.clip != entry.clip ||
                        track.times.empty() ||
                        track.node >=
                            animation_runtime->nodes.size()) {
                        continue;
                    }
${animationMask ? `
                    if (clip_masks_node(clip, track.node)) continue;` : ""}
                    const Vec4 sample =
                        sample_rotation_track(track, clip.time);
                    AnimatedNode& node =
                        animation_runtime->nodes[track.node];
                    if (node.rotation_weight == 0.0f) {
                        node.rotation = sample;
                        node.rotation_weight = weight;
                        continue;
                    }
                    node.rotation = interpolate_quaternion(
                        node.rotation,
                        sample,
                        static_cast<double>(weight) /
                            (static_cast<double>(
                                 node.rotation_weight) +
                             weight));
                    node.rotation_weight += weight;
                }
                // Translation and scale accumulate the same way, so the
                // channel is a pair of members rather than a second loop.
                const auto accumulate_vec3 =
                    [&](const std::vector<TranslationTrack>& tracks,
                        const TrackRange& range,
                        Vec3 AnimatedNode::*value,
                        float AnimatedNode::*accumulated) {
                    for (std::size_t track_index = range.first;
                         track_index < range.last;
                         ++track_index) {
                        const TranslationTrack& track =
                            tracks[track_index];
                        if (
                            track.clip != entry.clip ||
                            track.times.empty() ||
                            track.node >=
                                animation_runtime->nodes.size()) {
                            continue;
                        }
${animationMask ? `
                        if (clip_masks_node(clip, track.node)) continue;` : ""}
                        const Vec3 sample =
                            sample_vec3_track(track, clip.time);
                        AnimatedNode& node =
                            animation_runtime->nodes[track.node];
                        if (node.*accumulated == 0.0f) {
                            node.*value = Vec3{0.0f, 0.0f, 0.0f};
                        }
                        node.*value = Vec3{
                            (node.*value).x + sample.x * weight,
                            (node.*value).y + sample.y * weight,
                            (node.*value).z + sample.z * weight,
                        };
                        node.*accumulated += weight;
                    }
                };
                accumulate_vec3(
                    animation_runtime->translation_tracks,
                    clip_range.translation,
                    &AnimatedNode::translation,
                    &AnimatedNode::translation_weight);
                accumulate_vec3(
                    animation_runtime->scale_tracks,
                    clip_range.scale,
                    &AnimatedNode::scale,
                    &AnimatedNode::scale_weight);
            }
${animationAdditive ? `            // src/animation/weighted-gltf-mixer.ts accumulateAdditiveGroup,
            // run after every base group accumulated (the pin's own
            // third pass): each additive clip's channels add the
            // weighted difference between the clip-time sample and the
            // reference-time sample, and for rotation multiply
            // reference^-1 * sample onto the base before slerping toward
            // it by the weight. Additive weights never join the
            // rotation-weight sums, so the rest-remainder blend below
            // sees only the base clips.
            const auto quat_multiply =
                [](const Vec4& a, const Vec4& b) -> Vec4 {
                return Vec4{
                    a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
                    a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
                    a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
                    a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
                };
            };
            for (const BlendedClip& entry : blended) {
                if (entry.clip >= animation_runtime->clips.size()) {
                    continue;
                }
                AnimationClip& clip =
                    animation_runtime->clips[entry.clip];
                // The pinned pass condition: !_stopped && _additive.
                if (clip.stopped || !clip.additive) continue;
                const float weight = entry.weight;
                if (weight == 0.0f) continue;
                const ClipTrackRanges& clip_range =
                    animation_runtime->clip_track_ranges[entry.clip];
                for (std::size_t track_index =
                         clip_range.rotation.first;
                     track_index < clip_range.rotation.last;
                     ++track_index) {
                    const RotationTrack& track =
                        animation_runtime
                            ->rotation_tracks[track_index];
                    if (
                        track.clip != entry.clip ||
                        track.times.empty() ||
                        track.node >=
                            animation_runtime->nodes.size()) {
                        continue;
                    }
                    const Vec4 sample =
                        sample_rotation_track(track, clip.time);
                    const Vec4 reference = sample_rotation_track(
                        track,
                        clip.additive_reference_time);
                    // reference^-1 * sample, normalized: the delta this
                    // clip contributes.
                    const Vec4 delta = normalize_quaternion(
                        quat_multiply(
                            Vec4{
                                -reference.x,
                                -reference.y,
                                -reference.z,
                                reference.w,
                            },
                            sample));
                    AnimatedNode& node =
                        animation_runtime->nodes[track.node];
                    node.rotation = interpolate_quaternion(
                        node.rotation,
                        quat_multiply(node.rotation, delta),
                        weight);
                }
                const auto accumulate_additive_vec3 =
                    [&](const std::vector<TranslationTrack>& tracks,
                        const TrackRange& range,
                        Vec3 AnimatedNode::*value) {
                    for (std::size_t track_index = range.first;
                         track_index < range.last;
                         ++track_index) {
                        const TranslationTrack& track =
                            tracks[track_index];
                        if (
                            track.clip != entry.clip ||
                            track.times.empty() ||
                            track.node >=
                                animation_runtime->nodes.size()) {
                            continue;
                        }
                        const Vec3 sample =
                            sample_vec3_track(track, clip.time);
                        const Vec3 reference = sample_vec3_track(
                            track,
                            clip.additive_reference_time);
                        AnimatedNode& node =
                            animation_runtime->nodes[track.node];
                        node.*value = Vec3{
                            (node.*value).x +
                                (sample.x - reference.x) * weight,
                            (node.*value).y +
                                (sample.y - reference.y) * weight,
                            (node.*value).z +
                                (sample.z - reference.z) * weight,
                        };
                    }
                };
                accumulate_additive_vec3(
                    animation_runtime->translation_tracks,
                    clip_range.translation,
                    &AnimatedNode::translation);
                accumulate_additive_vec3(
                    animation_runtime->scale_tracks,
                    clip_range.scale,
                    &AnimatedNode::scale);
            }
` : ""}            // A node the clips animate below full weight keeps the
            // remainder of its rest rotation; at or above it, the
            // accumulated slerps are renormalized.
            for (AnimatedNode& node : animation_runtime->nodes) {
                if (
                    node.rotation_weight > 0.0f &&
                    node.rotation_weight < 1.0f) {
                    node.rotation = interpolate_quaternion(
                        node.rest_rotation,
                        node.rotation,
                        node.rotation_weight);
                } else if (node.rotation_weight > 0.0f) {
                    node.rotation =
                        normalize_quaternion(node.rotation);
                }
            }
            apply_animation_pose();
            return true;
        };
` : ""}        // Everything a tick evaluates from the clip times it was just
        // given: the pointer tracks, the transform channels, the morph
        // weights, and the pose pass. Split out so a manager can advance
        // only the clips it owns and then run the same evaluation.
        // only_clip selects which clip's channels run; force_stopped is
        // goToFrame's engine argument, which ticks a stopped group's
        // controller where an ordinary pass skips it.
        const auto apply_animation_state =
            [animation_runtime${
                animationPointer ? ", &engine" : ""
            }, apply_animation_pose](
                std::size_t only_clip,
                bool force_stopped) {${animationMask ? `
            // The pin's controller resets every node to its rest TRS before
            // walking the clip's channels, so a masked channel leaves the
            // rest pose behind. Only the masked nodes need it here: every
            // other animated node is overwritten by its own track.
            for (
                std::size_t index = 0;
                index < animation_runtime->clips.size();
                ++index) {
                const AnimationClip& masked_clip =
                    animation_runtime->clips[index];
                if (!masked_clip.mask_active) continue;
                if (
                    only_clip != invalid_handle &&
                    index != only_clip) continue;
                if (masked_clip.stopped && !force_stopped) continue;
                for (
                    const std::uint32_t node :
                    masked_clip.masked_node_indices) {
                    if (node >= animation_runtime->nodes.size()) continue;
                    AnimatedNode& target =
                        animation_runtime->nodes[node];
                    target.translation = target.rest_translation;
                    target.rotation = target.rest_rotation;
                    target.scale = target.rest_scale;
                }
            }` : ""}${animationPointer ? `
            for (const VisibilityTrack& track :
                 animation_runtime->visibility_tracks) {
                if (
                    only_clip != invalid_handle &&
                    track.clip != only_clip) continue;
                const AnimationClip& clip =
                    animation_runtime->clips[track.clip];
                if (clip.stopped && !force_stopped) continue;
                if (track.times.empty()) continue;
                // STEP holds each output until the next keyframe, so the
                // key in effect is the last one at or before the current
                // time and the first key holds before that -- the same
                // selection every STEP sampler makes.
                const std::size_t right =
                    track_key_at(track.times, clip.time);
                const bool visible = track.values[track_step_key_at(
                    track.times,
                    right > 0 ? right - 1 : 0,
                    right,
                    clip.time)];
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
                if (
                    only_clip != invalid_handle &&
                    track.clip != only_clip) continue;
                const AnimationClip& clip =
                    animation_runtime->clips[track.clip];
                if (clip.stopped && !force_stopped) continue;
                if (
                    track.times.empty() ||
                    track.material >= engine.materials.size()) {
                    continue;
                }
                const std::size_t right =
                    track_key_at(track.times, clip.time);
                const std::size_t left = right > 0 ? right - 1 : 0;
                const double amount = track_amount_at(
                    track.times,
                    left,
                    right,
                    clip.time);
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
                        if (material.source_base_color_factor) {
                            // The pin's pointer writer copies its sampled F32
                            // output into the existing public number array.
                            const auto& value = material.base_color_factor;
                            *material.source_base_color_factor = {value.r, value.g, value.b, value.a};
                        }
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
                        material.index_of_refraction = mix(a.x, b.x);
                        material.metallic_f0_factor = static_cast<float>(
                            gltf_pbr_animation_pointer_ext_iorToF0Factor(GltfPbrValue{double(material.index_of_refraction)}).number());
                        material.specular_weight = 1.0f;
                        break;
                    case MaterialTrackKind::volume_thickness:
                        material.thickness = mix(a.x, b.x);
                        material.use_thickness_as_depth = true;
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
                if (
                    only_clip != invalid_handle &&
                    track.clip != only_clip) continue;
                const AnimationClip& clip =
                    animation_runtime->clips[track.clip];
                if (clip.stopped && !force_stopped) continue;
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
                        light.angle =
                            static_cast<double>(mix(a.x, b.x)) * 2.0;
                        break;
                }
            }
` : ""}            for (const RotationTrack& track :
                 animation_runtime->rotation_tracks) {
                if (
                    only_clip != invalid_handle &&
                    track.clip != only_clip) continue;
                const AnimationClip& clip =
                    animation_runtime->clips[track.clip];
                if (clip.stopped && !force_stopped) continue;
                if (
                    track.times.empty() ||
                    track.node >=
                        animation_runtime->node_meshes.size()) {
                    continue;
                }${animationMask ? `
                if (clip_masks_node(clip, track.node)) continue;` : ""}
                animation_runtime->nodes[track.node].rotation =
                    sample_rotation_track(track, clip.time);
            }
            for (const TranslationTrack& track :
                 animation_runtime->translation_tracks) {
                if (
                    only_clip != invalid_handle &&
                    track.clip != only_clip) continue;
                const AnimationClip& clip =
                    animation_runtime->clips[track.clip];
                if (clip.stopped && !force_stopped) continue;
                if (
                    track.times.empty() ||
                    track.node >=
                        animation_runtime->nodes.size()) {
                    continue;
                }${animationMask ? `
                if (clip_masks_node(clip, track.node)) continue;` : ""}
                animation_runtime->nodes[track.node].translation =
                    sample_vec3_track(track, clip.time);
            }
            for (const TranslationTrack& track :
                 animation_runtime->scale_tracks) {
                if (
                    only_clip != invalid_handle &&
                    track.clip != only_clip) continue;
                const AnimationClip& clip =
                    animation_runtime->clips[track.clip];
                if (clip.stopped && !force_stopped) continue;
                if (
                    track.times.empty() ||
                    track.node >=
                        animation_runtime->nodes.size()) {
                    continue;
                }${animationMask ? `
                if (clip_masks_node(clip, track.node)) continue;` : ""}
                animation_runtime->nodes[track.node].scale =
                    sample_vec3_track(track, clip.time);
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
                if (
                    only_clip != invalid_handle &&
                    track.clip != only_clip) continue;
                const AnimationClip& clip =
                    animation_runtime->clips[track.clip];
                if (clip.stopped && !force_stopped) continue;
                if (
                    track.times.empty() ||
                    track.node >= animation_runtime->nodes.size()) {
                    continue;
                }${animationMask ? `
                if (clip_masks_node(clip, track.node)) continue;` : ""}
                std::size_t right =
                    track_key_at(track.times, clip.time);
                std::size_t left =
                    right > 0 ? right - 1 : 0;
                if (track.interpolation == TrackInterpolation::step) {
                    // One key held: collapsing the pair onto it leaves
                    // track_amount_at's zero-span arm to return 0, so the
                    // blend below reads that key alone.
                    left = right = track_step_key_at(
                        track.times, left, right, clip.time);
                }
                const double amount = track_amount_at(
                    track.times,
                    left,
                    right,
                    clip.time);
                AnimatedNode& node =
                    animation_runtime->nodes[track.node];
                if (!node.weights) node.weights.emplace();
                node.weights->resize(track.target_count);
                for (std::size_t target = 0; target < track.target_count; ++target) {
                    const float left_value =
                        track.values[left * track.target_count + target];
                    const float right_value =
                        track.values[right * track.target_count + target];
                    (*node.weights)[target] = static_cast<float>(
                        left_value +
                        (static_cast<double>(right_value) -
                         left_value) *
                            amount);
                }
            }
            apply_animation_pose();
        };
        const auto apply_animation_time =
            [animation_runtime, apply_animation_state](
                float time,
                bool seek) {
            // The master clock is the scene's elapsed animation time and no
            // longer wraps: each clip loops over its own duration, the way
            // upstream's per-group controllers do, and a clip upstream never
            // started holds at zero.
            animation_runtime->time = std::max(time, 0.0f);
            for (AnimationClip& clip : animation_runtime->clips) {
                // A seek freezes what was animating. A stopped clip is
                // outside it because the pin's own tick returns early
                // for one — and a PAUSED clip already holds a pose the
                // scene chose: upstream only moves a paused group's time
                // through an explicit per-group write, never through a
                // tick (advanceGroupTime advances only while playing),
                // so the fanned-out seek must not move it either.
                if (
                    seek ? (clip.stopped || !clip.playing)
                         : !clip.playing) {
                    continue;
                }
${animationSpeedRatio ? `                // The pin advances time += dt * speedRatio from wherever
                // the ratio was last written, so the derived time is the
                // base plus the scaled span since that write.
                //
                // A SEEK is the exception, and deliberately: the browser
                // capture harness pins a pose by writing the group's own
                // currentTime and pausing it, which no ratio scales. The
                // native seek mirrors that harness, so it takes the clock
                // as the clip time and leaves the ratio to the tick.
                const float raw = seek
                    ? animation_runtime->time
                    : clip.speed_base +
                          (animation_runtime->time - clip.speed_origin) *
                              clip.speed_ratio;
                const float wrapped = clip.duration <= 0.0f
                    ? 0.0f
                    : std::fmod(raw, clip.duration);
                clip.time = clip.duration <= 0.0f
                    ? 0.0f
                    : clip.loop
                      ? (wrapped < 0.0f
                             ? wrapped + clip.duration
                             : wrapped)
                      : std::min(
                            std::max(raw, 0.0f),
                            clip.duration);` : `                clip.time = clip.duration <= 0.0f
                    ? 0.0f
                    : clip.loop
                      ? std::fmod(
                            animation_runtime->time,
                            clip.duration)
                      : std::min(
                            animation_runtime->time,
                            clip.duration);`}
                if (seek) {
                    clip.playing = false;
                }
            }
            apply_animation_state(invalid_handle, false);
        };
        // The pre-tick pose is the file's REST hierarchy, not the first
        // clip at time zero: gltf-feature-skeleton.ts seeds each skin's
        // bone texture with computeBoneTextureData, which composes
        // invMeshWorld * jointWorld * IBM over the authored node TRS,
        // and nothing evaluates a channel until a tick. The node TRS here
        // is still that authored one, so the pose pass alone IS that
        // seed -- evaluating clip 0 at zero would pose an asset a scene
        // that never ticks leaves at rest. Measured on an Xbot added
        // entity by entity: 0.816 full MAD against the browser with the
        // channel evaluation, 0.000 without it.
        apply_animation_pose();
        // cloneTransformNode gives every mesh wrapper its own transform and
        // material, but retains the exact skeleton resource. Native mesh
        // records hold the evaluated palette themselves, so a skinned clone
        // subscribes another record to this same evaluator. Ordinary
        // node-animation bindings deliberately do not subscribe: the pin
        // deep-clones those TransformNodes and its controller continues to
        // target only the originals. A morph clone would need the same split
        // (shared weights, independent node world), which this bounded path
        // refuses rather than accidentally animating both halves.
        asset.clone_mesh_animation =
            [animation_runtime, &engine](
                MeshHandle source,
                MeshHandle clone) {
            const auto found = std::find_if(
                animation_runtime->meshes.begin(),
                animation_runtime->meshes.end(),
                [source](const AnimatedMeshBinding& binding) {
                    return binding.mesh == source.value;
                });
            if (found == animation_runtime->meshes.end()) return;
            if (
                found->skin ==
                std::numeric_limits<std::size_t>::max()) {
                if (
                    found->geometry < engine.geometries.size() &&
                    !engine.geometries[found->geometry]
                         .morph_positions.empty()) {
                    throw std::runtime_error(
                        "Cloning an animated morph hierarchy requires "
                        "shared morph weights with an independent node world.");
                }
                return;
            }
            AnimatedMeshBinding binding = *found;
            binding.mesh = clone.value;
            animation_runtime->meshes.push_back(binding);
        };
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
${vat ? `        asset.clip_duration =
            [animation_runtime](std::size_t clip) -> float {
            if (clip >= animation_runtime->clips.size()) return 0.0f;
            return animation_runtime->clips[clip].duration;
        };` : ""}
        asset.apply_clip_pose =
            [animation_runtime, apply_animation_state](
                std::size_t clip,
                bool with_engine) {
            if (clip >= animation_runtime->clips.size()) return;
            AnimationClip& selected = animation_runtime->clips[clip];
            // goToFrame's own guard: engine || !group._stopped ||
            // !group._gltfMixer. A glTF group always carries the mixer, so
            // what is left is the engine argument and the stopped flag --
            // a stopped group posed only when the caller passed an engine.
            if (selected.stopped && !with_engine) return;
            apply_animation_state(clip, with_engine);
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
${managedGroups ? `        // The clips a manager owns, advanced each by its own time the way
        // upstream's per-group controller does — the asset's other clips
        // keep whatever pose they last wrote, exactly as a group nothing
        // ticks does upstream.
        asset.animation_tick_clips =
            [animation_runtime, apply_animation_state](
                const std::vector<BlendedClip>& clips,
                float delta_ms) {
            for (const BlendedClip& entry : clips) {
                if (entry.clip >= animation_runtime->clips.size()) {
                    continue;
                }
                AnimationClip& clip =
                    animation_runtime->clips[entry.clip];
                if (clip.stopped || !clip.playing) continue;
                clip.time += delta_ms * 0.001f${animationSpeedRatio ? ` * clip.speed_ratio` : ""};
                if (clip.duration <= 0.0f) {
                    clip.time = 0.0f;
                } else if (clip.loop) {
                    clip.time = std::fmod(clip.time, clip.duration);
                    if (clip.time < 0.0f) clip.time += clip.duration;
                } else {
                    clip.time = std::min(clip.time, clip.duration);
                }
            }
            apply_animation_state(invalid_handle, false);
        };
` : ""}        asset.set_clip_loop =
            [animation_runtime](std::size_t clip, bool loop) {
            if (clip >= animation_runtime->clips.size()) return;
            animation_runtime->clips[clip].loop = loop;
        };${animationSpeedRatio ? `
        asset.set_clip_speed_ratio =
            [animation_runtime](std::size_t clip, float speed_ratio) {
            if (clip >= animation_runtime->clips.size()) return;
            AnimationClip& selected = animation_runtime->clips[clip];
            // Re-anchor: the pin accumulates time += dt * speedRatio, so a
            // write moves the future alone. Holding the clip time and the
            // master clock at the write is what makes the derived time
            // below agree with that accumulation.
            selected.speed_base = selected.time;
            selected.speed_origin = animation_runtime->time;
            selected.speed_ratio = speed_ratio;
        };` : ""}${animationMask ? `
        asset.set_clip_mask =
            [animation_runtime](
                std::size_t clip,
                const std::vector<std::string>& names,
                bool include) {
            if (clip >= animation_runtime->clips.size()) return;
            AnimationClip& selected = animation_runtime->clips[clip];
            const std::size_t node_count =
                animation_runtime->node_names.size();
            selected.masked_nodes.assign(node_count, 0);
            selected.masked_node_indices.clear();
            for (std::size_t node = 0; node < node_count; ++node) {
                const bool listed =
                    std::find(
                        names.begin(),
                        names.end(),
                        animation_runtime->node_names[node]) !=
                    names.end();
                // animationGroupMaskRetainsTarget: retained when listing
                // and including agree. The skip flag is its complement,
                // which is what resolveAnimationMask writes.
                if (listed == include) continue;
                selected.masked_nodes[node] = 1;
                selected.masked_node_indices.push_back(
                    static_cast<std::uint32_t>(node));
            }
            selected.mask_active = true;
        };` : ""}${animationAdditive ? `
        // group._additive = { referenceTime }: the additive mark takes
        // the same writer route as every other group field.
        asset.set_clip_additive =
            [animation_runtime](std::size_t clip, float reference_time) {
            if (clip >= animation_runtime->clips.size()) return;
            animation_runtime->clips[clip].additive = true;
            animation_runtime->clips[clip].additive_reference_time =
                reference_time;
        };` : ""}${animationBlending ? `
        asset.animation_blend = apply_blended_animation;` : ""}${lowered.boneControlLoading}
    }${boneControl ? `
    // The pin builds a Skeleton per skin whatever the file animates. Here
    // the joint list, the inverse bind matrices and the rest hierarchy all
    // live on the animation runtime, which a file with no animations does
    // not build -- so that pairing is refused by name rather than handing
    // the scene an empty skeleton list it would read as "no skins".
    if (!animated && !skin_json.empty()) {
        throw std::runtime_error(
            "enableBoneControl needs the skin runtime this loader builds "
            "for an animated glTF; this file declares skins and carries "
            "no animations.");
    }` : ""}
    if (asset.meshes.empty()${gaussianSplats ? " && asset.gaussian_splats.empty()" : ""}) throw std::runtime_error("glTF contains no renderable meshes.");
    install_asset_scene_meshes(asset, double_array(&required(mesh_plan, "sceneMeshes")));
${sourceMeshWalks ? "    load_source_mesh_walks(asset, document);" : ""}${interactivity ? `
    // KHR_interactivity, selected as the pinned registry selects it: by the
    // extension's presence (gltf-feature-registry.ts). The graphs generation
    // parsed for this packaged file attach to the scene the container is
    // added to (_sceneSetup), and the tables their accessors resolve
    // against are the loaded document's (buildMaterialMap): the glTF
    // material index each pointer names, the node children the visibility
    // cascade walks, and the per-node visibility flag as the extension
    // left it.
    const ts::JsonValue* const extensions_value = optional(document, "extensions");
    if (const ts::JsonValue* const interactivity_value =
            extensions_value ? optional(extensions_value->as_object(), "KHR_interactivity") : nullptr) {
        // container.flowGraphs: one handle per graph the document declares,
        // in graph order, before any scene runs them.
        const AssetHandle self{static_cast<std::uint32_t>(engine.assets.size())};
        std::uint32_t graph_index = 0;
        for ([[maybe_unused]] const ts::JsonValue& graph : array_or_empty(interactivity_value->as_object(), "graphs")) {
            asset.flow_graphs.push_back(FlowGraphHandle{self, graph_index++});
        }
        asset.materials = source_materials;
        asset.node_children.resize(node_json.size());
        for (std::size_t index = 0; index < node_json.size(); ++index) {
            for (const ts::JsonValue& child : array_or_empty(node_json[index].as_object(), "children")) {
                asset.node_children[index].push_back(unsigned_value(child));
            }
        }
        const auto& visibility = required(mesh_plan, "nodeVisibility").as_array();
        if (visibility.size() != node_json.size()) throw std::runtime_error("Invalid glTF node visibility storage.");
        asset.node_visible.reserve(visibility.size());
        for (const auto& value : visibility) asset.node_visible.push_back(value.as_boolean());
        const std::string asset_name = path.substr(path.find_last_of("/\\\\") + 1);
        chain_scene_setup(asset, [self, asset_name](Scene& scene) {
            attach_flow_graphs(scene, self, asset_name);
        });
    }` : ""}
    engine.assets.push_back(std::move(asset));
    return AssetHandle{static_cast<std::uint32_t>(engine.assets.size() - 1)};
}
${lowered.boneControlEntryPoints}${interactivity ? `
// KHR_interactivity's accessors over this asset's tables, the pin's
// path-converter.ts resolved against the loaded document: resolveVisibility
// reads \`node.visible !== false\` off the per-node flag, and writes through
// setSubtreeVisible (scene/visibility.ts) -- the cascade over the node's
// subtree, then the epoch bump that rebuilds the draw lists when a flag
// actually moved.
bool gltf_node_visible(const Engine& engine, AssetHandle asset_handle, std::size_t node) {
    const AssetRecord& asset = engine.assets.at(asset_handle.value);
    return node < asset.node_visible.size() ? asset.node_visible[node] : true;
}

namespace {

bool gltf_visibility_cascade(Engine& engine, AssetRecord& asset, std::size_t node, bool visible) {
    bool changed = asset.node_visible[node] != visible;
    asset.node_visible[node] = visible;
    for (const MeshHandle mesh : asset.node_meshes[node]) {
        engine.meshes[mesh.value].visible = visible;
    }
    for (const std::size_t child : asset.node_children[node]) {
        if (gltf_visibility_cascade(engine, asset, child, visible)) changed = true;
    }
    return changed;
}

} // namespace

void set_gltf_node_visible(Engine& engine, AssetHandle asset_handle, std::size_t node, bool visible) {
    AssetRecord& asset = engine.assets.at(asset_handle.value);
    if (node >= asset.node_visible.size()) {
        throw std::runtime_error("KHR_interactivity visibility pointer names a node the asset lacks.");
    }
    if (gltf_visibility_cascade(engine, asset, node, visible)) ++engine.draw_list_epoch;
}

// resolveMaterialUvTransform over the glTF material index: the base-colour
// slot of the KHR_texture_transform writer (the slot resolver above maps a
// pointer's slot to the record's per-slot transform; base colour is the
// one the reached graphs name). The reads take the transform's own lanes
// (\`tex?.uScale ?? 1\`, \`tex?.uOffset ?? 0\` are the record's identity
// defaults); a write is picked up by the next draw, which rebuilds the
// material's UV matrix from the record.
TextureTransform& gltf_base_color_transform(Engine& engine, AssetHandle asset_handle, std::size_t material) {
    const AssetRecord& asset = engine.assets.at(asset_handle.value);
    if (material >= asset.materials.size()) {
        throw std::runtime_error("KHR_interactivity material pointer names a material the asset lacks.");
    }
    return engine.materials.at(asset.materials[material].value).base_color_transform;
}
` : ""}} // namespace bbl
`;
}

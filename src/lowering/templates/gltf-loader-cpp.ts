import { DEFORMATION_BONE_SLOTS } from "../../shader-builtins-standard.js";
import { compressedTextureFormat } from "../../compressed-texture-format.js";
// The document key packaging names the converted Gaussian-splat rows under,
// from the module that owns the document schema both sides read.
import { GAUSSIAN_SPLAT_DOCUMENT_KEY, GLTF_MESH_WALKS, GLTF_SOURCE_ALBEDO_IDENTITIES, GLTF_VARIANT_PLAN, GLTF_MESH_PLAN } from "../../gltf-document.js";
import type { GltfLoaderOptions } from "../gltf-lowerer.js";
import {gltfAnimationRuntimeTypesCpp, gltfAnimationMatrixTransportCpp, gltfAnimationPoseTransportCpp, gltfAnimationLoadingCpp} from "../gltf/animation-runtime.js";
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
    animationStorage: string;
    animationMask: string;
    animationPlayback: string;
    animationPose: string;
    animationEvaluator: string;
    animationBoneOverrides: string;
    animationRootFlip: string;
    animationFactory: string;
    animationWeighted: string;
    animationWeightedTransport: {types: string; dispatcher: string};
    animationPointers: string;
    /** Complete pinned DataView component reader, including normalization. */
    accessorNormalization: string;
    /** Pinned accessor component counts and typed-array constructor widths. */
    accessorShape: string;
    hierarchy: string;
    parserJson: string;
    inverseBindMatrices: string;
    animationNodeRest: string;
    deformationState: string;
    animationBindings: string;
    materialAssembly: string;
    materialTextures: string;
    materialProperties: string;
    iblLoading: string;
    assetSceneSetup: string;
    gaussianSplatSetup: string;
    assetSceneSetupOrder: string[];
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
        nodeVisibility = false,
        interactivity = false,
        animationPointer = false,
        animatedWorldBounds = false,
        animationPointerMaterials = false,
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

    const factorBake = lowered.factorBake;
    return `// ${provenance}
#include <bblite/pal_gltf.hpp>
#include <bblite/pal_image_canvas.hpp>
#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
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
#include <set>
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

std::vector<double> double_array(const ts::JsonValue* value) {
    if (!value) return {};
    std::vector<double> result;
    for (const ts::JsonValue& element : value->as_array()) {
        result.push_back(element.as_number());
    }
    return result;
}

${lowered.animationNodeRest}

${lowered.assetSceneSetup}
${lowered.gaussianSplatSetup}

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

${gltfCameras ? `struct AnimatedCameraBinding { CameraHandle camera{}; std::size_t node=0; Matrix local{}; };` : ""}
${animationPointer ? `struct AnimatedLightBinding { LightHandle light{}; std::size_t node=0; };` : ""}

struct AnimatedNode {
    Vec3d translation{};
    Vec4d rotation{0.0, 0.0, 0.0, 1.0};
    Vec3d scale{1.0, 1.0, 1.0};
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
    std::size_t skeleton_binding = std::numeric_limits<std::size_t>::max();
    std::size_t morph_node = std::numeric_limits<std::size_t>::max();
    std::vector<Matrix> initial_joint_matrices;
    Matrix initial_mesh_world{};
};

${lowered.animationBindings}

${lowered.animationStorage}
${lowered.animationPlayback}
${lowered.animationMask}
${gltfAnimationRuntimeTypesCpp(options)}
${lowered.animationWeightedTransport.types}

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
${lowered.animationEvaluator}
${lowered.animationBoneOverrides}
${lowered.animationPose}
${lowered.animationFactory}
${lowered.animationWeighted}

Matrix identity_matrix() {
    Matrix result{};
    result[0] = result[5] = result[10] = result[15] = 1.0f;
    return result;
}

${gltfCameras ? lowered.gltfCameraParentWriter : ""}

${lowered.matrixLocal}

${lowered.matrixCompose}

${lowered.matrixNative}
${gltfAnimationMatrixTransportCpp()}

${lowered.deformationState}

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

${lowered.materialAssembly}
${lowered.materialTextures}

${lowered.materialProperties}
${gltfMaterialProjection(animationPointerMaterials)}
${lowered.animationPointers}

} // namespace

struct GltfAnimationRuntimeState { std::shared_ptr<AnimationRuntime> value; };
${lowered.animationWeightedTransport.dispatcher}

void run_pbr_scene_hooks(Scene& scene, const std::vector<MeshHandle>& meshes) {
    run_pbr_scene_hooks_impl(scene, meshes);
}
std::optional<bool> run_pbr_rebuild_transaction(Scene& scene, const std::vector<MeshHandle>& meshes,
    bool (*builder)(Scene&, const std::vector<MeshHandle>&)) {
    return run_pbr_rebuild_transaction_impl(scene, meshes, builder);
}

${gltfCameras ? `AssetHandle load_gltf(Engine& engine, const std::string& path) {
    return load_gltf(engine, path, false);
}

` : ""}AssetHandle load_gltf(Engine& engine, const std::string& path${gltfCameras ? ", bool load_cameras" : ""}) {
    ts::ArrayBuffer buffer = ts::await(pal::fetch_array_buffer(path));
${animationPointer ? `    const auto source_container=std::make_shared<const upstream::ParsedGlbContainer>(upstream::parse_glb_container(buffer));
    const auto& container=*source_container;` : "    const upstream::ParsedGlbContainer container = upstream::parse_glb_container(buffer);"}
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
    const auto& mesh_plan = required(document, "${GLTF_MESH_PLAN}").as_object();
    const auto& source_animation = required(mesh_plan, "animation");
    const bool animated = !source_animation.is_null() && required(source_animation.as_object(), "accepted").as_boolean();

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
    const auto& planned_materials = required(mesh_plan, "materials").as_array();
    const auto& planned_meshes = required(mesh_plan, "meshes").as_array();
    const auto& planned_geometries = required(mesh_plan, "geometries").as_array();
    std::vector<MaterialHandle> materials;
    materials.reserve(planned_materials.size());
${animationPointer ? "    std::vector<GltfPbrValue> source_physical_properties;" : ""}
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
    std::vector<bool> base_color_definitions(material_json.size(), false);
    for (const auto& index : required(mesh_plan, "baseColorDefinitions").as_array())
        base_color_definitions.at(unsigned_value(index)) = true;
    const bool base_color_module = required(mesh_plan, "baseColorModule").as_boolean();
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
${animationPointer ? "            source_physical_properties.emplace_back();" : ""}
            const auto& material = core_materials.at(unsigned_value(core_index));
            const auto source_material_index = material._rawMatDef ? static_cast<std::size_t>(material._rawMatDef - material_json.data()) : material_json.size();
            const auto handle = load_material(engine, gltf_material_object(material._rawMatDef), material, buffer, container, views,
                image_json, texture_json, sampler_json, extension_image_fetcher,
                source_material_index < base_color_definitions.size() && base_color_definitions[source_material_index],
                material_features, extended_material, material_texture_wrap, sampled_material, &material_texture_cache, &material_sampler_context,
                decode_material_image, false, ${animationPointer ? "&source_physical_properties.back()" : "nullptr"}, base_color_module);
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
                image_json, texture_json, sampler_json, variant_fetcher, base_color_definitions.at(index), material_features,
                true, material_texture_wrap, false, nullptr, &variant_sampler_context,
                decode_material_image, true, nullptr, base_color_module));
        }
    }

    const auto parents = build_gltf_parents(document);
    validate_gltf_parents(parents);

    AssetRecord asset;
    js::Callback<void(Scene&)> ibl_scene_setup;${gaussianSplats ? "\n    js::Callback<void(Scene&)> gaussian_splat_setup;" : ""}${interactivity ? "\n    js::Callback<void(Scene&)> interactivity_scene_setup;" : ""}${interactivity || animationPointer ? `
    // glTF node-to-mesh identities, filled by the mesh walk
    // below; the rest of the asset's tables join it once the document is
    // loaded (see the scene-setup chain).
    asset.node_meshes.resize(node_json.size());` : ""}
${lowered.iblLoading}${gaussianSplats ? `
    struct PreparedGltfSplat { std::string name; std::vector<std::uint8_t> rows; };
    const auto prepared_splats = std::make_shared<std::vector<PreparedGltfSplat>>();
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
            prepared_splats->push_back(PreparedGltfSplat{
                string_or(entry, "name"), std::vector<std::uint8_t>(rows, rows + view.length)});
        }
        const AssetHandle self{static_cast<std::uint32_t>(engine.assets.size())};
        gaussian_splat_setup = [self, prepared_splats](Scene& scene) {
            setup_gltf_gaussian_splats(scene, scene.engine->assets.at(self.value), *prepared_splats,
                [](Scene& target, const PreparedGltfSplat& item) {
                    const auto splat = create_gaussian_splatting_mesh(*target.engine, item.name, item.rows);
                    attach_gaussian_splatting_mesh(target, splat);
                    return splat;
                });
        };
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
` : ""}
    {
    const auto node_rest = gltf_animation_node_rest(document,
        [&](double index) { gltf_checked_index(index); return find_gltf_parent(parents, index); });
    animation_runtime->nodes.resize(node_rest.size());
    animation_runtime->source_nodes.reserve(node_rest.size());
    for (std::size_t index = 0; index < node_rest.size(); ++index) {
        const auto& rest = node_rest[index];
        GltfAnimationPoseNode source_node{rest.tx,rest.ty,rest.tz,rest.rx,rest.ry,rest.rz,rest.rw,rest.sx,rest.sy,rest.sz,rest.parentIdx,{}};
        if(rest.matrix&&!rest.matrix->is_null()){const auto matrix=gltf_matrix_from_json(rest.matrix);source_node.matrix=GltfAnimationFloats(matrix.begin(),matrix.end());}
        animation_runtime->source_nodes.push_back(std::move(source_node));
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
        animated_node.translation = Vec3d{rest.tx,rest.ty,rest.tz};
        animated_node.rotation = Vec4d{rest.rx,rest.ry,rest.rz,rest.rw};
        animated_node.scale = Vec3d{rest.sx,rest.sy,rest.sz};

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
    std::vector<std::size_t> animation_mesh_indices(planned_meshes.size(), std::numeric_limits<std::size_t>::max());
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
            const bool deformed_geometry = animated || planned_skin || planned_morph;
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
                vertex.position = deformed_geometry || instanced
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
                    vertex.normal = deformed_geometry || instanced
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
                    const Vec3 tangent = deformed_geometry || instanced
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
            geometry.vertex_space = deformed_geometry || instanced
                ? VertexSpace::mirrored_local
                : VertexSpace::world;
            if (deformed_geometry) {
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
            if (deformed_geometry) {
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
            if (deformed_geometry) {
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
                std::vector<Matrix> initial_joint_matrices;
                if (planned_skin) {
                    const auto& skin = planned_skin->as_object();
                    const auto bone_count = unsigned_value(required(skin, "boneCount"));
                    const auto& palette = accessors.at(unsigned_value(required(skin, "matrices")));
                    if (palette.type != "VEC4" || palette.component_type != 5126 || palette.count != bone_count * 4)
                        throw std::runtime_error("Invalid glTF initial bone palette storage.");
                    initial_joint_matrices.reserve(bone_count);
                    // Source computeBoneTextureData already performed both
                    // Float32 matrix products. Fold the source mesh world into
                    // that local palette for native's identity-world skin draw.
                    for (std::size_t bone = 0; bone < bone_count; ++bone)
                        initial_joint_matrices.push_back(upstream::matrix_product(mesh_world, read_matrix(palette, bone)));
                }
                publish_gltf_deformation(engine.meshes[mesh_record_index], engine.geometries.at(engine.meshes[mesh_record_index].geometry),
                    mesh_world, initial_joint_matrices, planned_skin != nullptr, morph_default_weights);
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
                animation_mesh_indices[gltf_mesh_counter] = animation_runtime->meshes.size();
                animation_runtime->meshes.push_back(
                    AnimatedMeshBinding{
                        mesh_record_index,
                        engine.meshes[mesh_record_index].geometry,
                        node_index,
                        skin_index,
                        std::move(morph_default_weights),
                        std::numeric_limits<std::size_t>::max(),
                        std::numeric_limits<std::size_t>::max(),
                        animated ? std::move(initial_joint_matrices) : std::vector<Matrix>{},
                        mesh_world,
                    });
            }
            asset.meshes.push_back(MeshHandle{mesh_record_index});${interactivity ? `
            // Source applyAsset annotates only meshes reached by its node map.
            const auto& flow_node = required(mesh_plan, "flowGraphNodes").as_array().at(gltf_mesh_counter);
            asset.mesh_nodes.push_back(flow_node.is_null()
                ? std::numeric_limits<std::size_t>::max() : unsigned_value(flow_node));` : ""}${interactivity || animationPointer ? `
            asset.node_meshes[node_index].push_back(MeshHandle{mesh_record_index});` : ""}
    }
${interactivity || animationPointer ? `
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
` : ""}
${animationPointer ? `    if(!source_animation.is_null()) {
        auto pointers=std::make_shared<GltfAnimationPointerRuntime>();
        pointers->engine=&engine;
        pointers->handles=materials;
        pointers->properties=std::move(source_physical_properties);
        pointers->document=GltfPbrValue{&container.json};
        pointers->node=[source_container,count=node_json.size()](std::size_t index) {
            if(index>=count)throw std::runtime_error("Invalid source animation node capture.");
            return GltfPbrValue{static_cast<double>(index)};
        };
        const auto self=AssetHandle{static_cast<std::uint32_t>(engine.assets.size())};
        pointers->effects.set_visibility=[self,&engine](GltfPbrValue node,GltfPbrValue visible) {
            set_gltf_node_visible(engine,self,gltf_checked_index(node.number()),visible.truthy());
            return GltfPbrValue{};
        };
        pointers->lookup_light=[punctual_lights](std::size_t index)->std::optional<LightHandle> {
            if(index>=punctual_lights.size()||punctual_lights[index].value==invalid_handle)return std::nullopt;
            return punctual_lights[index];
        };
        pointers->set_light_angle=[](Engine& target,LightHandle handle,double angle) {refresh_spot_light_cone(target.lights.at(handle.value),angle);};
        for(std::size_t index=0;index<loaded_lights.size();++index)
            pointers->add_light(loaded_lights[index],required(mesh_plan,"lights").as_array().at(index));
        pointers->configure_light_effects();
        pointers->initialize(required(source_animation.as_object(),"materialState"));
        animation_runtime->pointers=std::move(pointers);
    }` : ""}
    if (animated) {
${gltfAnimationLoadingCpp(options, lowered.animationRootFlip)}
${gltfAnimationPoseTransportCpp(options, lowered.gltfCameraPoseRefresh)}
${lowered.boneControlLoading}
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
    if (asset.meshes.empty()${gaussianSplats ? " && prepared_splats->empty()" : ""}) throw std::runtime_error("glTF contains no renderable meshes.");
    install_asset_scene_meshes(asset, double_array(&required(mesh_plan, "sceneMeshes")));
${sourceMeshWalks ? "    load_source_mesh_walks(asset, document);" : ""}${interactivity ? `
    // The source feature's actual applyAsset result owns graph activation,
    // construction order and accessor resolution.
    const auto& flow_graphs = required(mesh_plan, "flowGraphs").as_array();
    if (!flow_graphs.empty()) {
        const AssetHandle self{static_cast<std::uint32_t>(engine.assets.size())};
        for (const auto& graph : flow_graphs) {
            asset.flow_graphs.push_back(FlowGraphHandle{self, static_cast<std::uint32_t>(unsigned_value(required(graph.as_object(), "graphIndex")))});
        }
        asset.materials = source_materials;
        const std::string asset_name = path.substr(path.find_last_of("/\\\\") + 1);
        interactivity_scene_setup = [self, asset_name](Scene& scene) {
            attach_flow_graphs(scene, self, asset_name);
        };
    }` : ""}
    compose_gltf_scene_setup(asset, {${lowered.assetSceneSetupOrder.join(", ")}});
    engine.assets.push_back(std::move(asset));
    return AssetHandle{static_cast<std::uint32_t>(engine.assets.size() - 1)};
}
${lowered.boneControlEntryPoints}${interactivity || animationPointer ? `
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

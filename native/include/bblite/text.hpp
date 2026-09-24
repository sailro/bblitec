#pragma once

#include <bblite/runtime.hpp>
#include <array>
#include <cstddef>
#include <functional>
#include <memory>
#include <span>
#include <string>
#include <vector>
#include <variant>

namespace bbl {

/**
 * The pin's draw-group key (`CurveSetId | object`): a curve-set id, or an
 * object a styling feature interned, compared by identity. The two never
 * compare equal, as a string and an object never are.
 */
struct TextGroupKey {
    std::string curve_set_id;
    std::shared_ptr<const void> object;
    TextGroupKey() = default;
    TextGroupKey(std::string id) : curve_set_id(std::move(id)) {}
    TextGroupKey(const char* id) : curve_set_id(id) {}
    template <class T> TextGroupKey(std::shared_ptr<T> interned) : object(std::move(interned)) {}
    bool operator==(const TextGroupKey&) const = default;
    bool operator==(const std::string& id) const { return !object && curve_set_id == id; }
};
/**
 * `setFontWeightOffset` installed its style seam on this realm. Written by
 * the generated installer and read by both text renderers; realm state like
 * the other JavaScript-side flags, so a worker realm that renders text keeps
 * its own.
 */
inline thread_local bool text_weight_installed = false;
/** The pin's `SharedAtlasGpu`: the backend's leases for one atlas. */
struct TextAtlasGpuState {
    std::function<void()> destroy_curves;
    std::function<void()> destroy_bands;
    std::function<void()> destroy_metadata;
    std::shared_ptr<void> backend;
    const void* device_identity = nullptr;
    double curve_rows = 0;
    double band_rows = 0;
    double metadata_capacity = 0;
    double uploaded_version = -1;
};
// The pin's text records are emitted from its own declarations
// (`upstream_text_records.hpp`); these are their handles.
struct TextDataState;
using TextData = std::shared_ptr<TextDataState>;
struct GlyphRun;
using TextRun = std::shared_ptr<GlyphRun>;
using TextRunRef = std::variant<double, TextRun>;
struct TextLayoutFont;

struct TextQuaternion {
    double x = 0, y = 0, z = 0, w = 1;
};
struct TextRenderableOptions {
    std::optional<Vec3d> position;
    std::optional<TextQuaternion> rotation_quaternion;
    std::optional<Vec3d> scaling;
    std::optional<double> opacity;
    std::optional<bool> ignore_depth;
    std::optional<double> order;
};
// Resource callbacks are native backend leases, never source JS closures. A
// retained DrawBinding can keep this state after renderable disposal, as upstream.
struct TextGpuState {
    std::function<void()> destroy_uniform;
    std::function<void()> destroy_instances;
    std::function<void()> destroy_styles;
    double uploaded_camera_version = -1;
    double uploaded_aspect = -1;
    double uploaded_viewport_w = 0;
    double uploaded_viewport_h = 0;
    double uploaded_opacity = std::numeric_limits<double>::quiet_NaN();
    std::shared_ptr<void> backend;
    const void* device_identity = nullptr;
    std::string target_key;
    std::shared_ptr<void> pipeline;
    std::shared_ptr<void> variant_pipeline;
    double instance_capacity = 0;
    double style_buffer_bytes = 0;
    double uploaded_data_version = -1;
    double uploaded_style_version = -1;
};

enum class TextBufferKind { uniform, instances, styles };
enum class TextAtlasTextureKind { curves, bands };
struct TextPipelineBinding {
    std::shared_ptr<void> pipeline;
    std::shared_ptr<void> variant_pipeline;
    std::shared_ptr<void> layout;
    std::shared_ptr<void> quad;
};
struct TextTargetSignature {
    std::optional<std::string> color_format;
    std::optional<std::uint32_t> sample_count;
    std::optional<std::string> depth_format;
    std::optional<std::string> depth_compare = std::nullopt;
};
struct TextRenderableState {
    TextData data;
    Vec3d position;
    TextQuaternion rotation_quaternion;
    Vec3d scaling;
    Vec3d rotation;
    double quaternion_version = 0;
    double synced_quaternion_version = -1;
    double world_version = 0;
    bool world_cached = false;
    std::array<float, 16> world{};
    bool wm_dirty = true;
    double opacity = 1;
    bool ignore_depth = false;
    double order = 200;
    bool is_transparent = true;
    bool alpha_to_coverage = false;
    double version = 0;
    std::shared_ptr<TextGpuState> gpu;
};
using TextRenderable = std::shared_ptr<TextRenderableState>;

struct TextCameraInput {
    const std::array<float, 16>& view_projection;
    double change_key;
    double effective_aspect;
};
using TextUniformWrite = std::function<void(std::size_t, std::span<const std::uint8_t>)>;

} // namespace bbl

template <> struct std::hash<bbl::TextGroupKey> {
    std::size_t operator()(const bbl::TextGroupKey& key) const noexcept {
        return std::hash<std::string>{}(key.curve_set_id) ^
               (std::hash<const void*>{}(key.object.get()) << 1);
    }
};

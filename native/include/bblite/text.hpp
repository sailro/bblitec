#pragma once

#include <bblite/runtime.hpp>
#include <bblite/text_gpu.hpp>
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
// The pin's text records are emitted from its own declarations
// (`upstream_text_records.hpp`); these are their handles.
struct TextDataState;
using TextData = std::shared_ptr<TextDataState>;
struct GlyphRun;
using TextRun = std::shared_ptr<GlyphRun>;
using TextRunRef = std::variant<double, TextRun>;
struct TextLayoutFont;
struct TextRenderableGpu;

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
/** The pin's `RenderTargetSignature`, as a scene pass describes its target. */
struct TextTargetSignature {
    std::optional<std::string> color_format;
    std::optional<std::string> depth_format;
    std::optional<std::string> depth_compare;
    double sample_count = 1;
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
    js::TypedArray<float> world = js::TypedArray<float>(16);
    bool wm_dirty = true;
    double opacity = 1;
    bool ignore_depth = false;
    double order = 200;
    bool is_transparent = true;
    double version = 0;
    std::shared_ptr<TextRenderableGpu> gpu;
};
using TextRenderable = std::shared_ptr<TextRenderableState>;

/** The scene camera as the pin's text uniform update reads it. */
struct TextCameraInput {
    js::TypedArray<float> view_projection;
    double change_key = 0;
    double effective_aspect = 0;
};
using TextCameraInputPointer = const TextCameraInput*;
/** The pin's `DrawUpdateContext` for a text renderable. */
struct TextDrawUpdateContext {
    TextCameraInputPointer camera = nullptr;
    double target_width = 0;
    double target_height = 0;
};

} // namespace bbl

template <> struct std::hash<bbl::TextGroupKey> {
    std::size_t operator()(const bbl::TextGroupKey& key) const noexcept {
        return std::hash<std::string>{}(key.curve_set_id) ^
               (std::hash<const void*>{}(key.object.get()) << 1);
    }
};

#pragma once

#include <bblite/features/has_text.hpp>
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
struct TextRenderableState;
using TextRenderable = std::shared_ptr<TextRenderableState>;

/** The pin's `RenderTargetSignature`, as a scene pass describes its target. */
struct TextTargetSignature {
    bbl::js::Nullable<std::string> color_format;
    bbl::js::Nullable<std::string> depth_format;
    bbl::js::Nullable<std::string> depth_compare;
    double sample_count = 1;
};

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

/**
 * The pin's `DrawBinding` (`render/renderable.ts` is type-only, so the
 * port declares it): what a text renderable's `bind` returns, whose
 * `update` and `draw` are the pin's own closures.
 */
struct TextDrawBinding {
    TextRenderable renderable;
    TextGpuHandle pipeline;
    js::Callback<double(TextGpuEncoderHandle, TextSurfaceHandle)> draw;
    js::Callback<void(TextDrawUpdateContext)> update;
};
using TextDrawBindingHandle = std::shared_ptr<TextDrawBinding>;

/**
 * The pin's `IWorldMatrixProvider` (`scene/parentable.ts` is type-only):
 * a text renderable's world state is never parented, so nothing the
 * lowered program runs constructs one.
 */
struct WorldMatrixProvider {
    js::TypedArray<float> world_matrix;
    double world_matrix_version = 0;
};

#if BBLITE_HAS_TEXT
/**
 * `addDeferredSceneRenderables` over the native scene: its deferred-builder
 * queue runs the pin's builder after construction, publishes the text
 * renderables the builder returned and adopts its disposer. The builder's
 * failure rejects the scene's registration, as the pin's async builder does.
 */
template <class Build> void add_deferred_text_renderables(Scene& scene, Build build) {
    if (scene.disposed)
        throw std::runtime_error(
            "Text attachment after scene disposal requires the pinned async late-cleanup "
            "lifecycle.");
    const std::weak_ptr<SceneState> owner = scene.state;
    scene.deferred_builders.emplace_back(
        [owner, build = std::move(build)] {
            const auto state = owner.lock();
            if (!state)
                return;
            const auto built = build();
            for (const auto& renderable : built.renderables)
                state->text_renderables.push_back(renderable);
            if (built.dispose)
                state->disposables.push_back(built.dispose);
        },
        SceneDeferredFailure::promise_rejection);
}
#endif

} // namespace bbl

template <> struct std::hash<bbl::TextGroupKey> {
    std::size_t operator()(const bbl::TextGroupKey& key) const noexcept {
        return std::hash<std::string>{}(key.curve_set_id) ^
               (std::hash<const void*>{}(key.object.get()) << 1);
    }
};

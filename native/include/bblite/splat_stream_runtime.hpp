#pragma once

// The engine, scene and render-task objects the lowered splat-stream library
// (src/lowering/splat-stream-library.ts) reaches, over the native ones: the
// engine is a `StoredEngine` whose `_device` is `Engine::webgpu_device` and
// whose `_currentEncoder` is the encoder a scene pass names while its
// external renderables' batches flush (pal_external_renderables.hpp); a
// scene is its shared `SceneState`; a renderable, its bindings and their
// update batches implement `gpu_renderable.hpp`, which the scene pass drives
// with render-task-base.ts's protocol. The camera math and the scene node's
// world matrix are the generated pinned functions (the library header).

#include <bblite/gpu.hpp>
#include <bblite/gpu_renderable.hpp>
#include <bblite/js_abort.hpp>
#include <bblite/js_callback.hpp>
#include <bblite/js_data.hpp>
#include <bblite/js_gc.hpp>
#include <bblite/pal_gpu_retirement.hpp>
#include <bblite/pal_source_gpu.hpp>
#include <bblite/runtime.hpp>
#include <bblite/splat_stream_platform.hpp>

#include <cstddef>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace bbl::splat_stream_platform {

// The platform beyond the transport's seam (splat_stream_platform.hpp) that
// the loader reaches: the manifest's streaming UTF-8 decode, and the
// application's own AbortSignal passed as a stream option.

/** `{ fatal, ignoreBOM }` of `new TextDecoder(label, options)`. */
struct TextDecoderOptions {
    js::Nullable<bool> fatal;
    js::Nullable<bool> ignore_bom;
};
/** `{ stream }` of `decoder.decode(input, options)`. */
struct TextDecodeOptions {
    js::Nullable<bool> stream;
};
/** `new TextDecoder(label, options)`: UTF-8 only (a RangeError for another label). */
[[nodiscard]] TextDecoder text_decoder_create(const std::string& label,
                                              const js::Nullable<TextDecoderOptions>& options);
/** `decoder.decode(input, { stream })`. */
[[nodiscard]] std::string text_decoder_decode(const TextDecoder& decoder,
                                              const js::TypedArray<std::uint8_t>& bytes,
                                              const js::Nullable<TextDecodeOptions>& options);
/** `decoder.decode()`: the end of a stream. */
[[nodiscard]] std::string text_decoder_flush(const TextDecoder& decoder);
/** The library's handle on an application AbortSignal (the same signal object). */
[[nodiscard]] AbortSignal abort_signal_of(const js::AbortSignal& signal);

} // namespace bbl::splat_stream_platform

namespace bbl {

/** A `SceneContext` the library holds: the scene's shared state, by identity. */
using SplatStreamScene = std::shared_ptr<SceneState>;
/** A scene pass's `RenderTargetSignature`: one object per distinct signature. */
using SplatStreamTargetSignature = std::shared_ptr<GpuRenderTargetSignature>;

} // namespace bbl

namespace bbl::splat_stream {

/** `stats.error`: the record stores `Error | null` as an empty js::Error for null. */
[[nodiscard]] inline js::Nullable<js::Error> stats_error(const js::Error& error) {
    return error.identity() ? js::Nullable<js::Error>(error) : js::Nullable<js::Error>();
}

// ── Engine ─────────────────────────────────────────────────────────────

/** `engine._device`: the WebGPU subset the engine has from createEngine on. */
[[nodiscard]] inline GpuDeviceHandle engine_device(const StoredEngine& engine) {
    auto& owner = *engine;
    if (!owner.webgpu_device || owner.device_disposed)
        throw std::runtime_error("The engine has no WebGPU device for the splat stream.");
    return owner.webgpu_device;
}

/** `engine._currentEncoder`: the frame encoder while a scene pass flushes its batches. */
[[nodiscard]] inline GpuCommandEncoderHandle engine_encoder(const StoredEngine& engine) {
    auto& owner = *engine;
    if (!owner.current_encoder)
        throw std::runtime_error(
            "engine._currentEncoder is read outside a scene pass's batch flush.");
    return owner.current_encoder;
}

/** `retireGpuResources(engine, retirement)`: runs once the next submission drains. */
inline void retire_gpu_resources(const StoredEngine& engine, js::Callback<void()> retirement) {
    bbl::retire_gpu_resources(pal::gpu_retirement_state(*engine),
                              [retirement = std::move(retirement)] { retirement(); });
}

// ── Scene ──────────────────────────────────────────────────────────────

/** `scene.surface.engine`. */
[[nodiscard]] inline StoredEngine scene_engine(const SplatStreamScene& scene) {
    if (!scene || !scene->engine)
        throw std::runtime_error("The splat stream's scene has no engine.");
    return StoredEngine(*scene->engine);
}

// ── Camera ─────────────────────────────────────────────────────────────

/** The camera a scene pass draws with: its record in its engine. */
struct Camera {
    Engine* engine = nullptr;
    CameraHandle handle{};
    [[nodiscard]] CameraRecord& record() const {
        if (!engine)
            throw std::runtime_error("A splat-stream camera has no engine.");
        return handle_at(engine->cameras, handle);
    }
};

/** The pin's `DrawUpdateContext`. */
struct DrawContext {
    double target_width = 0;
    double target_height = 0;
    js::Nullable<Camera> camera;
};

[[nodiscard]] inline bool camera_ortho(const Camera& camera) {
    return camera.record().orthographic;
}
[[nodiscard]] inline js::Nullable<NormalizedViewport> camera_viewport(const Camera& camera) {
    const auto& viewport = camera.record().viewport;
    return viewport ? js::Nullable<NormalizedViewport>(*viewport) : std::nullopt;
}
[[nodiscard]] inline double camera_near_plane(const Camera& camera) {
    return camera.record().near_plane;
}

// ── Render tasks ───────────────────────────────────────────────────────

/** The scene's group-0 layout while a renderable binds (`getSceneBindGroupLayout`). */
inline GpuHandle& bound_scene_layout() {
    thread_local GpuHandle layout;
    return layout;
}
[[nodiscard]] inline GpuHandle scene_bind_group_layout() {
    if (!bound_scene_layout())
        throw std::runtime_error("getSceneBindGroupLayout is called outside a renderable's bind.");
    return bound_scene_layout();
}

/** The pin's `DrawUpdateBatch`, whose members are the lowered literal's. */
struct DrawUpdateBatch : GpuDrawUpdateBatch {
    bool retired_flag = false;
    js::Callback<void()> reset_callback;
    js::Callback<void(StoredEngine)> flush_callback;
    js::Callback<void()> destroy_callback;
    /** The engine the batch's binding was bound on, which `flush(engine)` names. */
    StoredEngine flush_engine;

    bool retired() const override { return retired_flag; }
    void mark_retired() override { retired_flag = true; }
    void reset() override { reset_callback(); }
    void flush() override { flush_callback(flush_engine); }
    void destroy() override { destroy_callback(); }
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(reset_callback);
        visitor(flush_callback);
        visitor(destroy_callback);
    }
};

struct Renderable;

/** The pin's `DrawBinding`. */
struct DrawBinding final : GpuDrawBinding {
    std::shared_ptr<Renderable> renderable;
    GpuHandle pipeline_value;
    js::Callback<void(DrawContext)> update_callback;
    js::Callback<double(GpuEncoderHandle, StoredEngine)> draw_callback;
    js::Nullable<js::Array<std::shared_ptr<DrawUpdateBatch>>> update_batch_list;
    StoredEngine bound_engine;

    GpuHandle pipeline() const override { return pipeline_value; }
    void update(const GpuDrawUpdateContext& context) override {
        if (!update_callback)
            return;
        update_callback(DrawContext{
            context.target_width, context.target_height,
            context.camera ? js::Nullable<Camera>(Camera{&*bound_engine, *context.camera})
                           : std::nullopt});
    }
    double draw(const GpuEncoderHandle& pass) override { return draw_callback(pass, bound_engine); }
    std::vector<GpuDrawUpdateBatchHandle> update_batches() const override {
        std::vector<GpuDrawUpdateBatchHandle> batches;
        if (update_batch_list)
            for (const auto& batch : *update_batch_list)
                batches.push_back(batch);
        return batches;
    }
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(renderable);
        visitor(update_callback);
        visitor(draw_callback);
        visitor(update_batch_list);
    }
};

/**
 * The pin's `Renderable`, drawn in the scene's own pass: `bind(engine,
 * signature)` per published version and signature, with one signature object
 * per distinct value (the render task's own signature), and the scene's
 * group-0 layout for `getSceneBindGroupLayout` while it binds.
 */
struct Renderable final : GpuExternalRenderable {
    double order_value = 0;
    bool is_transparent = false;
    js::Callback<std::shared_ptr<DrawBinding>(StoredEngine, SplatStreamTargetSignature)>
        bind_callback;
    /** The engine whose scene published it. */
    StoredEngine bound_engine;

    double order() const override { return order_value; }
    bool transparent() const override { return is_transparent; }
    GpuDrawBindingHandle bind(const GpuHandle& scene_layout,
                              const GpuRenderTargetSignature& signature) override {
        if (!signature_ || *signature_ != signature)
            signature_ = std::make_shared<GpuRenderTargetSignature>(signature);
        struct Layout {
            GpuHandle previous = std::exchange(bound_scene_layout(), GpuHandle{});
            ~Layout() { bound_scene_layout() = std::move(previous); }
        } scope;
        bound_scene_layout() = scene_layout;
        auto binding = bind_callback(bound_engine, signature_);
        if (!binding)
            throw std::runtime_error("A splat-stream renderable's bind returned no binding.");
        binding->bound_engine = bound_engine;
        if (binding->update_batch_list)
            for (const auto& batch : *binding->update_batch_list)
                batch->flush_engine = bound_engine;
        return binding;
    }
    void gc_trace(const js::TraceVisitor& visitor) const override { visitor(bind_callback); }

private:
    SplatStreamTargetSignature signature_;
};

/** `signature._colorFormat`. */
[[nodiscard]] inline js::Nullable<std::string>
signature_color_format(const SplatStreamTargetSignature& signature) {
    return signature->color_format;
}

/** What a deferred builder publishes. */
struct DeferredRenderables {
    js::Array<std::shared_ptr<Renderable>> renderables;
    js::Callback<void()> dispose;
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(renderables);
        visitor(dispose);
    }
};

/**
 * scene-core.ts `addDeferredSceneRenderables`: the builder runs when the
 * scene builds, its renderables join the scene pass's external renderables
 * and its disposer the scene's disposables.
 */
inline void add_deferred_scene_renderables(
    const SplatStreamScene& scene,
    js::Callback<DeferredRenderables(StoredEngine, SplatStreamScene)> build) {
    auto view = Scene::from_state(scene);
    const std::weak_ptr<SceneState> owner = scene;
    bbl::add_deferred_scene_renderables(view, [owner, build = std::move(build)](SceneState& state) {
        const auto shared = owner.lock();
        if (!shared || !state.engine)
            return;
        const StoredEngine engine(*state.engine);
        auto built = build(engine, shared);
        for (const auto& renderable : built.renderables) {
            renderable->bound_engine = engine;
            state.external_renderables.push_back(renderable);
        }
        if (built.dispose)
            state.disposables.push_back(built.dispose);
    });
}

// ── Scene node ─────────────────────────────────────────────────────────

/**
 * The TRS triple `initSceneNodeTransform` adds to the stream (scene-node.ts):
 * the quaternion is the source of truth, the Euler triple the proxy's cache
 * of the last value it applied, kept while the quaternion's version stays.
 */
struct SceneNode {
    std::string name;
    js::Array<std::shared_ptr<const void>> children;
    Vec3d position{};
    Vec3d scaling{1, 1, 1};
    Vec3d rotation{};
    Vec4d rotation_quaternion{0, 0, 0, 1};
    double quaternion_version = 0;
    double synced_quaternion_version = -1;
};

} // namespace bbl::splat_stream

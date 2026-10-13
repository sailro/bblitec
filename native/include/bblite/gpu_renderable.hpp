#pragma once

#include <bblite/gpu.hpp>

#include <array>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace bbl {

/**
 * The pin's `RenderTargetSignature` for a scene pass, in WebGPU names: the
 * formats a renderable's `bind` builds its pipelines against. The scene's
 * own pass names no depth compare; its pipelines default it.
 */
struct GpuRenderTargetSignature {
    std::string color_format;
    bbl::js::Nullable<std::string> depth_stencil_format;
    bbl::js::Nullable<std::string> depth_compare;
    double sample_count = 1;
    friend bool operator==(const GpuRenderTargetSignature&,
                           const GpuRenderTargetSignature&) = default;
};

/** The pin's `DrawUpdateContext`: the pass's target extent and camera (`_camera`). */
struct GpuDrawUpdateContext {
    double target_width = 0;
    double target_height = 0;
    std::optional<CameraHandle> camera;
};

/** The pin's `DrawUpdateBatch`. */
struct GpuDrawUpdateBatch {
    GpuDrawUpdateBatch() = default;
    GpuDrawUpdateBatch(const GpuDrawUpdateBatch&) = delete;
    GpuDrawUpdateBatch& operator=(const GpuDrawUpdateBatch&) = delete;
    virtual ~GpuDrawUpdateBatch() = default;
    /** `_retired`; false for a batch without the member. */
    virtual bool retired() const = 0;
    /** `_retired = true`, for a batch that has the member. */
    virtual void mark_retired() = 0;
    virtual void reset() = 0;
    /** `flush(engine)`: records into `Engine::current_encoder`. */
    virtual void flush() = 0;
    virtual void destroy() = 0;
};
using GpuDrawUpdateBatchHandle = std::shared_ptr<GpuDrawUpdateBatch>;

/** The pin's `DrawBinding`. */
struct GpuDrawBinding {
    GpuDrawBinding() = default;
    GpuDrawBinding(const GpuDrawBinding&) = delete;
    GpuDrawBinding& operator=(const GpuDrawBinding&) = delete;
    virtual ~GpuDrawBinding() = default;
    virtual GpuHandle pipeline() const = 0;
    /** `update?.(context)`. */
    virtual void update(const GpuDrawUpdateContext& context) = 0;
    /** `draw(pass, engine)`: the draws it issued. */
    virtual double draw(const GpuEncoderHandle& pass) = 0;
    /** `_updateBatches`. */
    virtual std::vector<GpuDrawUpdateBatchHandle> update_batches() const = 0;
};
using GpuDrawBindingHandle = std::shared_ptr<GpuDrawBinding>;

/**
 * A lowered `Renderable` the scene renderers draw in a scene's own pass
 * (`SceneState::external_renderables`), with render-task-base.ts's protocol
 * (`pal_external_renderables.hpp`): `bind(engine, signature)` per target
 * signature and published renderable version; before each pass every
 * binding's batches reset, `update(context)` runs, and the batches flush
 * into the frame encoder, ahead of `beginRenderPass`; inside the pass each
 * binding draws at its place in the transparent bucket
 * (`pal_transparent_order.hpp`), after group 0 and its pipeline are set.
 * Lowered engine code reaches `Engine::webgpu_device` and the engine's
 * scene layout (`bind_engine_scene_group`).
 */
struct GpuExternalRenderable {
    GpuExternalRenderable() = default;
    GpuExternalRenderable(const GpuExternalRenderable&) = delete;
    GpuExternalRenderable& operator=(const GpuExternalRenderable&) = delete;
    virtual ~GpuExternalRenderable() = default;
    /** `order`. */
    virtual double order() const = 0;
    /** `isTransparent`. */
    virtual bool transparent() const = 0;
    /** `_worldCenter`, which sorts the binding; absent for a renderable without one. */
    virtual std::optional<std::array<double, 3>> world_center() const = 0;
    /** `bind(engine, signature)`. */
    virtual GpuDrawBindingHandle bind(const GpuRenderTargetSignature& signature) = 0;
    /** Edges into lowered records and closures the renderable retains. */
    virtual void gc_trace(const js::TraceVisitor&) const {}
};
using GpuExternalRenderableHandle = std::shared_ptr<GpuExternalRenderable>;

/**
 * `getSceneBindGroupLayout(engine)` and the group a scene pass binds at 0
 * before an external renderable draws: an empty layout and group on both
 * backends, made once with the engine's WebGPU device. A renderable
 * pipeline whose shader reads the scene's group 0 fails its device's
 * validation (Dawn) or binding resolution (SDL_GPU).
 */
inline void bind_engine_scene_group(Engine& engine) {
    if (engine.webgpu_scene_layout)
        return;
    if (!engine.webgpu_device)
        throw std::runtime_error("The engine has no WebGPU device for its scene layout.");
    engine.webgpu_scene_layout = engine.webgpu_device->create_bind_group_layout({});
    engine.webgpu_scene_group =
        engine.webgpu_device->create_bind_group({{}, engine.webgpu_scene_layout, {}});
}

} // namespace bbl

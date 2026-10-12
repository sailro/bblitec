#pragma once

#include <bblite/gpu.hpp>

#include <memory>
#include <optional>
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
 * into the frame encoder, ahead of `beginRenderPass`; inside the pass, with
 * the scene's group 0 bound, each binding's pipeline is set and its `draw`
 * runs. Lowered engine code reaches `Engine::webgpu_device`.
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
    /** `bind(engine, signature)`; `scene_layout` is `getSceneBindGroupLayout(engine)`. */
    virtual GpuDrawBindingHandle bind(const GpuHandle& scene_layout,
                                      const GpuRenderTargetSignature& signature) = 0;
    /** Edges into lowered records and closures the renderable retains. */
    virtual void gc_trace(const js::TraceVisitor&) const {}
};
using GpuExternalRenderableHandle = std::shared_ptr<GpuExternalRenderable>;

} // namespace bbl

#pragma once

#include <bblite/gpu.hpp>

#include <array>
#include <cstdint>
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
/**
 * A pass's signature object, which every renderable's `bind` receives: one
 * per pass while its value holds, as a render task keeps its own
 * `_targetSignature`, so a library keying state by it shares that state
 * across the pass's renderables.
 */
using GpuRenderTargetSignatureHandle = std::shared_ptr<const GpuRenderTargetSignature>;

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
 * binding draws at its place in the opaque or transparent bucket
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
    virtual GpuDrawBindingHandle bind(const GpuRenderTargetSignatureHandle& signature) = 0;
    /** Edges into lowered records and closures the renderable retains. */
    virtual void gc_trace(const js::TraceVisitor&) const {}
    /**
     * Its place in the scene's `_renderables` walk, numbered from
     * `Engine::source_output_identity` as it joined, as the scene's material
     * outputs are: 0 when it joined without one.
     */
    std::uint64_t publication = 0;
};
using GpuExternalRenderableHandle = std::shared_ptr<GpuExternalRenderable>;

/**
 * `scene._renderables.splice(start, count, ...inserted)` over the external
 * renderables: an inserted renderable takes the place, and so the
 * `_renderables` position, of the one it replaces; one past those would
 * fall between two published positions, which no number names.
 */
template <class Inserted>
void scene_list_splice(std::vector<GpuExternalRenderableHandle>& list, double start, double count,
                       const Inserted& inserted) {
    if (static_cast<double>(inserted.size()) > count)
        throw std::runtime_error("Inserting more renderables than a splice removes needs a "
                                 "position between published ones.");
    std::vector<std::uint64_t> replaced;
    for (std::size_t index = 0; index < inserted.size(); ++index)
        replaced.push_back(list.at(static_cast<std::size_t>(start) + index)->publication);
    scene_list_splice(list, start, count);
    std::size_t index = 0;
    for (const auto& renderable : inserted) {
        renderable->publication = replaced[index];
        list.insert(list.begin() + static_cast<std::ptrdiff_t>(start + index++), renderable);
    }
}

/**
 * `getSceneBindGroupLayout(engine)`, made once with the engine's WebGPU
 * device over the scene build's uniform rows
 * (`Engine::webgpu_scene_uniform_bindings`): the pin's scene block and
 * lights, which each pass writes for its external renderables
 * (`pal_external_renderables.hpp`). Without rows the layout is empty and
 * one empty group serves every pass; a renderable pipeline whose shader
 * reads the scene's group 0 then fails its device's validation (Dawn) or
 * binding resolution (SDL_GPU).
 */
inline void bind_engine_scene_group(Engine& engine) {
    if (engine.webgpu_scene_layout)
        return;
    if (!engine.webgpu_device)
        throw std::runtime_error("The engine has no WebGPU device for its scene layout.");
    js::Array<GpuBindGroupLayoutEntry> entries;
    for (const auto& [binding, visibility] : engine.webgpu_scene_uniform_bindings)
        entries.push_back(GpuBindGroupLayoutEntry{
            binding, visibility, GpuBufferBindingLayout{std::string("uniform"), {}, {}}, {}, {}});
    engine.webgpu_scene_layout = engine.webgpu_device->create_bind_group_layout({{}, entries});
    if (entries.empty())
        engine.webgpu_scene_group =
            engine.webgpu_device->create_bind_group({{}, engine.webgpu_scene_layout, {}});
}

} // namespace bbl

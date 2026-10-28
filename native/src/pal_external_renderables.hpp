#pragma once

#include <bblite/gpu_renderable.hpp>
#include <bblite/pal_gpu_retirement.hpp>
#include <bblite/pal_source_gpu.hpp>

#include "pal_webgpu_usage.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <memory>
#include <span>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace bbl::pal {

/**
 * render-task-base.ts for a scene pass's external renderables
 * (`SceneState::external_renderables`, gpu_renderable.hpp), which
 * external-renderable-contract.ts pins: `follow` is `_buildBindings` when
 * the scene's published renderable version or the pass's target signature
 * moved, with draw-update-batches.ts's batch collection and release;
 * `prepare` is the update half of `prepareRenderTaskPass` (batch reset,
 * binding updates, batch flush, recorded into the frame encoder before the
 * pass begins); `draw` is one binding of `drawList` at its place in the
 * pass's opaque or transparent bucket (`pal_transparent_order.hpp`), after
 * group 0.
 */
class ExternalRenderablePass {
public:
    bool empty() const { return bindings_.empty(); }
    std::size_t size() const { return bindings_.size(); }
    /** The renderable bound at `index`, whose `order` and `_worldCenter` sort its binding. */
    const GpuExternalRenderable& renderable(std::size_t index) const {
        return *bindings_.at(index).renderable;
    }

    void follow(Engine& engine, const Scene& scene, const GpuRenderTargetSignature& signature) {
        if (bound_ && version_ == scene.state->renderable_version && signature_ == signature)
            return;
        std::vector<Bound> bindings;
        std::vector<GpuDrawUpdateBatchHandle> batches;
        try {
            for (const auto& renderable : scene.state->external_renderables) {
                auto binding = renderable->bind(signature);
                if (!binding)
                    throw std::runtime_error("An external renderable's bind returned no binding.");
                // `collectBatches`: each batch once, in binding order.
                for (auto& batch : binding->update_batches())
                    if (std::find(batches.begin(), batches.end(), batch) == batches.end())
                        batches.push_back(std::move(batch));
                bindings.push_back({renderable, std::move(binding)});
            }
        } catch (...) {
            // `generation._batchState?._release(undefined, [previousBatchState])`.
            release(nullptr, batches, batches_);
            throw;
        }
        auto previous = std::exchange(batches_, std::move(batches));
        bindings_ = std::move(bindings);
        version_ = scene.state->renderable_version;
        signature_ = signature;
        bound_ = true;
        // `previousBatchState?._release(task.engine, [generation._batchState])`.
        release(&engine, previous, batches_);
    }

    /** Records into `encoder`, which `Engine::current_encoder` names while the batches flush. */
    void prepare(Engine& engine, const GpuDrawUpdateContext& context,
                 const GpuCommandEncoderHandle& encoder) {
        if (bindings_.empty())
            return;
        struct CurrentEncoder {
            Engine& engine;
            ~CurrentEncoder() { engine.current_encoder.reset(); }
        } current{engine};
        engine.current_encoder = encoder;
        for (const auto& batch : batches_)
            batch->reset();
        for (const auto& bound : bindings_)
            bound.binding->update(context);
        for (const auto& batch : batches_)
            batch->flush();
    }

    /**
     * The pin's group 0 for this pass (`refreshTaskSceneBindGroup` over
     * `_writePassSceneUBO`): the pass's scene block and the scene's lights,
     * written into this pass's own uniform buffers on the engine's device and
     * bound by the engine's scene layout, in its rows' order. A layout without
     * rows needs neither: the engine's one group serves.
     */
    void write_scene_group(Engine& engine, std::span<const std::uint8_t> scene_block,
                           std::span<const std::uint8_t> lights) {
        const auto& rows = engine.webgpu_scene_uniform_bindings;
        if (rows.empty())
            return;
        if (rows.size() != 2)
            throw std::runtime_error("The scene layout is the scene block and the lights.");
        auto& device = *engine.webgpu_device;
        const auto write = [&](GpuHandle& buffer, std::span<const std::uint8_t> bytes) {
            if (!buffer) {
                GpuBufferDescriptor descriptor;
                descriptor.size = static_cast<double>(bytes.size());
                descriptor.usage = webgpu_buffer_usage::uniform | webgpu_buffer_usage::copy_dst;
                buffer = device.create_buffer(descriptor);
            }
            device.write_buffer(buffer, 0, bytes);
        };
        write(scene_buffer_, scene_block);
        write(lights_buffer_, lights);
        if (!scene_group_)
            scene_group_ = device.create_bind_group(
                {{},
                 engine.webgpu_scene_layout,
                 {GpuBindGroupEntry{rows[0].first, GpuBufferBinding{scene_buffer_, {}, {}}},
                  GpuBindGroupEntry{rows[1].first, GpuBufferBinding{lights_buffer_, {}, {}}}}});
    }

    /**
     * The binding at `index`, at its place in the pass's opaque or
     * transparent bucket: group 0 is this pass's scene group
     * (`write_scene_group`) or the engine's, then its pipeline. Returns the
     * draws it issued.
     */
    double draw(const GpuEncoderHandle& pass, const Engine& engine, std::size_t index) const {
        auto& binding = *bindings_.at(index).binding;
        pass->set_bind_group(0, engine.webgpu_scene_uniform_bindings.empty()
                                    ? GpuHandle(engine.webgpu_scene_group)
                                    : scene_group_);
        pass->set_pipeline(binding.pipeline());
        return binding.draw(pass);
    }

    /** The renderer's end: its bindings' batches retire behind the GPU. */
    void release(Engine& engine) {
        auto previous = std::exchange(batches_, {});
        bindings_.clear();
        bound_ = false;
        release(&engine, previous, {});
    }

private:
    struct Bound {
        GpuExternalRenderableHandle renderable;
        GpuDrawBindingHandle binding;
    };

    /**
     * `releaseBatches`: `batches` that are neither retired nor `retained`
     * retire, behind the GPU with an engine and at once without one, each
     * destroyed as `runGpuResourceDisposers` does.
     */
    static void release(Engine* engine, const std::vector<GpuDrawUpdateBatchHandle>& batches,
                        const std::vector<GpuDrawUpdateBatchHandle>& retained) {
        auto disposers = std::make_shared<std::vector<GpuRetirement>>();
        for (const auto& batch : batches)
            if (!batch->retired() &&
                std::find(retained.begin(), retained.end(), batch) == retained.end()) {
                batch->mark_retired();
                disposers->push_back([batch] { batch->destroy(); });
            }
        if (disposers->empty())
            return;
        if (engine)
            retire_gpu_resources(gpu_retirement_state(*engine),
                                 [disposers] { run_gpu_resource_callbacks(disposers); });
        else
            run_gpu_resource_callbacks(disposers);
    }

    std::vector<Bound> bindings_;
    std::vector<GpuDrawUpdateBatchHandle> batches_;
    GpuRenderTargetSignature signature_;
    std::uint64_t version_ = 0;
    bool bound_ = false;
    GpuHandle scene_buffer_;
    GpuHandle lights_buffer_;
    GpuHandle scene_group_;
};

/**
 * A pass the scene's external renderables do not draw in natively (`what`)
 * refuses a scene that has some, rather than drawing it without them.
 */
inline void refuse_external_renderables(const Scene& scene, const char* what) {
    if (!scene.state->external_renderables.empty())
        throw std::runtime_error(std::string("External renderables in ") + what +
                                 " are not lowered.");
}

/**
 * A scene renderer's external passes: the scene's own, and each render
 * task's colour pass by task handle, as render-task-base.ts binds the
 * scene's renderables per task, for its target. A disposed task's pass
 * releases its bindings (`release_disposed`); the table only grows, so a
 * handle names one task for the run.
 */
class ExternalRenderablePasses {
public:
    ExternalRenderablePass scene;

    ExternalRenderablePass& task(TaskHandle handle) {
        if (handle.value >= tasks_.size())
            tasks_.resize(static_cast<std::size_t>(handle.value) + 1u);
        return tasks_[handle.value];
    }

    /** Releases the passes of tasks `dispose()` ended, behind the GPU. */
    void release_disposed(Engine& engine) {
        for (std::size_t index = 0; index < tasks_.size(); ++index)
            if (!tasks_[index].empty() && index < engine.frame_tasks.size() &&
                engine.frame_tasks[index].disposed)
                tasks_[index].release(engine);
    }

private:
    std::deque<ExternalRenderablePass> tasks_;
};

} // namespace bbl::pal

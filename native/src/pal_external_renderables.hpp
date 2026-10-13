#pragma once

#include <bblite/gpu_renderable.hpp>
#include <bblite/pal_gpu_retirement.hpp>
#include <bblite/pal_source_gpu.hpp>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <stdexcept>
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
 * pass's transparent bucket (`pal_transparent_order.hpp`), after group 0.
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
                if (!renderable->transparent())
                    throw std::runtime_error(
                        "An external renderable draws in the transparent bucket.");
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
     * The binding at `index`, after the renderer's own draws: group 0 is the
     * engine's scene group (`bind_engine_scene_group`), then its pipeline.
     * Returns the draws it issued.
     */
    double draw(const GpuEncoderHandle& pass, const GpuHandle& scene_group,
                std::size_t index) const {
        auto& binding = *bindings_.at(index).binding;
        pass->set_bind_group(0, scene_group);
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
};

} // namespace bbl::pal

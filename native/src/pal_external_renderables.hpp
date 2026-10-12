#pragma once

#include <bblite/features/gpu_retirement.hpp>

#include <bblite/gpu_renderable.hpp>
#include <bblite/pal_gpu_retirement.hpp>
#include <bblite/pal_source_gpu.hpp>

#include <algorithm>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <utility>
#include <vector>

namespace bbl::pal {

/**
 * render-task-base.ts for a scene pass's external renderables
 * (`SceneState::external_renderables`, gpu_renderable.hpp). `follow` is
 * `_buildBindings` when the scene's published renderable version or the
 * pass's target signature moved, `prepare` the update half of
 * `prepareRenderTaskPass` (batch reset, binding updates, batch flush, which
 * records into the frame encoder before the pass begins), `draw` the
 * transparent half of `executePassBody` (group 0, then `drawList`). The
 * pin sorts transparent bindings by `_sortDistance` from `_worldCenter`;
 * these renderables have none, so they order by `order`, after the pass's
 * other content: a scene that also has other transparent renderables
 * would need that distance order and refuses.
 */
class ExternalRenderablePass {
public:
    bool empty() const { return bindings_.empty(); }

    void follow(Engine& engine, const Scene& scene, const GpuHandle& scene_layout,
                const GpuRenderTargetSignature& signature, bool other_transparent) {
        const auto& renderables = scene.state->external_renderables;
        if (bound_ && version_ == scene.state->renderable_version && signature_ == signature)
            return;
        if (!renderables.empty() && other_transparent)
            throw std::runtime_error(
                "External renderables draw after the scene pass's other content; a scene that "
                "also has other transparent renderables needs the pin's distance order.");
        std::vector<std::pair<double, GpuDrawBindingHandle>> ordered;
        std::vector<GpuDrawUpdateBatchHandle> batches;
        for (const auto& renderable : renderables) {
            if (!renderable->transparent())
                throw std::runtime_error("An external renderable draws in the transparent bucket.");
            auto binding = renderable->bind(scene_layout, signature);
            if (!binding)
                throw std::runtime_error("An external renderable's bind returned no binding.");
            // `_collectBatches`: each batch once, in binding order.
            for (auto& batch : binding->update_batches())
                if (std::find(batches.begin(), batches.end(), batch) == batches.end())
                    batches.push_back(std::move(batch));
            ordered.emplace_back(renderable->order(), std::move(binding));
        }
        std::stable_sort(ordered.begin(), ordered.end(), [](const auto& left, const auto& right) {
            return left.first < right.first;
        });
        // `_release`: batches the new generation dropped retire behind the GPU.
        std::vector<GpuDrawUpdateBatchHandle> removed;
        for (const auto& batch : batches_)
            if (!batch->retired() &&
                std::find(batches.begin(), batches.end(), batch) == batches.end())
                removed.push_back(batch);
        bindings_.clear();
        for (auto& [order, binding] : ordered)
            bindings_.push_back(std::move(binding));
        batches_ = std::move(batches);
        version_ = scene.state->renderable_version;
        signature_ = signature;
        bound_ = true;
        retire(engine, std::move(removed));
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
        for (const auto& binding : bindings_)
            binding->update(context);
        for (const auto& batch : batches_)
            batch->flush();
    }

    /** The pass binds `scene_group` at group 0, then each binding's pipeline and draw. */
    double draw(const GpuEncoderHandle& pass, const GpuHandle& scene_group) const {
        if (bindings_.empty())
            return 0;
        pass->set_bind_group(0, scene_group);
        GpuHandle bound;
        double draws = 0;
        for (const auto& binding : bindings_) {
            const auto pipeline = binding->pipeline();
            if (pipeline != bound) {
                pass->set_pipeline(pipeline);
                bound = pipeline;
            }
            draws += binding->draw(pass);
        }
        return draws;
    }

    /** The renderer's end: its bindings' batches retire behind the GPU. */
    void release(Engine& engine) {
        std::vector<GpuDrawUpdateBatchHandle> removed;
        for (const auto& batch : batches_)
            if (!batch->retired())
                removed.push_back(batch);
        bindings_.clear();
        batches_.clear();
        bound_ = false;
        retire(engine, std::move(removed));
    }

private:
    static void retire(Engine& engine, std::vector<GpuDrawUpdateBatchHandle> removed) {
        if (removed.empty())
            return;
        for (const auto& batch : removed)
            batch->mark_retired();
        retire_gpu_resources(gpu_retirement_state(engine), [removed = std::move(removed)] {
            for (const auto& batch : removed)
                batch->destroy();
        });
    }

    std::vector<GpuDrawBindingHandle> bindings_;
    std::vector<GpuDrawUpdateBatchHandle> batches_;
    GpuRenderTargetSignature signature_;
    std::uint64_t version_ = 0;
    bool bound_ = false;
};

} // namespace bbl::pal

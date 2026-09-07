#pragma once

#include <bblite/upstream_text.hpp>
#include <bblite/upstream_text_gpu.hpp>
#include <bblite/upstream/camera_change_key.hpp>
#include "pal_text_pipeline.hpp"

namespace bbl::pal {

struct TextSceneBinding {
    TextRenderable renderable;
    TextData data;
    std::shared_ptr<TextGpuState> gpu;
    TextPipelineBinding pipelines;
};

/** The admitted default scene has only text in its transparent binding list. */
struct TextScenePass {
    std::vector<TextSceneBinding> bindings;

    template<class Pipeline, class Ops>
    void bind(const Scene& scene, const void* device, const TextTargetSignature& target, Pipeline&& pipeline, Ops& ops) {
        for (const auto& renderable : scene.state->text_renderables) {
            if (!target.color_format) throw std::runtime_error("Text binding requires a color target.");
            const bool depth_write = !renderable->ignore_depth;
            const auto samples = target.sample_count.value_or(1u);
            const auto& info = text_pipeline_info(samples, target.depth_format.has_value(), depth_write,
                depth_write && samples > 1u && renderable->alpha_to_coverage);
            auto pipelines = pipeline(info);
            auto gpu = ensure_text_gpu(*renderable, device, target, pipelines, ops);
            bindings.push_back({renderable, renderable->data, std::move(gpu), std::move(pipelines)});
        }
    }

    template<class Ops>
    void update(const TextCameraInput* camera, double width, double height, Ops& ops) {
        for (auto& binding : bindings) {
            update_text_resources(*binding.renderable, *binding.gpu, binding.pipelines.layout, ops);
            update_text_uniforms(*binding.renderable, *binding.gpu, camera, width, height,
                [&](std::size_t offset, std::span<const std::uint8_t> bytes) {
                    ops.write_renderable_buffer(*binding.gpu, TextBufferKind::uniform, offset, bytes);
                });
        }
    }

    template<class Ops>
    double draw(Ops& ops) const {
        double count = 0;
        for (const auto& binding : bindings) {
            // The renderer binds the declared base pipeline before the pin's
            // text draw callback conditionally switches per atlas group.
            ops.set_pipeline(binding.gpu->pipeline);
            count += draw_text_renderable(*binding.gpu, *binding.data, binding.pipelines.quad, ops);
        }
        return count;
    }
};

} // namespace bbl::pal

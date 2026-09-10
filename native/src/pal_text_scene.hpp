#pragma once

#include <bblite/upstream_text.hpp>
#include <bblite/upstream_text_gpu.hpp>
#include <bblite/upstream/camera_change_key.hpp>
#include "pal_text_pipeline.hpp"

namespace bbl::pal {

/** Validate the scene that actually owns the retained text bindings. */
inline void validate_text_scene(const Scene& scene) {
    if (scene.state->text_renderables.empty()) return;
    if (!scene.state->default_render_task || !scene.tasks.empty()) {
        throw std::runtime_error("Text scene bindings require the default render pass.");
    }
    if (!scene.meshes.empty() || !scene.splat_meshes.empty() ||
#if !defined(BBLITE_HAS_SPRITES) || BBLITE_HAS_SPRITES
        !scene.billboard_systems.empty() || !scene.depth_hosted_sprite_layers.empty() ||
#endif
        scene.environment.has_skybox || scene.environment.has_image_skybox ||
        scene.environment.has_solid_skybox || scene.environment.has_ground) {
        throw std::runtime_error("Text scene bindings require merged ordering for the attached non-text renderables.");
    }
    if (!scene.engine || scene.camera.value >= scene.engine->cameras.size()) {
        throw std::runtime_error("Text scene bindings require an explicit camera.");
    }
    const auto& camera = handle_at(scene.engine->cameras, scene.camera);
    if (camera.kind == CameraKind::geospatial || camera.orthographic) {
        throw std::runtime_error("Text scene bindings require a perspective FreeCamera or ArcRotate camera.");
    }
#if BBLITE_FLOATING_ORIGIN
    throw std::runtime_error("Text scene bindings require eye-relative matrix transport.");
#endif
}

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
        validate_text_scene(scene);
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

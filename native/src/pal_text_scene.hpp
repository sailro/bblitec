#pragma once

#include <bblite/features/has_sprites.hpp>

#include <bblite/upstream_text.hpp>
#include <bblite/upstream_text_gpu.hpp>
#include <bblite/upstream/camera_change_key.hpp>

#include <array>
#include <optional>

#include "pal_text_pipeline.hpp"

namespace bbl::pal {

/** Validate the scene that actually owns the retained text bindings. */
inline void validate_text_scene(const Scene& scene) {
    if (scene.state->text_renderables.empty())
        return;
    if (!scene.state->default_render_task || !scene.tasks.empty()) {
        throw std::runtime_error("Text scene bindings require the default render pass.");
    }
    if (!scene.meshes.empty() || !scene.splat_meshes.empty() ||
#if BBLITE_HAS_SPRITES
        !scene.billboard_systems.empty() || !scene.depth_hosted_sprite_layers.empty() ||
#endif
        scene.environment.has_skybox || scene.environment.has_image_skybox ||
        scene.environment.has_solid_skybox || scene.environment.has_ground) {
        throw std::runtime_error(
            "Text scene bindings require merged ordering for the attached non-text renderables.");
    }
    if (!scene.engine || scene.camera.value >= scene.engine->cameras.size()) {
        throw std::runtime_error("Text scene bindings require an explicit camera.");
    }
    const auto& camera = handle_at(scene.engine->cameras, scene.camera);
    if (camera.kind == CameraKind::geospatial || camera.orthographic) {
        throw std::runtime_error(
            "Text scene bindings require a perspective FreeCamera or ArcRotate camera.");
    }
#if BBLITE_FLOATING_ORIGIN
    throw std::runtime_error("Text scene bindings require eye-relative matrix transport.");
#endif
}

/**
 * One text renderable's `DrawBinding` in the scene's transparent list: what
 * `bindTextRenderable` resolves once and its `update`/`draw` reuse.
 */
struct TextSceneBinding {
    TextRenderable renderable;
    std::shared_ptr<TextRenderableGpu> gpu;
    TextGpuHandle pipeline;
    TextPipelineDeviceCacheHandle cache;
    std::string color_format;
    double sample_count = 1;
    std::optional<std::string> depth_format;
    bool depth_write = true;
    std::string depth_compare;
};

/** The admitted default scene has only text in its transparent binding list. */
struct TextScenePass {
    std::vector<TextSceneBinding> bindings;

    void bind(const Scene& scene, const TextSurfaceHandle& surface,
              const TextTargetSignature& target) {
        validate_text_scene(scene);
        for (const auto& renderable : scene.state->text_renderables) {
            if (!target.color_format)
                throw std::runtime_error("TextRenderable: render target has no color format.");
            TextSceneBinding binding;
            binding.renderable = renderable;
            binding.color_format = *target.color_format;
            binding.sample_count = target.sample_count == 1 ? 1 : 4;
            binding.depth_format = target.depth_format;
            binding.depth_compare = target.depth_compare.value_or("greater-equal");
            binding.depth_write = !renderable->ignore_depth;
            binding.gpu = text_renderable_detail::ensure_gpu(
                renderable, surface, target, binding.color_format, binding.sample_count,
                binding.depth_format, binding.depth_write, binding.depth_compare);
            binding.pipeline = binding.gpu->pipeline;
            binding.cache = surface->device->text_pipeline_cache();
            bindings.push_back(std::move(binding));
        }
    }

    void update(const TextSurfaceHandle& surface, TextCameraInputPointer camera, double width,
                double height) {
        for (auto& binding : bindings) {
            // A styling feature enabled after the binding was built refreshes
            // the variant pipeline once, as the pin's binding update does.
            if (binding.gpu->variant_pipeline == binding.gpu->pipeline && text_weight_installed)
                binding.gpu->variant_pipeline =
                    surface->device
                        ->text_pipeline(binding.color_format, binding.sample_count,
                                        binding.depth_format, binding.depth_write,
                                        binding.renderable, binding.depth_compare)
                        .variant_pipeline;
            text_renderable_detail::update_text_renderable(
                binding.renderable, surface, binding.gpu, binding.cache->bind_group_layout,
                TextDrawUpdateContext{camera, width, height});
        }
    }

    /**
     * The scene pass's update: the text renderables read the pass camera
     * (`context._camera ?? null`) as its product, change key and aspect, and
     * a camera-less pass hands them none.
     */
    void update_for_pass(const TextSurfaceHandle& surface, const CameraRecord* camera,
                         const std::array<float, 16>& view_projection, double aspect, double width,
                         double height) {
        const std::optional<TextCameraInput> input =
            camera ? std::optional<TextCameraInput>{TextCameraInput{
                         js::TypedArray<float>(view_projection.begin(), view_projection.end()),
                         upstream::scene_camera_change_key(*camera), aspect}}
                   : std::nullopt;
        update(surface, input ? &*input : nullptr, width, height);
    }

    double draw(const TextGpuEncoderHandle& pass) const {
        double count = 0;
        for (const auto& binding : bindings) {
            // The render pass task binds the binding's declared pipeline before
            // the pin's text draw switches per atlas group.
            pass->set_pipeline(binding.pipeline);
            count += text_renderable_detail::draw_text_renderable(
                binding.gpu, binding.renderable->data, binding.cache->quad_vertex_buffer, pass);
        }
        return count;
    }
};

} // namespace bbl::pal

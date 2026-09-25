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
 * The admitted default scene has only text in its transparent binding list:
 * each renderable's `DrawBinding`, from the pin's own `bind`, whose
 * `update` and `draw` the render pass task calls.
 */
struct TextScenePass {
    std::vector<TextDrawBindingHandle> bindings;

    void bind(const Scene& scene, const TextSurfaceHandle& surface,
              const TextTargetSignature& target) {
        validate_text_scene(scene);
        for (const auto& renderable : scene.state->text_renderables)
            bindings.push_back(renderable->bind(surface, target));
    }

    void update(TextCameraInputPointer camera, double width, double height) const {
        for (const auto& binding : bindings)
            if (binding->update)
                binding->update(TextDrawUpdateContext{camera, width, height});
    }

    /**
     * The scene pass's update: the text renderables read the pass camera
     * (`context._camera ?? null`) as its product, change key and aspect, and
     * a camera-less pass hands them none.
     */
    void update_for_pass(CameraRecord* camera, const std::array<float, 16>& view_projection,
                         double aspect, double width, double height) const {
        const bbl::js::Nullable<TextCameraInput> input =
            camera ? bbl::js::Nullable<TextCameraInput>{TextCameraInput{
                         js::TypedArray<float>(view_projection.begin(), view_projection.end()),
                         upstream::scene_camera_change_key(*camera), aspect}}
                   : std::nullopt;
        update(input ? &*input : nullptr, width, height);
    }

    double draw(const TextGpuEncoderHandle& pass, const TextSurfaceHandle& surface) const {
        double count = 0;
        for (const auto& binding : bindings) {
            // The render pass task binds the binding's declared pipeline before
            // the pin's text draw switches per atlas group.
            pass->set_pipeline(binding->pipeline);
            count += binding->draw(pass, surface);
        }
        return count;
    }
};

} // namespace bbl::pal

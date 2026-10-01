#pragma once

#include <bblite/features/has_sprites.hpp>

#include <bblite/upstream_text.hpp>
#include <bblite/upstream_text_gpu.hpp>
#include <bblite/upstream/camera_change_key.hpp>

#include <array>
#include <cstdint>
#include <optional>
#include <vector>

#include "pal_text_pipeline.hpp"

namespace bbl::pal {

/**
 * Whether the scene's text draws in its one compiler-owned scene pass: the
 * default render pass, or the scene-stage render task of the default task
 * graph a surface scene registers with. Another render or geometry task
 * would mirror the text into a pass of its own.
 */
inline bool text_in_default_scene_pass(const Scene& scene) {
    if (!scene.state->default_render_task)
        return false;
    std::size_t scene_passes = 0;
    for (const TaskHandle handle : scene.tasks) {
        const FrameTaskRecord& task = handle_at(scene.engine->frame_tasks, handle);
        if (task.kind == FrameTaskKind::geometry ||
            (task.kind == FrameTaskKind::render && !task.render.scene_stages))
            return false;
        if (task.kind == FrameTaskKind::render)
            ++scene_passes;
    }
    return scene.tasks.empty() || scene_passes == 1;
}

/** Validate the scene that actually owns the retained text bindings. */
inline void validate_text_scene(const Scene& scene) {
    if (scene.state->text_renderables.empty())
        return;
    if (!scene.engine || scene.camera.value >= scene.engine->cameras.size()) {
        throw std::runtime_error("Text scene bindings require an explicit camera.");
    }
    if (!text_in_default_scene_pass(scene)) {
        throw std::runtime_error("Text scene bindings require the scene's default pass: its own "
                                 "render pass, or its default task graph's scene-stage task "
                                 "beside no other render or geometry task.");
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
    /** The target the pass binds for, and the scene `renderable_version` it bound. */
    TextSurfaceHandle target_surface;
    TextTargetSignature target_signature;
    std::uint64_t renderable_version = 0;

    /** Setup: bind the scene's text for the pass's target. */
    void bind(const Scene& scene, const TextSurfaceHandle& surface,
              const TextTargetSignature& target) {
        target_surface = surface;
        target_signature = target;
        rebind(scene);
    }

    /**
     * render-task-base.ts `prepareRenderTaskPass`: a task rebinds the scene's
     * renderables only when its `_renderableVersion` moved -- a registration
     * that published more text -- and otherwise does no binding work. Each
     * rebind is the pin's own `bind`, which keeps an already bound renderable's
     * GPU state for the same target (`ensureGpu`).
     */
    void follow(const Scene& scene) {
        if (renderable_version != scene.state->renderable_version)
            rebind(scene);
    }

    void rebind(const Scene& scene) {
        validate_text_scene(scene);
        std::vector<TextDrawBindingHandle> rebound;
        rebound.reserve(scene.state->text_renderables.size());
        for (const auto& renderable : scene.state->text_renderables)
            rebound.push_back(renderable->bind(target_surface, target_signature));
        bindings = std::move(rebound);
        renderable_version = scene.state->renderable_version;
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

    double draw(const GpuEncoderHandle& pass, const TextSurfaceHandle& surface) const {
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

// The camera one render pass renders through, and what the pass builds from
// it, shared by both scene backends.
//
// render-task-base.ts resolves a pass's camera once (`task._config.cam ??
// sc.camera`) and its clear colour once (`cfg.clrColor ?? sc.clearColor`);
// both are lowered into `upstream::render_task_camera` and
// `upstream::render_task_clear_color`, and every pass here -- a scene's own,
// a swapchain overlay's, a utility layer's, a render task's -- resolves
// through them. A null camera is the pin's camera-less pass: it still clears
// and draws, `_writePassSceneUBO` writes no scene block, and a renderable
// whose update needs a camera returns on its own lowered test.
#pragma once

#include <bblite/runtime.hpp>
#include <bblite/upstream/render_capabilities.hpp>
#include <bblite/upstream/renderer_plan.hpp>

#include <array>
#include <optional>

#include "pal_gpu_shared.hpp"

namespace bbl::pal {

/**
 * One pass's camera and the matrices built from it. Without a camera the
 * matrices are the zeros of the scene block the pin never writes, so
 * everything the pass projects collapses and reaches no fragment.
 */
struct PassCamera {
    const CameraRecord* camera = nullptr;
    CameraPassMatrices matrices{};

    [[nodiscard]] ShaderPassMatrices pass() const { return matrices.pass(); }
};

/** `camera`'s pass over a `width` x `height` extent (`camera_pass_matrices`). */
inline PassCamera build_pass_camera(const Scene& scene, const Engine& engine,
                                    const CameraRecord* camera, double width, double height) {
    return PassCamera{camera, camera_pass_matrices(scene, engine, camera, width, height)};
}

/**
 * The camera of a scene's own pass. `createSceneContext`'s automatic task
 * configures none, so it renders through the scene's -- for a swapchain
 * overlay or a utility layer that is the layer's own camera, with no
 * fallback to the base scene's.
 */
inline CameraRecord* scene_pass_camera(Engine& engine, const Scene& scene) {
    return upstream::render_task_camera(nullptr, scene_camera(engine, scene));
}

/** The clear colour of a scene's own pass, which configures none. */
inline Color4 scene_pass_clear_color(const Scene& scene) {
    return upstream::render_task_clear_color(std::nullopt, scene.clear_color);
}

/** The camera a render task renders through: its own, else its scene's. */
inline CameraRecord* task_pass_camera(Engine& engine, const FrameTaskRecord& task) {
    CameraRecord* configured =
        task.render.has_camera ? &handle_at(engine.cameras, task.render.camera) : nullptr;
    return upstream::render_task_camera(configured,
                                        handle_find(engine.cameras, task.source_scene->camera));
}

/** The colour a render task clears to, read live at the pass. */
inline Color4 task_pass_clear_color(const FrameTaskRecord& task) {
    return upstream::render_task_clear_color(task.render.clear_color,
                                             task.source_scene->clear_color);
}

/**
 * The camera a geometry task of `scene` renders through. The factory takes
 * no camera, so this is the scene's; a null one skips the whole task
 * (`upstream::geometry_task_skips`).
 */
inline const CameraRecord* geometry_pass_camera(Engine& engine, const Scene& scene) {
    return upstream::geometry_task_camera(nullptr, scene_camera(engine, scene));
}

#if BBLITE_PINNED_MATERIALS
/**
 * A pass's scene block over `view_projection`: the pin's writer through the
 * pass camera, or -- where `_writePassSceneUBO` returns
 * (`upstream::pass_scene_block_skips`) -- the zero block the pass's buffer
 * starts with. A backend that keeps each pass's block in a buffer skips the
 * write instead, which leaves the block as the pin leaves it.
 */
inline upstream::SceneUniforms pass_scene_uniforms(const Scene& scene, const Engine& engine,
                                                   const CameraRecord* camera,
                                                   const std::array<float, 16>& view_projection) {
    if (upstream::pass_scene_block_skips(camera))
        return upstream::SceneUniforms{};
    return pinned_scene_block(scene, engine, *camera, view_projection);
}

/** The scene block of `pass`, over its own view-projection. */
inline upstream::SceneUniforms pass_scene_uniforms(const Scene& scene, const Engine& engine,
                                                   const PassCamera& pass) {
    return pass_scene_uniforms(scene, engine, pass.camera, pass.matrices.view_projection);
}
#endif

} // namespace bbl::pal

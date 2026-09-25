// The camera one render pass renders through, and what the pass builds from
// it, shared by both scene backends.
//
// render-task-base.ts resolves a pass's camera once (`task._config.cam ??
// sc.camera`) and its clear colour once (`cfg.clrColor ?? sc.clearColor`);
// both are lowered into `upstream::render_task_camera` and
// `upstream::render_task_clear_color`, and every pass here -- a scene's own,
// a swapchain overlay's, a utility layer's, a render task's -- resolves
// through them. A null camera is the pin's camera-less pass: it still clears
// and draws, `_writePassSceneUBO` leaves the pass's scene block as it was,
// and a renderable whose update needs a camera returns on its own lowered
// test.
#pragma once

#include <bblite/features/has_billboards.hpp>

#include <bblite/runtime.hpp>
#include <bblite/upstream/render_capabilities.hpp>
#include <bblite/upstream/renderer_plan.hpp>

#include <algorithm>
#include <array>
#include <deque>
#include <map>
#include <memory>
#include <optional>
#include <utility>

#include "pal_gpu_shared.hpp"

namespace bbl::pal {

/**
 * One pass's camera and the matrices built from it. Without a camera the
 * matrices are zeros; a pass that keeps its view-projection
 * (`keep_view_projection`) then draws through the one its block last held.
 */
struct PassCamera {
    // Mutable: the pin's change key updates the camera's projection cache.
    CameraRecord* camera = nullptr;
    CameraPassMatrices matrices{};

    [[nodiscard]] ShaderPassMatrices pass() const { return matrices.pass(); }
};

/** `camera`'s pass over a `width` x `height` extent (`camera_pass_matrices`). */
inline PassCamera build_pass_camera(const Scene& scene, const Engine& engine, CameraRecord* camera,
                                    double width, double height) {
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
inline CameraRecord* geometry_pass_camera(Engine& engine, const Scene& scene) {
    return upstream::geometry_task_camera(nullptr, scene_camera(engine, scene));
}

/**
 * One pass's block as the pin keeps it. Every render task owns its scene
 * UBO (`task._sceneUBO`, created zeroed), and `_writePassSceneUBO` rewrites
 * it through the pass camera or returns first without one
 * (`upstream::pass_scene_block_skips`) -- so a camera-less pass reads what
 * the block last held: its zeros, or its last camera's.
 */
template <class Block> class RetainedBlock {
public:
    /** The pass's write: `writer(camera)` with a camera, nothing without. */
    template <class Writer> const Block& write(const CameraRecord* camera, Writer&& writer) {
        if (!upstream::pass_scene_block_skips(camera))
            block_ = std::forward<Writer>(writer)(*camera);
        return block_;
    }

    [[nodiscard]] const Block& block() const { return block_; }

private:
    Block block_{};
};

/**
 * Every pass's retained entry: a scene's own pass by its scene's identity
 * (a disposed scene's entry goes with it, so a scene allocated after it
 * starts from zeros), a frame task by its handle -- the table only grows,
 * so a handle names one task for the run. References stay valid as the
 * table grows.
 */
template <class Entry> class PassBlocks {
public:
    Entry& scene(const Scene& scene) {
        const auto found = scenes_.find(scene.state);
        if (found != scenes_.end())
            return found->second;
        std::erase_if(scenes_, [](const auto& entry) { return entry.first.expired(); });
        return scenes_[scene.state];
    }

    Entry& task(TaskHandle task) {
        if (task.value >= tasks_.size())
            tasks_.resize(static_cast<std::size_t>(task.value) + 1u);
        return tasks_[task.value];
    }

    /** A frame task's entry, else the scene's own pass's. */
    Entry& pass(const Scene& scene, std::optional<TaskHandle> task) {
        return task ? this->task(*task) : this->scene(scene);
    }

private:
    std::map<std::weak_ptr<SceneState>, Entry, std::owner_less<std::weak_ptr<SceneState>>> scenes_;
    std::deque<Entry> tasks_;
};

/**
 * A pass's retained blocks: the view-projection its scene block keeps,
 * which the port's own lane (SDL_GPU's slot zero, Dawn's `view_projection`)
 * and a shader draw's pass matrices carry for the stages that read no scene
 * block; the scene block its materials and backgrounds bind; and the same
 * group as a billboard program binds it -- over the matrices the pass draws
 * billboards with. A backend that pushes blocks per draw keeps these to
 * push; one that keeps each pass's block in its own buffer writes what these
 * hold.
 */
struct RetainedSceneBlock {
    RetainedBlock<std::array<float, 16>> view_projection;
#if BBLITE_PINNED_MATERIALS || BBLITE_HAS_BILLBOARDS
    RetainedBlock<upstream::SceneUniforms> pass;
#endif
#if BBLITE_HAS_BILLBOARDS
    RetainedBlock<upstream::SceneUniforms> billboard;
#endif
};

using RetainedSceneBlocks = PassBlocks<RetainedSceneBlock>;

/**
 * `matrices`' view-projection as the pass's scene block keeps it: the
 * camera's, or -- for a camera-less pass, whose `_writePassSceneUBO`
 * returns first -- the one the block last held. The pin draws every stage
 * through that `viewProjection`; the view, projection and eye stay the
 * camera-less pass's zeros.
 */
inline void keep_view_projection(CameraPassMatrices& matrices, const CameraRecord* camera,
                                 RetainedSceneBlock& retained) {
    matrices.view_projection = retained.view_projection.write(
        camera, [&](const CameraRecord&) { return matrices.view_projection; });
}

/** `build_pass_camera` with the view-projection its pass keeps. */
inline PassCamera build_kept_pass_camera(const Scene& scene, const Engine& engine,
                                         CameraRecord* camera, double width, double height,
                                         RetainedSceneBlock& retained) {
    PassCamera pass = build_pass_camera(scene, engine, camera, width, height);
    keep_view_projection(pass.matrices, camera, retained);
    return pass;
}

#if BBLITE_PINNED_MATERIALS || BBLITE_HAS_BILLBOARDS
/** `_writePassSceneUBO` over the pass camera and `view_projection`. */
inline const upstream::SceneUniforms&
write_pass_scene_block(RetainedSceneBlock& retained, const Scene& scene, const Engine& engine,
                       const CameraRecord* camera, const std::array<float, 16>& view_projection) {
    return retained.pass.write(camera, [&](const CameraRecord& written) {
        return pinned_scene_block(scene, engine, written, view_projection);
    });
}

/** The same write over `pass`'s own camera and view-projection. */
inline const upstream::SceneUniforms& write_pass_scene_block(RetainedSceneBlock& retained,
                                                             const Scene& scene,
                                                             const Engine& engine,
                                                             const PassCamera& pass) {
    return write_pass_scene_block(retained, scene, engine, pass.camera,
                                  pass.matrices.view_projection);
}

#if BBLITE_HAS_BILLBOARDS
/** The same write for the block a billboard program binds. */
inline const upstream::SceneUniforms&
write_billboard_scene_block(RetainedSceneBlock& retained, const Scene& scene, const Engine& engine,
                            const CameraRecord* camera,
                            const std::array<float, 16>& view_projection,
                            const std::array<float, 16>& view) {
    return retained.billboard.write(camera, [&](const CameraRecord& written) {
        return billboard_scene_block(scene, engine, written, view_projection, view);
    });
}
#endif
#endif

} // namespace bbl::pal

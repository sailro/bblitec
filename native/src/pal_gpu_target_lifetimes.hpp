// The frame's task and render-target lifetime checks both backends run:
// lifecycle synchronization, the disposed-target refusal and the executed
// tasks' readiness.
#pragma once
#include <bblite/features/live_task_add.hpp>
#include <bblite/features/render_target_disposal.hpp>
#include <bblite/features/task_disposal.hpp>
#include <bblite/runtime.hpp>
#include <cstddef>
#include <stdexcept>
#include <string>
#include <string_view>

namespace bbl::pal {

/** Each live target's lifecycle catches up with its record (a resize or replacement). */
inline void synchronize_render_target_lifecycles(const Engine& engine) {
    const auto count = engine.render_targets.size();
    for (std::size_t index = 0; index < count; ++index) {
        // A disposed target is built no more; its lifecycle refuses a build.
        if (engine.render_targets[index].retired)
            continue;
        const auto lifecycle = engine.render_targets[index].lifecycle;
        if (lifecycle)
            lifecycle->synchronize();
    }
}

#if BBLITE_RENDER_TARGET_DISPOSAL
/**
 * The refusal a frame owes a target `disposeRenderTargetTexture` released:
 * the pin keeps encoding a recorded pass or bind group over the released
 * attachments until its next build refuses the target, and drawing into or
 * sampling those attachments is not represented.
 */
[[noreturn]] inline void refuse_disposed_render_target(std::string_view user) {
    throw std::runtime_error(std::string(user) +
                             " uses a render-target texture that disposeRenderTargetTexture "
                             "released.");
}

namespace detail {
/** The executed task naming a disposed target, spelled only when it refuses. */
struct TargetUser {
    std::string_view kind;
    const std::string& name;
};

inline void require_live_target(const Engine& engine, RenderTargetHandle handle, TargetUser user) {
    const RenderTargetRecord* record = handle_find(engine.render_targets, handle);
    if (record && record->retired)
        refuse_disposed_render_target(std::string(user.kind) + " '" + user.name + "'");
}

inline void require_live_texture(const Engine& engine, const RenderTextureRef& reference,
                                 TargetUser user) {
    if (reference.source == RenderTextureSource::render_target)
        require_live_target(engine, reference.target, user);
}

inline void require_live_passes(const Engine& engine, const PostProcessTaskOptions& options,
                                TargetUser user) {
    for (const PostProcessPassOptions& pass : options.passes) {
        require_live_texture(engine, pass.source, user);
        require_live_target(engine, pass.target, user);
        require_live_target(engine, pass.output_target, user);
        for (const RenderTextureRef& texture : pass.extra_textures)
            require_live_texture(engine, texture, user);
    }
    require_live_target(engine, options.output_target, user);
}

/** Every target an executed task renders into or samples, by its kind's own record. */
inline void require_live_task_targets(const Engine& engine, const FrameTaskRecord& task) {
    switch (task.kind) {
    case FrameTaskKind::render: {
        const TargetUser user{"Render task", task.render.name};
        require_live_target(engine, task.render.target, user);
        require_live_target(engine, task.render.resolve_target, user);
        require_live_texture(engine, task.render.depth, user);
        return;
    }
    case FrameTaskKind::geometry:
        require_live_target(engine, task.geometry.target, {"Geometry task", task.geometry.name});
        return;
    case FrameTaskKind::copy: {
        const TargetUser user{"Copy task", task.copy.name};
        require_live_texture(engine, task.copy.source, user);
        require_live_target(engine, task.copy.target, user);
        require_live_target(engine, task.copy.resolve_target, user);
        return;
    }
    case FrameTaskKind::post_process:
        require_live_passes(engine, task.post_process,
                            {"Post-process task", task.post_process.name});
        return;
    case FrameTaskKind::screen_space: {
        const TargetUser user{"Screen-space task", task.screen_space.name};
        for (const RenderTargetHandle target :
             {task.screen_space.source, task.screen_space.depth, task.screen_space.target,
              task.screen_space.raw, task.screen_space.stable, task.screen_space.history,
              task.screen_space.output_target})
            require_live_target(engine, target, user);
        require_live_passes(engine, task.post_process, user);
        return;
    }
    case FrameTaskKind::effect:
        require_live_target(engine, task.effect.target, {"Effect task", task.effect.name});
        return;
    case FrameTaskKind::compute:
        return;
    }
}
} // namespace detail
#endif

#if BBLITE_RENDER_TARGET_DISPOSAL || BBLITE_LIVE_TASK_ADD
/**
 * Every registered scene's and frame-graph context's executed tasks, before
 * a frame encodes any: each is recorded and not disposed (the generated
 * `require_executable_task`) and names only live targets.
 */
inline void require_executable_frame_tasks(const Engine& engine) {
    const auto require = [&engine](TaskHandle handle) {
        const FrameTaskRecord* task = handle_find(engine.frame_tasks, handle);
        if (!task || task->execution_enabled == false)
            return;
#if BBLITE_TASK_DISPOSAL || BBLITE_LIVE_TASK_ADD
        require_executable_task(*task);
#endif
#if BBLITE_RENDER_TARGET_DISPOSAL
        detail::require_live_task_targets(engine, *task);
#endif
    };
    for (const auto& scene : engine.scenes())
        if (scene)
            for (const TaskHandle task : scene->tasks)
                require(task);
    for (const FrameGraphContext* graph : engine.frame_graph_contexts())
        if (graph)
            for (const TaskHandle task : graph->tasks)
                require(task);
}
#endif

} // namespace bbl::pal

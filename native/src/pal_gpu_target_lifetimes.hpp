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

/** Who resolves a render target in a frame; a refusal names it. */
struct TargetUser {
    std::string_view kind;
    std::string_view name;
};

/** A pass or material binding no executed task names. */
inline constexpr TargetUser frame_pass_target_user{"A frame-graph pass or material", {}};

/** The executed task resolving its targets. */
inline TargetUser task_target_user(const FrameTaskRecord& task) {
    switch (task.kind) {
    case FrameTaskKind::render:
        return {"Render task", task.render.name};
    case FrameTaskKind::geometry:
        return {"Geometry task", task.geometry.name};
    case FrameTaskKind::copy:
        return {"Copy task", task.copy.name};
    case FrameTaskKind::post_process:
        return {"Post-process task", task.post_process.name};
    case FrameTaskKind::screen_space:
        return {"Screen-space task", task.screen_space.name};
    case FrameTaskKind::effect:
        return {"Effect task", task.effect.name};
    case FrameTaskKind::compute:
        break;
    }
    return frame_pass_target_user;
}

/**
 * Names `user` the encoder's target user while one task encodes, and
 * restores the previous one after it.
 */
class ScopedTargetUser {
public:
    ScopedTargetUser(TargetUser& slot, TargetUser user) : slot_(slot), previous_(slot) {
        slot_ = user;
    }
    ScopedTargetUser(const ScopedTargetUser&) = delete;
    ScopedTargetUser& operator=(const ScopedTargetUser&) = delete;
    ~ScopedTargetUser() { slot_ = previous_; }

private:
    TargetUser& slot_;
    TargetUser previous_;
};

#if BBLITE_RENDER_TARGET_DISPOSAL
/**
 * The refusal a frame owes a target `disposeRenderTargetTexture` released:
 * the pin keeps encoding a recorded pass or bind group over the released
 * attachments until its next build refuses the target, and drawing into or
 * sampling those attachments is not represented.
 */
[[noreturn]] inline void refuse_disposed_render_target(TargetUser user) {
    std::string named(user.kind);
    if (!user.name.empty())
        named += " '" + std::string(user.name) + "'";
    throw std::runtime_error(named + " uses a render-target texture that "
                                     "disposeRenderTargetTexture released.");
}
#endif

/**
 * The one lookup a frame resolves a render target through, on both
 * backends: a target `disposeRenderTargetTexture` released refuses, naming
 * its user.
 */
inline const RenderTargetRecord& resolve_render_target(const Engine& engine,
                                                       RenderTargetHandle handle,
                                                       [[maybe_unused]] TargetUser user) {
    const RenderTargetRecord& record = handle_at(engine.render_targets, handle);
#if BBLITE_RENDER_TARGET_DISPOSAL
    if (record.retired)
        refuse_disposed_render_target(user);
#endif
    return record;
}

/** A backend's GPU target for `handle`, resolved through `resolve_render_target`. */
template <class Targets>
auto& resolve_gpu_target(const Engine& engine, Targets& targets, RenderTargetHandle handle,
                         TargetUser user) {
    resolve_render_target(engine, handle, user);
    return handle_at(targets, handle);
}

#if BBLITE_RENDER_TARGET_DISPOSAL
namespace detail {
/** Each render target an executed task's own record names, before the frame encodes it. */
template <class Visit> void visit_task_targets(const FrameTaskRecord& task, Visit&& visit) {
    const auto texture = [&visit](const RenderTextureRef& reference) {
        if (reference.source == RenderTextureSource::render_target)
            visit(reference.target);
    };
    const auto passes = [&](const PostProcessTaskOptions& options) {
        for (const PostProcessPassOptions& pass : options.passes) {
            texture(pass.source);
            visit(pass.target);
            visit(pass.output_target);
            for (const RenderTextureRef& extra : pass.extra_textures)
                texture(extra);
        }
        visit(options.output_target);
    };
    switch (task.kind) {
    case FrameTaskKind::render:
        visit(task.render.target);
        visit(task.render.resolve_target);
        texture(task.render.depth);
        return;
    case FrameTaskKind::geometry:
        visit(task.geometry.target);
        return;
    case FrameTaskKind::copy:
        texture(task.copy.source);
        visit(task.copy.target);
        visit(task.copy.resolve_target);
        return;
    case FrameTaskKind::post_process:
        passes(task.post_process);
        return;
    case FrameTaskKind::screen_space:
        for (const RenderTargetHandle target :
             {task.screen_space.source, task.screen_space.depth, task.screen_space.target,
              task.screen_space.raw, task.screen_space.stable, task.screen_space.history,
              task.screen_space.output_target})
            visit(target);
        passes(task.post_process);
        return;
    case FrameTaskKind::effect:
        visit(task.effect.target);
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
        // The encoding resolves each through the same lookup; this refuses
        // before the frame encodes anything.
        detail::visit_task_targets(
            *task, [&engine, user = task_target_user(*task)](RenderTargetHandle target) {
                if (handle_find(engine.render_targets, target))
                    resolve_render_target(engine, target, user);
            });
#endif
    };
    for (const auto& scene : engine.scenes())
        if (scene)
            for (const TaskHandle task : scene->frame_passes())
                require(task);
    for (const FrameGraphContext* graph : engine.frame_graph_contexts())
        if (graph)
            for (const TaskHandle task : graph->tasks)
                require(task);
}
#endif

} // namespace bbl::pal

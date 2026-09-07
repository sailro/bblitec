#define main generated_scene_main
#include "program.hpp"
#undef main
#include <cassert>
#include <cstdio>

namespace {
std::vector<bbl::RenderTargetOptions> targets;
std::vector<bbl::CopyTaskOptions> copies;
std::uint32_t task_count = 0;
unsigned color_tasks = 0;
unsigned enabled_registrations = 0;
unsigned disabled_registrations = 0;
}

namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
Scene create_scene_context(Engine& engine) {
    Scene scene;
    scene.engine = &engine;
    return scene;
}
RenderTargetHandle create_render_target(Engine& engine, RenderTargetOptions options) {
    targets.push_back(options);
    engine.render_targets.emplace_back();
    return {static_cast<std::uint32_t>(targets.size() - 1)};
}
RenderTargetHandle swapchain_render_target(Engine&) { return {100}; }
RenderTextureRef render_target_texture(RenderTargetHandle target) {
    return {.target = target};
}
TaskHandle create_render_task(Engine&, Scene& scene, RenderTaskOptions options) {
    assert(scene.state->default_render_task);
    assert(options.name == "default-render-task" && options.scene_stages);
    ++color_tasks;
    return {task_count++};
}
TaskHandle create_copy_to_texture_task(Engine&, Scene&, CopyTaskOptions options) {
    copies.push_back(options);
    return {task_count++};
}
void add_task(Scene& scene, TaskHandle task) { scene.tasks.push_back(task); }
void register_scene_with_shadow_support(Scene& scene) {
    if (scene.state->default_render_task) {
        assert(scene.state->default_render_task_created && scene.tasks.size() == 3);
        ++enabled_registrations;
    } else {
        assert(!scene.state->default_render_task_created && scene.tasks.empty());
        ++disabled_registrations;
    }
}
}

int main() {
    assert(generated_scene_main() == 0);
    assert(enabled_registrations == 2 && disabled_registrations == 2);
    assert(color_tasks == 1 && task_count == 3);
    assert(targets.size() == 2 && targets[0].samples == 4 && targets[1].samples == 1);
    assert(copies.size() == 2 && copies[0].name == "default-resolve" && copies[1].name == "default-present");
    assert(copies[0].source.target.value == 0 && copies[0].resolve_target.value == 1);
    assert(copies[1].source.target.value == 1 && copies[1].target.value == 100);
    bbl::Scene scene;
    const auto alias = bbl::configure_scene_render_defaults(scene, false, 1);
    assert(alias.shares_identity(scene) && !scene.state->default_render_task);
    assert(scene.state->default_render_task_samples == 1);
    std::puts("scene-default-task-check: ok");
}

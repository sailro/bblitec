import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LoweringContext } from "../src/lowering/context.js";
import { shadowFactorySource } from "../src/lowering/shadow-lowerer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);

test(
    "persistent shadow generators schedule their passes after scene replacement",
    { skip: !tools },
    () => {
        const source = shadowFactorySource(new LoweringContext(), [
            "shadow:csm",
            "shadow:task",
        ]).source;
        const output = resolve("artifacts/shadow-registration-check");
        mkdirSync(output, { recursive: true });
        writeFileSync(
            join(output, "check.cpp"),
            `
#include <bblite/checked_handles.hpp>
#include <algorithm>
#include <cassert>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>
struct Handle { std::uint32_t value; };
using TaskHandle = Handle;
using LightHandle = Handle;
using ShadowGeneratorHandle = Handle;
struct Scene;
struct Task { Scene* source_scene; };
struct SceneInternalPass { TaskHandle task; TaskHandle after{}; };
struct Generator { std::vector<TaskHandle> caster_tasks; };
struct Light { ShadowGeneratorHandle shadow_generator; };
struct Engine {
    std::vector<Light> lights{{{0}}};
    std::vector<Generator> shadow_generators{1};
    std::vector<Task> frame_tasks;
};
struct Scene {
    Engine* engine;
    Scene* state = this;
    std::vector<LightHandle> lights{{0}};
    std::vector<TaskHandle> tasks{};
    std::vector<SceneInternalPass> internal_passes{};
    std::optional<std::string> shadow_task_name{};
};
unsigned registrations = 0;
void build_shadow_task(Scene&, ShadowGeneratorHandle) {
    throw std::runtime_error("Existing shadow passes must be reused.");
}
void add_leading_pass(Scene& state, TaskHandle task) {
    state.internal_passes.insert(state.internal_passes.begin(), SceneInternalPass{task, {}});
}
void register_scene(Scene&) { ++registrations; }
void rebuild_scene_renderables(Scene&) {}
${cppFunction(source, "void register_scene_with_shadow_support(Scene& scene)")}
void check(Scene& scene) {
    assert(scene.shadow_task_name == "shadow");
    // Caster passes stay out of the pin's task list, ahead of every task.
    assert(scene.tasks.empty() && scene.internal_passes.size() == 4);
    for (unsigned i = 0; i < 4; ++i) {
        assert(scene.internal_passes[i].task.value == i);
        assert(scene.engine->frame_tasks[i].source_scene == &scene);
    }
}
int main() {
    Engine engine;
    Scene menu{&engine};
    for (unsigned i = 0; i < 4; ++i) {
        engine.frame_tasks.push_back({&menu});
        engine.shadow_generators[0].caster_tasks.push_back({i});
        menu.internal_passes.push_back({{i}, {}});
    }
    register_scene_with_shadow_support(menu);
    check(menu);
    register_scene_with_shadow_support(menu);
    check(menu);
    menu.internal_passes.clear(); // Disposal retires the scene, while the world retains its generator.
    Scene race{&engine};
    register_scene_with_shadow_support(race);
    check(race);
    register_scene_with_shadow_support(race);
    check(race);
    assert(registrations == 4);
    Scene empty{&engine};
    empty.lights.clear();
    assert(!empty.shadow_task_name);
    register_scene_with_shadow_support(empty);
    assert(empty.shadow_task_name == "shadow");
    assert(empty.tasks.empty() && empty.internal_passes.empty());
    assert(registrations == 5);
}
`,
        );
        const executable = join(output, "check.exe");
        runNativeFixtureCompiler(tools!, [
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            join(output, "check.cpp"),
        ]);
        execFileSync(executable, { stdio: "pipe" });
    },
);

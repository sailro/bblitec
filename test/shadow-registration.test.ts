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
        ]).source;
        const output = resolve("artifacts/shadow-registration-check");
        mkdirSync(output, { recursive: true });
        writeFileSync(
            join(output, "check.cpp"),
            `
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
    std::vector<TaskHandle> tasks;
    std::optional<std::string> shadow_task_name;
};
unsigned registrations = 0;
void build_shadow_task(Scene&, ShadowGeneratorHandle) {
    throw std::runtime_error("Existing shadow passes must be reused.");
}
void add_task_at_start(Scene& scene, TaskHandle task) { scene.tasks.insert(scene.tasks.begin(), task); }
void register_scene(Scene&) { ++registrations; }
void rebuild_scene_renderables(Scene&) {}
${cppFunction(source, "void register_scene_with_shadow_support(Scene& scene)")}
void check(Scene& scene) {
    assert(scene.shadow_task_name == "shadow");
    assert(scene.tasks.size() == 4);
    for (unsigned i = 0; i < 4; ++i) {
        assert(scene.tasks[i].value == i);
        assert(scene.engine->frame_tasks[i].source_scene == &scene);
    }
}
int main() {
    Engine engine;
    Scene menu{&engine};
    for (unsigned i = 0; i < 4; ++i) {
        engine.frame_tasks.push_back({&menu});
        engine.shadow_generators[0].caster_tasks.push_back({i});
        menu.tasks.push_back({i});
    }
    register_scene_with_shadow_support(menu);
    check(menu);
    register_scene_with_shadow_support(menu);
    check(menu);
    menu.tasks.clear(); // Disposal retires the scene, while the world retains its generator.
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
    assert(empty.tasks.empty());
    assert(registrations == 5);
}
`,
        );
        const executable = join(output, "check.exe");
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/permissive-",
            "/EHsc",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            join(output, "check.cpp"),
        ]);
        execFileSync(executable, { stdio: "pipe" });
    },
);

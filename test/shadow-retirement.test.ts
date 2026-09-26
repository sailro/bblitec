import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("shadow retirement releases task and map payloads while preserving handles and reusable configuration", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/shadow-retirement");
    mkdirSync(directory, { recursive: true });
    const source = join(directory, "check.cpp"),
        executable = join(directory, "check.exe");
    const generated = new SceneLowerer(new LoweringContext()).lowerCore()
        .source;
    writeFileSync(
        source,
        `#include <bblite/checked_handles.hpp>
#include <algorithm>
#include <cassert>
#include <cstdint>
#include <memory>
#include <vector>
struct Handle { std::uint32_t value = 999; };
using TaskHandle=Handle; using LightHandle=Handle; using ShadowGeneratorHandle=Handle; using RenderTargetHandle=Handle;
struct ShadowCascade {};
struct FrameTaskRecord { bool execution_enabled = true; std::shared_ptr<int> payload; };
struct RenderTargetRecord { bool retired = false; std::shared_ptr<int> payload; };
struct ShadowGeneratorRecord {
 std::vector<TaskHandle> caster_tasks;
 RenderTargetHandle map_target;
 std::vector<ShadowCascade> csm_cascades;
 std::vector<Handle> caster_meshes;
 unsigned map_size = 1024;
};
struct LightRecord { ShadowGeneratorHandle shadow_generator; };
struct Engine {
 std::vector<ShadowGeneratorRecord> shadow_generators{2};
 std::vector<FrameTaskRecord> frame_tasks{3};
 std::vector<RenderTargetRecord> render_targets{2};
 std::vector<LightRecord> lights{{{0}},{{1}}};
 std::uint64_t render_targets_version = 0;
};
struct Scene { Engine* engine; std::vector<LightHandle> lights; std::vector<TaskHandle> tasks; std::vector<ShadowGeneratorHandle> pending_shadow_retirements; };
${cppFunction(generated, "void retire_scene_shadow_states(Scene& scene)")}
int main() {
 Engine engine;
 engine.shadow_generators[0].caster_tasks = {{0},{2}};
 engine.shadow_generators[0].map_target = {0};
 engine.shadow_generators[0].caster_meshes = {{17}};
 engine.shadow_generators[0].csm_cascades.resize(4);
 engine.shadow_generators[1].caster_tasks = {{1}};
 engine.shadow_generators[1].map_target = {1};
 auto payload=std::make_shared<int>(42); std::weak_ptr<int> retained=payload;
 engine.frame_tasks[0].payload=payload; engine.render_targets[0].payload=payload; payload.reset();
 Scene scene{&engine, {{1}}, {{0},{1},{2}}, {{0},{0},{1}}};
 retire_scene_shadow_states(scene);
 assert(retained.expired() && scene.tasks.size()==1 && scene.tasks[0].value==1);
 assert(engine.render_targets.size()==2 && engine.render_targets[0].retired && !engine.render_targets[1].retired);
 assert(engine.frame_tasks.size()==3 && !engine.frame_tasks[0].execution_enabled && engine.frame_tasks[1].execution_enabled && !engine.frame_tasks[2].execution_enabled);
 assert(engine.shadow_generators.size()==2 && engine.shadow_generators[0].map_target.value==999);
 assert(engine.shadow_generators[0].caster_tasks.capacity()==0 && engine.shadow_generators[0].csm_cascades.capacity()==0);
 assert(engine.shadow_generators[0].caster_meshes[0].value==17 && engine.shadow_generators[0].map_size==1024);
 assert(engine.shadow_generators[1].map_target.value==1 && engine.shadow_generators[1].caster_tasks.size()==1);
 assert(engine.lights[0].shadow_generator.value==999 && engine.lights[1].shadow_generator.value==1);
 assert(engine.render_targets_version==1 && scene.pending_shadow_retirements.empty());
 retire_scene_shadow_states(scene); assert(engine.render_targets_version==1);
 // The scene-dispose drain runs after clearing membership.
 scene.pending_shadow_retirements={{1}}; scene.lights.clear(); retire_scene_shadow_states(scene);
 assert(engine.render_targets[1].retired && engine.render_targets_version==2);
}
`,
    );
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/Inative/include",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        source,
    ]);
    execFileSync(executable);
});

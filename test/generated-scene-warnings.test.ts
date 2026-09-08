import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { PhysicsLowerer } from "../src/lowering/physics-lowerer.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const nativeTools = optionalNativeFixtureTools();
test("conditional object spreads retain fresh identity through a returned callback", { skip: !nativeTools }, () => {
    for (const active of [false, true]) runScene(`conditional-spread-${active}`, `
        const idle = { x: 0, y: -0.5, z: 0 };
        const walking = { x: 0.7, y: -0.5, z: 2 };
        function wire(input: { x: number; y: number; z: number }): () => void {
            return () => { input.x = 5; input.z += 1; };
        }
        const input = ${active} ? { ...walking } : { ...idle };
        const callback = wire(input);
        callback(); callback();
        if (input.x !== 5 || input.z !== ${active ? 4 : 2}) throw new Error("Callback lost input object identity.");
        if (idle.x !== 0 || walking.x !== 0.7) throw new Error("Object spread mutated its source.");
    `, "int main() { return generated_scene_main(); }");
});

const raycastSource = `
    import HavokPhysics from "@babylonjs/havok";
    import { createEngine, createSceneContext, createBox, createHavokWorld,
        physicsRaycast, onBeforeRender } from "@babylonjs/lite";
    const engine = await createEngine({});
    const scene = createSceneContext(engine);
    const box = createBox(engine);
    const havok = await HavokPhysics();
    const world = createHavokWorld(scene, havok);
    if (physicsRaycast(world, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }).hasHit) {
        box.position.x = 7;
    } else {
        box.position.x = -7;
    }
    onBeforeRender(scene, () => {
        if (physicsRaycast(world, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }).hasHit) {
            box.position.y = 8;
        } else {
            box.position.y = -8;
        }
    });
`;

test("direct raycast-result conditions emit one call per source evaluation", () => {
    const { cpp } = compileSource(raycastSource);
    assert.equal(cpp.match(/bbl::upstream::physics_raycast\(/g)?.length, 2);
});

function runScene(name: string, source: string, observer: string, physics = false): void {
    const output = resolve("artifacts/generated-scene-warnings", name);
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "program.hpp"), compileSource(source).cpp);
    if (physics) {
        const includes = join(output, "bblite/upstream");
        mkdirSync(includes, { recursive: true });
        writeFileSync(join(includes, "physics.hpp"),
            new PhysicsLowerer(new LoweringContext()).lowerPhysics().header);
    }
    const fixture = join(output, "check.cpp");
    writeFileSync(fixture, `
#define main generated_scene_main
#include "program.hpp"
#undef main
#include <cassert>
// The complete accepted program and its callback environments compile unchanged.
// Runtime entry points observe control flow without creating a window or solver.
namespace bbl {
Scene create_scene_context(Engine& engine) { Scene scene; scene.engine = &engine; return scene; }
void mark_mesh_dirty(Engine&, MeshHandle) {}
void mark_mesh_runtime_transform(Engine&, MeshHandle) {}
}
${observer}
`);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", "/I", output, fixture,
        "test/fixtures/js-callback/data-engine-stubs.cpp",
    ]);
    execFileSync(executable, { encoding: "utf8" });
}

test("direct raycast conditions compile warning-clean and evaluate hits and misses once", { skip: !nativeTools }, () => {
    runScene("raycast", raycastSource, `
namespace { bool has_hit = false; unsigned raycasts = 0; }
namespace bbl::upstream {
PhysicsWorldHandle create_havok_world(Scene&, Vec3d) { return {}; }
PhysicsRaycastResult physics_raycast(PhysicsWorldHandle, Vec3d from, Vec3d to,
    std::uint32_t membership, std::uint32_t collide_with, bool should_hit_triggers) {
    ++raycasts;
    assert(from.x == 0 && from.y == 1 && from.z == 0);
    assert(to.x == 0 && to.y == -1 && to.z == 0);
    assert(membership == 0xffffffffu && collide_with == 0xffffffffu);
    assert(!should_hit_triggers);
    return {.has_hit = has_hit};
}
}
namespace bbl {
void on_before_render(Scene& scene, js::Callback<void(float)> callback) {
    assert(raycasts == 1);
    assert(scene.engine->meshes[0].position.x == (has_hit ? 7 : -7));
    for (const bool hit : {false, true}) {
        has_hit = hit;
        const auto before = raycasts;
        callback(16.0f);
        assert(raycasts == before + 1);
        assert(scene.engine->meshes[0].position.y == (hit ? 8 : -8));
    }
}
}
int main() {
    for (const bool hit : {false, true}) {
        has_hit = hit;
        raycasts = 0;
        assert(generated_scene_main() == 0);
        assert(raycasts == 3);
    }
}
`, true);
});

test("Vec3 literals in frame callbacks compile warning-clean and preserve live components", { skip: !nativeTools }, () => {
    runScene("frame-vec3", `
        import { createEngine, createSceneContext, createBox, onBeforeRender } from "@babylonjs/lite";
        import type { Vec3 } from "@babylonjs/lite";
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        const box = createBox(engine);
        onBeforeRender(scene, (deltaMs) => {
            const point: Vec3 = { x: deltaMs / 1000, y: 2, z: -3 };
            box.position.set(point.x, point.y, point.z);
            const rotation = { x: 0, y: 1, z: 2 };
            box.rotation.set(rotation.x, rotation.y, rotation.z);
        });
    `, `
namespace bbl {
void on_before_render(Scene& scene, js::Callback<void(float)> callback) {
    for (const float delta : {16.0f, 32.0f}) {
        callback(delta);
        const auto& mesh = scene.engine->meshes[0];
        assert(mesh.position.x == static_cast<double>(delta) / 1000.0);
        assert(mesh.position.y == 2 && mesh.position.z == -3);
        assert(mesh.rotation.x == 0 && mesh.rotation.y == 1 && mesh.rotation.z == 2);
    }
}
}
int main() { assert(generated_scene_main() == 0); }
`);
});

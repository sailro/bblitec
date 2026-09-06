import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

test("physics rays preserve body Map identity and keep absent-body lookups behind guards", { skip: !tools }, () => {
    const output = resolve("artifacts/physics-raycast-body");
    mkdirSync(output, { recursive: true });
    const source = `
        import HavokPhysics from "@babylonjs/havok";
        import { createEngine, createSceneContext, createHavokWorld, createBox,
            createPhysicsBody, createPhysicsShape, setPhysicsBodyShape, PhysicsMotionType,
            PhysicsShapeType, onPhysicsAfterStep, registerScene, startEngine } from "babylon-lite";
        import { physicsRaycast } from "babylon-lite";
        import type { PhysicsBody } from "babylon-lite";
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        const world = createHavokWorld(scene, await HavokPhysics());
        const mesh = createBox(engine);
        const first = createPhysicsBody(world, mesh, PhysicsMotionType.STATIC);
        const shape = createPhysicsShape(world, { type: PhysicsShapeType.BOX,
            parameters: { extents: { x: 2, y: 2, z: 2 } } });
        setPhysicsBodyShape(world, first, shape);
        const farMesh = createBox(engine); farMesh.position.x = 10;
        const other = createPhysicsBody(world, farMesh, PhysicsMotionType.STATIC);
        setPhysicsBodyShape(world, other, shape);
        const indices = new Map<PhysicsBody, number>();
        indices.set(first, 7); indices.set(other, 19);
        onPhysicsAfterStep(world, () => {
            const origin = { x: 0, y: 0, z: 5 + 2 ** -25 };
            const hit = physicsRaycast(world, origin, { x: 0, y: 0, z: 0 });
            const again = physicsRaycast(world, origin, { x: 0, y: 0, z: 0 });
            const index = hit.hasHit && hit.body ? (indices.get(hit.body) ?? -1) : -1;
            if (index !== 7) throw new Error("ray Map identity changed");
            const roundedDistance = new Float32Array([hit.hitDistance]);
            if (hit.hitDistance !== origin.z - hit.hitPoint.z || hit.hitDistance === roundedDistance[0])
                throw new Error("ray distance lost double precision");
            if (Math.abs(hit.hitPoint.z - 1) > 0.000001) throw new Error("ray point changed");
            if (hit.hitNormal.z !== 1) throw new Error("ray normal changed");
            if (!again.body || again.body !== first || again.body !== hit.body)
                throw new Error("repeated ray lost original body identity");
            indices.set(again.body, 11);
            if (indices.size !== 2 || indices.get(first) !== 11 || indices.get(other) !== 19)
                throw new Error("ray key does not update the original Map entry");
            // Measured against pinned Havok: exact endpoint and float-rounded
            // just-inside endpoints miss; extending the ray would change them.
            for (const z of [1.00001, 1, 0.9999999]) {
                const miss = physicsRaycast(world, origin, { x: 0, y: 0, z });
                const missingIndex = miss.hasHit && miss.body ? (indices.get(miss.body) ?? -1) : -1;
                if (miss.hasHit || miss.body || missingIndex !== -1 || miss.hitDistance !== 0)
                    throw new Error("segment endpoint miss changed");
            }
            const inside = physicsRaycast(world, origin, { x: 0, y: 0, z: 0.999999 });
            if (!inside.body || indices.get(inside.body) !== 11)
                throw new Error("inside segment must hit the mapped body");
        });
        registerScene(scene);
        startEngine(engine);
    `;
    const compiled = compileSource(source);
    emitUpstreamGenerated(output, [...compiled.manifest.features, "camera:free", "renderer:scene"]);
    writeFileSync(join(output, "program.hpp"), compiled.cpp);
    writeFileSync(join(output, "check.cpp"), `
        #include "pal_physics_bullet.cpp"
        #include "physics.cpp"
        #define main generated_scene_main
        #include "program.hpp"
        #undef main
        #include <cassert>
        namespace bbl::upstream {
        std::array<float, 16> mesh_local_matrix(const MeshRecord&) { std::abort(); }
        }
        namespace bbl {
        Scene create_scene_context(Engine& engine) { Scene scene; scene.engine = &engine; return scene; }
        void mark_mesh_dirty(Engine&, MeshHandle) {}
        void mark_mesh_runtime_transform(Engine&, MeshHandle) {}
        void mark_transform_node_runtime_transform(Engine&, TransformNodeHandle) {}
        void register_scene(Scene& scene) { scene.engine->registered_scenes.push_back(std::make_shared<Scene>(scene)); }
        void start_engine(Engine& engine) {
            assert(engine.registered_scenes.size() == 1);
            for (const auto& callback : engine.registered_scenes[0]->before_render) callback(1000.0f / 60.0f);
        }
        }
        int main() {
            assert(generated_scene_main() == 0);
            // Havok's findBodyById returns null for a solver hit whose body
            // is not in the querying world's tracked list.
            bbl::Engine engine;
            bbl::Scene scene; scene.engine = &engine;
            const auto world = bbl::upstream::create_havok_world(scene, {0, 0, 0});
            const auto native = world.ownership.lock()->handle;
            const auto body = bbl::pal::physics_body_create();
            bbl::pal::physics_body_set_shape(body, bbl::pal::physics_shape_create_box({0,0,0},{0,0,0,1},{2,2,2}));
            bbl::pal::physics_world_add_body(native, body, false);
            bbl::pal::physics_world_step(native, 1.0/60);
            const auto hit = bbl::upstream::physics_raycast(world, {0,0,5}, {0,0,0}, ~0u, ~0u);
            assert(hit.has_hit && !hit.body);
        }
    `);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2", "/Gy",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/src", "/I", "native/include",
        "/I", join(output, "upstream/include"), "/I", join(output, "upstream/src"),
        `/external:I${join(nativeFixtureVcpkgRoot, "include/bullet")}`, "/external:W0",
        join(output, "check.cpp"), "test/fixtures/js-callback/data-engine-stubs.cpp",
        "/link", "/OPT:REF", `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
        "BulletDynamics.lib", "BulletCollision.lib", "LinearMath.lib",
    ]);
    execFileSync(executable, {
        encoding: "utf8",
        env: { ...tools!.environment, PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}` },
    });
});

test("exact scene103 retains automatic body lookup and default-query matrix picking", () => {
    const fileName = "corpus/babylon-lite/lab/lite/src/lite/scene103.ts";
    const source = readFileSync(fileName, "utf8");
    const automatic = compileSource(source, { fileName, search: "?captureFrame=5" });
    assert.match(automatic.cpp, /bodyToInstance\.get\(/);
    const interactive = compileSource(source, { fileName });
    assert.ok(interactive.manifest.features.includes("math:mat4-invert"));
    assert.match(interactive.cpp, /mat4_invert_array/);
});

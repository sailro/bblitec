import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import HavokPhysics, { type HP_BodyId, type HP_CollectorId, type HP_WorldId } from "@babylonjs/havok";
import { compileSource } from "../src/compiler.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

test("pinned Havok ray queries select the closest body after trigger and mask filtering", async () => {
    const require = createRequire(import.meta.url);
    const wasmBinary = new Uint8Array(readFileSync(require.resolve("@babylonjs/havok/lib/esm/HavokPhysics.wasm"))).buffer;
    const hknp = await HavokPhysics({ wasmBinary });
    interface Body { _hkBody: HP_BodyId }
    interface World {
        _hknp: typeof hknp;
        _hkWorld: HP_WorldId;
        _bodies: Body[];
        _queryCollector?: HP_CollectorId;
    }
    interface Query { membership?: number; collideWith?: number; shouldHitTriggers?: boolean }
    interface Point { x: number; y: number; z: number }
    const { physicsRaycast } = await importPinnedModule<{
        physicsRaycast(world: World, from: Point, to: Point, query?: Query): {
            hasHit: boolean; body: Body | null; hitPoint: Point;
        };
    }>("physics/havok-queries.js");
    const solid = { _hkBody: hknp.HP_Body_Create()[1] };
    const trigger = { _hkBody: hknp.HP_Body_Create()[1] };
    const shapes = [hknp.HP_Shape_CreateBox([0, 0, 0], [0, 0, 0, 1], [2, 2, 2])[1],
        hknp.HP_Shape_CreateBox([0, 0, 0], [0, 0, 0, 1], [1, 1, 1])[1]];
    const world: World = { _hknp: hknp, _hkWorld: hknp.HP_World_Create()[1], _bodies: [solid, trigger] };
    try {
        for (const [index, body] of world._bodies.entries()) {
            hknp.HP_Body_SetMotionType(body._hkBody, hknp.MotionType.STATIC);
            hknp.HP_Body_SetShape(body._hkBody, shapes[index]!);
            hknp.HP_Body_SetQTransform(body._hkBody, [[0, 0, index === 0 ? 0 : 3], [0, 0, 0, 1]]);
            hknp.HP_World_AddBody(world._hkWorld, body._hkBody, false);
        }
        hknp.HP_Shape_SetFilterInfo(shapes[0]!, [1, -1]);
        hknp.HP_Shape_SetFilterInfo(shapes[1]!, [2, 4]);
        hknp.HP_Shape_SetTrigger(shapes[1]!, true);
        hknp.HP_World_Step(world._hkWorld, 1 / 60);
        const ray = (query?: Query, z = 0) => physicsRaycast(world, { x: 0, y: 0, z: 5 }, { x: 0, y: 0, z }, query);
        assert.equal(ray().body, solid);
        assert.equal(ray({ shouldHitTriggers: false }).body, solid);
        assert.equal(ray({ shouldHitTriggers: true }).body, trigger);
        assert.equal(ray({ shouldHitTriggers: true }).hitPoint.z, 3.5);
        for (const include of [true, false, true]) {
            assert.equal(ray({ shouldHitTriggers: include }).body, include ? trigger : solid);
            assert.equal(ray({ shouldHitTriggers: include }, 2).body, include ? trigger : null);
        }
        assert.equal(ray({ membership: 4, collideWith: 1, shouldHitTriggers: true }).body, solid);
        assert.equal(ray({ membership: 4, collideWith: 2, shouldHitTriggers: true }).body, trigger);
        assert.equal(ray({ membership: 8, collideWith: 2, shouldHitTriggers: true }).body, null);
        assert.equal(ray({ membership: 4, collideWith: 2, shouldHitTriggers: false }).body, null);
        hknp.HP_Shape_SetTrigger(shapes[1]!, false);
        assert.equal(ray().body, trigger);
        hknp.HP_Shape_SetTrigger(shapes[1]!, true);
        assert.equal(ray().body, solid);
    } finally {
        if (world._queryCollector) hknp.HP_QueryCollector_Release(world._queryCollector);
        for (const body of world._bodies) {
            hknp.HP_World_RemoveBody(world._hkWorld, body._hkBody);
            hknp.HP_Body_Release(body._hkBody);
        }
        for (const shape of shapes) hknp.HP_Shape_Release(shape);
        hknp.HP_World_Release(world._hkWorld);
    }
});

test("physics rays preserve body Map identity, trigger filtering and guarded misses", { skip: !tools }, () => {
    const output = resolve("artifacts/physics-raycast-body");
    mkdirSync(output, { recursive: true });
    const source = `
        import HavokPhysics from "@babylonjs/havok";
        import { createEngine, createSceneContext, createHavokWorld, createBox,
            createPhysicsBody, createPhysicsShape, setPhysicsBodyShape, setPhysicsShapeIsTrigger, PhysicsMotionType,
            setPhysicsShapeFilterMembershipMask, setPhysicsShapeFilterCollideMask,
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
        setPhysicsShapeFilterMembershipMask(world, shape, 1);
        setPhysicsBodyShape(world, first, shape);
        const farMesh = createBox(engine); farMesh.position.x = 10;
        const other = createPhysicsBody(world, farMesh, PhysicsMotionType.STATIC);
        setPhysicsBodyShape(world, other, shape);
        const triggerMesh = createBox(engine); triggerMesh.position.z = 3;
        const triggerBody = createPhysicsBody(world, triggerMesh, PhysicsMotionType.STATIC);
        const triggerShape = createPhysicsShape(world, { type: PhysicsShapeType.BOX,
            parameters: { extents: { x: 1, y: 1, z: 1 } } });
        setPhysicsShapeFilterMembershipMask(world, triggerShape, 2);
        setPhysicsShapeFilterCollideMask(world, triggerShape, 4);
        setPhysicsBodyShape(world, triggerBody, triggerShape);
        setPhysicsShapeIsTrigger(world, triggerShape, true);
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
            const explicitFalse = physicsRaycast(world, origin, { x: 0, y: 0, z: 0 }, { shouldHitTriggers: false });
            if (!explicitFalse.body || explicitFalse.body !== first)
                throw new Error("explicit trigger exclusion changed");
            const includeTrigger = physicsRaycast(world, origin, { x: 0, y: 0, z: 0 }, { shouldHitTriggers: true });
            if (!includeTrigger.body || includeTrigger.body !== triggerBody || includeTrigger.hitPoint.z !== 3.5)
                throw new Error("nearer trigger did not win when included");
            const choices = new Uint8Array([1, 0, 1]);
            for (let i = 0; i < choices.length; i++) {
                const include = choices[i] !== 0;
                const selected = physicsRaycast(world, origin, { x: 0, y: 0, z: 0 }, { shouldHitTriggers: include });
                if (!selected.body) throw new Error("runtime ray lost its body");
                if (include) {
                    if (selected.body !== triggerBody) throw new Error("runtime trigger inclusion failed");
                } else if (selected.body !== first) {
                    throw new Error("runtime trigger exclusion failed");
                }
                const triggerOnly = physicsRaycast(world, origin, { x: 0, y: 0, z: 2 }, { shouldHitTriggers: include });
                if (triggerOnly.hasHit !== include) throw new Error("trigger-only segment miss changed");
                if (include) {
                    if (!triggerOnly.body) throw new Error("trigger-only hit lost its body");
                } else if (triggerOnly.body) {
                    throw new Error("trigger-only miss retained a body");
                }
            }
            const maskedSolid = physicsRaycast(world, origin, { x: 0, y: 0, z: 0 },
                { membership: 4, collideWith: 1, shouldHitTriggers: true });
            if (!maskedSolid.body || maskedSolid.body !== first) throw new Error("ray collide mask ignored");
            const maskedTrigger = physicsRaycast(world, origin, { x: 0, y: 0, z: 0 },
                { membership: 4, collideWith: 2, shouldHitTriggers: true });
            if (!maskedTrigger.body || maskedTrigger.body !== triggerBody) throw new Error("matching trigger mask missed");
            const mismatched = physicsRaycast(world, origin, { x: 0, y: 0, z: 0 },
                { membership: 8, collideWith: 2, shouldHitTriggers: true });
            if (mismatched.hasHit || mismatched.body) throw new Error("ray membership mask ignored");
            const excludedTrigger = physicsRaycast(world, origin, { x: 0, y: 0, z: 0 },
                { membership: 4, collideWith: 2, shouldHitTriggers: false });
            if (excludedTrigger.hasHit || excludedTrigger.body) throw new Error("trigger flag bypassed masks");
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
            setPhysicsShapeIsTrigger(world, triggerShape, false);
            const nowSolid = physicsRaycast(world, origin, { x: 0, y: 0, z: 0 });
            if (!nowSolid.body || nowSolid.body !== triggerBody) throw new Error("cleared trigger flag stayed excluded");
            setPhysicsShapeIsTrigger(world, triggerShape, true);
            const nowTrigger = physicsRaycast(world, origin, { x: 0, y: 0, z: 0 });
            if (!nowTrigger.body || nowTrigger.body !== first) throw new Error("restored trigger flag stayed eligible");
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
std::array<float, 16> mesh_world_matrix(const Engine&, const MeshRecord&) { std::abort(); }
std::array<float, 16> transform_node_world(const Engine&, TransformNodeHandle) { std::abort(); }
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
            const auto hit = bbl::upstream::physics_raycast(world, {0,0,5}, {0,0,0}, ~0u, ~0u, false);
            assert(hit.has_hit && !hit.body);
        }
    `);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2", "/Gy",
        "/DBBLITE_HAS_PHYSICS_TRIGGER=1",
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

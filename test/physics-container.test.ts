import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import HavokPhysics, { type HP_BodyId, type HP_ShapeId } from "@babylonjs/havok";
import { join, resolve } from "node:path";
import test from "node:test";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { compileSource } from "../src/compiler.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

test("Havok containers preserve leaf materials and reference-counted shape storage", async () => {
    const require = createRequire(import.meta.url);
    const hp = await HavokPhysics({
        wasmBinary: new Uint8Array(readFileSync(require.resolve("@babylonjs/havok/lib/esm/HavokPhysics.wasm"))).buffer,
    });
    const container = hp.HP_Shape_CreateContainer()[1];
    const child = hp.HP_Shape_CreateSphere([0,0,0], .5)[1];
    assert.equal(hp.HP_Shape_AddChild(container, child, [[0,0,0],[0,0,0,1],[1,1,1]]), hp.Result.RESULT_OK);
    const before = hp.HP_Shape_GetMaterial(child);
    assert.equal(before[0], hp.Result.RESULT_OK);
    assert.deepEqual(before[1].slice(0,3), [.5,.5,0]);
    assert.equal(before[1][3], hp.MaterialCombine.GEOMETRIC_MEAN);
    assert.equal(before[1][4], hp.MaterialCombine.GEOMETRIC_MEAN);
    assert.equal(
        hp.HP_Shape_SetMaterial(container, [.8,.8,.6,hp.MaterialCombine.MINIMUM,hp.MaterialCombine.MAXIMUM]),
        hp.Result.RESULT_NOTIMPLEMENTED,
    );
    assert.deepEqual(hp.HP_Shape_GetMaterial(child)[1], before[1]);
    const body = hp.HP_Body_Create()[1];
    hp.HP_Body_SetShape(body, container);
    assert.equal(hp.HP_Shape_Release(child), hp.Result.RESULT_OK);
    assert.equal(hp.HP_Shape_Release(container), hp.Result.RESULT_OK);
    hp.HP_Body_Release(body);
    const velocities: number[] = [];
    for (const modes of [
        [hp.MaterialCombine.MINIMUM, hp.MaterialCombine.MAXIMUM],
        [hp.MaterialCombine.MAXIMUM, hp.MaterialCombine.MINIMUM],
        [hp.MaterialCombine.GEOMETRIC_MEAN, hp.MaterialCombine.GEOMETRIC_MEAN],
    ]) {
        const world = hp.HP_World_Create()[1];
        hp.HP_World_SetGravity(world, [0,0,0]);
        const bodies: HP_BodyId[] = [], shapes: HP_ShapeId[] = [];
        for (let index = 0; index < 2; ++index) {
            const shape = hp.HP_Shape_CreateSphere([0,0,0], .5)[1];
            shapes.push(shape);
            hp.HP_Shape_SetMaterial(shape, [0,0,index ? .8 : .2,hp.MaterialCombine.MINIMUM,modes[index]!]);
            const body = hp.HP_Body_Create()[1];
            bodies.push(body);
            hp.HP_Body_SetShape(body, shape);
            hp.HP_Body_SetMotionType(body, index ? hp.MotionType.DYNAMIC : hp.MotionType.STATIC);
            hp.HP_Body_SetQTransform(body, [[index ? 2 : 0,0,0],[0,0,0,1]]);
            if (index) {
                hp.HP_Body_SetMassProperties(body, [[0,0,0],1,[1,1,1],[0,0,0,1]]);
                hp.HP_Body_SetLinearDamping(body, 0);
                hp.HP_Body_SetLinearVelocity(body, [-2,0,0]);
            }
            hp.HP_World_AddBody(world, body, false);
        }
        for (let frame = 0; frame < 180; ++frame) hp.HP_World_Step(world, 1/120);
        velocities.push(hp.HP_Body_GetLinearVelocity(bodies[1]!)[1][0]);
        for (const body of bodies) {
            hp.HP_World_RemoveBody(world, body);
            hp.HP_Body_Release(body);
        }
        for (const shape of shapes) hp.HP_Shape_Release(shape);
        hp.HP_World_Release(world);
    }
    assert(velocities[0]! > 1);
    assert.equal(velocities[0], velocities[1]);
    assert(Math.abs(velocities[2]! / velocities[0]! - .5) < 1e-5);
});

test("direct physics children retain omitted and explicit transform records", () => {
    const result =
        compileSource(`import {createEngine,createSceneContext,createHavokWorld,createPhysicsShape,PhysicsShapeType,addPhysicsShapeChild} from "@babylonjs/lite";
    import HavokPhysics from "@babylonjs/havok";
    async function main(){const engine=await createEngine({});const scene=createSceneContext(engine);const world=createHavokWorld(scene,await HavokPhysics());
    const container=createPhysicsShape(world,{type:PhysicsShapeType.CONTAINER});const sphere=createPhysicsShape(world,{type:PhysicsShapeType.SPHERE,parameters:{radius:1}});
    addPhysicsShapeChild(world,container,sphere);
    addPhysicsShapeChild(world,container,sphere,{x:2,y:3,z:4},{x:0,y:0,z:0,w:1},{x:2,y:2,z:2});}main();`);
    assert(result.manifest.features.includes("physics:container"));
    assert.match(result.cpp, /add_physics_shape_child\(/);
});

test(
    "physics containers preserve pinned relative transforms, concavity, ownership and singular refusal",
    { skip: !tools },
    () => {
        const output = resolve("artifacts/physics-container-check");
        mkdirSync(output, { recursive: true });
        emitUpstreamGenerated(output, [
            "core",
            "camera:free",
            "renderer:scene",
            "physics:world",
            "physics:container",
        ]);
        const executable = join(output, "physics-container-check.exe");
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            "/MD",
            "/O2",
            "/Gy",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/src",
            "/I",
            "native/include",
            "/I",
            join(output, "upstream/include"),
            "/I",
            join(output, "upstream/src"),
            `/external:I${join(nativeFixtureVcpkgRoot, "include/bullet")}`,
            "/external:W0",
            "test/fixtures/physics-container-check.cpp",
            join(output, "upstream/src/scene_core.cpp"),
            "/link",
            "/OPT:REF",
            `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
            "BulletDynamics.lib",
            "BulletCollision.lib",
            "LinearMath.lib",
        ]);
        const result = execFileSync(executable, {
            encoding: "utf8",
            env: {
                ...tools!.environment,
                PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}`,
            },
        });
        assert.match(result, /physics-container-check: ok/);
    },
);

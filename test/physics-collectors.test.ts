import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import HavokPhysics from "@babylonjs/havok";
import type { HP_BodyId, Vector3 } from "@babylonjs/havok";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

test("shape collectors preserve Havok capsule features, mesh edges, body identity and filters", { skip: !tools }, async () => {
    const output = resolve("artifacts/physics-collectors");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "physics-collectors-check.exe");
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2",
        "/DBBLITE_HAS_PHYSICS_CHARACTER=1", "/DBBLITE_HAS_PHYSICS_TRIGGER=1",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/src", "/I", "native/include",
        `/external:I${join(nativeFixtureVcpkgRoot, "include/bullet")}`, "/external:W0",
        "test/fixtures/physics-collectors-check.cpp", "/link",
        `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
        "BulletDynamics.lib", "BulletCollision.lib", "LinearMath.lib",
    ]);
    const actual: { queries: number[][][]; defaultMasses: number[] } = JSON.parse(execFileSync(executable, {
        encoding: "utf8", env: { ...tools!.environment, PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}` },
    }));
    const native = actual.queries;
    const require = createRequire(import.meta.url);
    const hp = await HavokPhysics({ wasmBinary: new Uint8Array(readFileSync(require.resolve("@babylonjs/havok/lib/esm/HavokPhysics.wasm"))).buffer });
    const world = hp.HP_World_Create()[1];
    const capsule = hp.HP_Shape_CreateCapsule([0, .3, 0], [0, -.3, 0], .6)[1];
    const box = hp.HP_Shape_CreateBox([0, 0, 0], [0, 0, 0, 1], [.2, 2, 2])[1];
    const vertices = hp._malloc(48), indices = hp._malloc(24);
    hp.HEAPF32.set([-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5], vertices / 4);
    hp.HEAP32.set([0, 2, 1, 0, 3, 2], indices / 4);
    const floor = hp.HP_Shape_CreateMesh(vertices, 4, indices, 2)[1];
    hp._free(vertices); hp._free(indices);
    const bodies: HP_BodyId[] = [];
    const collector = hp.HP_QueryCollector_Create(16)[1];
    const reference: number[][][] = [];
    const massShapes = [capsule, hp.HP_Shape_CreateBox([0,0,0], [0,0,0,1], [2,3,4])[1], hp.HP_Shape_CreateSphere([0,0,0], .5)[1]];
    const referenceMasses = massShapes.map(shape => hp.HP_Shape_BuildMassProperties(shape)[1][1]);
    try {
        hp.HP_World_SetGravity(world, [0, 0, 0]);
        const positions: Vector3[] = [[0, 0, 0], [.75, 1, 0], [-.75, 1, 0], [0, .9, 0]];
        for (const [i, shape] of [floor, box, box, capsule].entries()) {
            const body = hp.HP_Body_Create()[1];
            hp.HP_Body_SetShape(body, shape); hp.HP_Body_SetMotionType(body, hp.MotionType.STATIC);
            hp.HP_Body_SetQTransform(body, [positions[i]!, [0, 0, 0, 1]]);
            hp.HP_World_AddBody(world, body, false); bodies.push(body);
        }
        hp.HP_World_Step(world, 1 / 60);
        for (const cast of [false, true]) {
            if (cast) hp.HP_World_ShapeCastWithCollector(world, collector, [capsule, [0, 0, 0, 1], [0, .9, 0], [2, .9, 0], false, bodies[3]!]);
            else hp.HP_World_ShapeProximityWithCollector(world, collector, [capsule, [0, .9, 0], [0, 0, 0, 1], .15, false, bodies[3]!]);
            reference.push(Array.from({ length: hp.HP_QueryCollector_GetNumHits(collector)[1] }, (_, i) => {
                const hit = cast ? hp.HP_QueryCollector_GetShapeCastResult(collector, i)[1] : hp.HP_QueryCollector_GetShapeProximityResult(collector, i)[1];
                return [bodies.findIndex(body => body[0] === hit[2][0][0]), hit[0], ...hit[1][3], ...hit[2][3], ...hit[1][4], ...hit[2][4]];
            }));
        }
    } finally {
        hp.HP_QueryCollector_Release(collector);
        for (const body of bodies) { hp.HP_World_RemoveBody(world, body); hp.HP_Body_Release(body); }
        for (const shape of [capsule, box, floor]) hp.HP_Shape_Release(shape);
        for (const shape of massShapes.slice(1)) hp.HP_Shape_Release(shape);
        hp.HP_World_Release(world);
    }
    assert.deepEqual(native.map(hits => hits.length), reference.map(hits => hits.length));
    const errors = native.map((hits, query) => hits.map((hit, i) => hit.map((value, lane) => Math.abs(value - reference[query]![i]![lane]!))));
    const maxError = Math.max(...errors.flat(2));
    writeFileSync(join(output, "comparison.json"), JSON.stringify({ native, reference, maxError }, null, 2) + "\n");
    assert(maxError < 1e-5, `Collector feature error ${maxError}`);
    const massErrors = actual.defaultMasses.map((mass, i) => Math.abs(mass - referenceMasses[i]!) / Math.max(1, referenceMasses[i]!));
    writeFileSync(join(output, "mass-properties.json"), JSON.stringify({ actual: actual.defaultMasses, reference: referenceMasses, relativeErrors: massErrors }, null, 2) + "\n");
    assert(Math.max(...massErrors) < 1e-6, "Default shape mass must preserve Havok density and authored volume.");
});

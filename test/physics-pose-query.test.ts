import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import HavokPhysics from "@babylonjs/havok";
import type { Vector3 } from "@babylonjs/havok";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();
test("teleport retains zero kinematic velocity and capsule box queries preserve rounded features", { skip: !tools }, async () => {
    const directory = resolve("artifacts/physics-pose-query");
    mkdirSync(directory, { recursive: true });
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2",
        "/DBBLITE_HAS_PHYSICS_CHARACTER=1",
        `/Fo:${directory}\\`, `/Fe:${executable}`, "/I", "native/src", "/I", "native/include",
        `/external:I${nativeFixtureVcpkgRoot}/include/bullet`, "/external:W0", "test/fixtures/physics-pose-query-check.cpp",
        "/link", `/LIBPATH:${nativeFixtureVcpkgRoot}/lib`, "BulletDynamics.lib", "BulletCollision.lib", "LinearMath.lib"]);
    const actual: { teleports: number[][][]; boxQueries: number[][][] } = JSON.parse(execFileSync(executable, { encoding: "utf8",
        env: { ...tools!.environment, PATH: `${nativeFixtureVcpkgRoot}/bin;${tools!.environment.PATH ?? ""}` } }));
    const require = createRequire(import.meta.url);
    const hp = await HavokPhysics({ wasmBinary: new Uint8Array(readFileSync(require.resolve("@babylonjs/havok/lib/esm/HavokPhysics.wasm"))).buffer });
    const expected: typeof actual = { teleports: [], boxQueries: [] };
    for (const dt of [1/60,1/120,1/240]) {
        const world = hp.HP_World_Create()[1], body = hp.HP_Body_Create()[1];
        const box = hp.HP_Shape_CreateBox([0,0,0], [0,0,0,1], [1,1,1])[1];
        hp.HP_World_SetGravity(world, [0,0,0]);
        hp.HP_Body_SetShape(body, box); hp.HP_Body_SetMotionType(body, hp.MotionType.KINEMATIC);
        hp.HP_Body_SetQTransform(body, [[5,-2,-4],[0,0,0,1]]); hp.HP_World_AddBody(world, body, false);
        const pose = () => [...hp.HP_Body_GetQTransform(body)[1].flat(), ...hp.HP_Body_GetLinearVelocity(body)[1], ...hp.HP_Body_GetAngularVelocity(body)[1]];
        const states = [pose()]; hp.HP_World_Step(world, dt); states.push(pose());
        hp.HP_Body_SetQTransform(body, [[1,2,3],[0,Math.sin(.2),0,Math.cos(.2)]]); states.push(pose());
        for (let step = 0; step < 2; ++step) { hp.HP_World_Step(world, dt); states.push(pose()); }
        expected.teleports.push(states);
        hp.HP_World_RemoveBody(world, body); hp.HP_Body_Release(body); hp.HP_Shape_Release(box); hp.HP_World_Release(world);
    }
    for (const size of [.2,1,2,10]) for (const y of [0,.3,.6,1.1]) {
        const world = hp.HP_World_Create()[1], body = hp.HP_Body_Create()[1];
        const box = hp.HP_Shape_CreateBox([0,0,0], [0,0,0,1], [size,size,size])[1];
        const capsule = hp.HP_Shape_CreateCapsule([0,.3,0], [0,-.3,0], .6)[1], collector = hp.HP_QueryCollector_Create(8)[1];
        hp.HP_Body_SetShape(body, box); hp.HP_Body_SetMotionType(body, hp.MotionType.STATIC); hp.HP_World_AddBody(world, body, false);
        hp.HP_World_Step(world, 1/60);
        for (const cast of [false,true]) {
            const from: Vector3 = [size/2+.65,y,0];
            if (cast) hp.HP_World_ShapeCastWithCollector(world, collector, [capsule,[0,0,0,1],from,[size/2-.15,y,0],false,[0n]]);
            else hp.HP_World_ShapeProximityWithCollector(world, collector, [capsule,from,[0,0,0,1],.2,false,[0n]]);
            expected.boxQueries.push(Array.from({length: hp.HP_QueryCollector_GetNumHits(collector)[1]}, (_, i) => {
                const hit = cast ? hp.HP_QueryCollector_GetShapeCastResult(collector,i)[1] : hp.HP_QueryCollector_GetShapeProximityResult(collector,i)[1];
                return [hit[0],...hit[1][3],...hit[2][3],...hit[1][4],...hit[2][4]];
            }));
        }
        hp.HP_QueryCollector_Release(collector); hp.HP_World_RemoveBody(world,body); hp.HP_Body_Release(body);
        hp.HP_Shape_Release(box); hp.HP_Shape_Release(capsule); hp.HP_World_Release(world);
    }
    const errors = Object.fromEntries((Object.keys(actual) as (keyof typeof actual)[]).map(key => {
        assert.deepEqual(actual[key].map(values => values.length), expected[key].map(values => values.length), key);
        return [key, Math.max(...actual[key].flatMap((values,i) => values.flatMap((row,j) => row.map((value,k) => Math.abs(value-expected[key][i]![j]![k]!)))))];
    }));
    writeFileSync(join(directory,"comparison.json"), JSON.stringify({ actual, expected, errors }, null, 2));
    assert(errors.teleports! < 1e-6, `Teleport pose/velocity error ${errors.teleports}`);
    assert(errors.boxQueries! < 4e-4, `Rounded box feature error ${errors.boxQueries}`);
});

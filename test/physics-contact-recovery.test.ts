import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import HavokPhysics from "@babylonjs/havok";
import type { HP_BodyId, MassProperties } from "@babylonjs/havok";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();
test("initial overlap recovery stays bounded across depth, timestep, mass and motion type", { skip: !tools }, async () => {
    const directory = resolve("artifacts/physics-contact-recovery");
    mkdirSync(directory, { recursive: true });
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}\\`, `/Fe:${executable}`, "/I", "native/src", "/I", "native/include",
        `/external:I${nativeFixtureVcpkgRoot}/include/bullet`, "/external:W0", "test/fixtures/physics-contact-recovery-check.cpp",
        "/link", `/LIBPATH:${nativeFixtureVcpkgRoot}/lib`, "BulletDynamics.lib", "BulletCollision.lib", "LinearMath.lib"]);
    const actual: number[][][] = JSON.parse(execFileSync(executable, { encoding: "utf8",
        env: { ...tools!.environment, PATH: `${nativeFixtureVcpkgRoot}/bin;${tools!.environment.PATH ?? ""}` } }));
    const require = createRequire(import.meta.url);
    const hp = await HavokPhysics({ wasmBinary: new Uint8Array(readFileSync(require.resolve("@babylonjs/havok/lib/esm/HavokPhysics.wasm"))).buffer });
    const cases: { motion: string; mass: number; dt: number; depth: number; expected: number[][]; actual: number[][] }[] = [];
    for (const [motion, type] of [["static", hp.MotionType.STATIC], ["animated", hp.MotionType.KINEMATIC], ["dynamic", hp.MotionType.DYNAMIC]] as const) {
        for (const mass of [.1, 1, 10]) for (const dt of [1/60, 1/120, 1/240]) for (const depth of [.02, .04, .1, .3, .5]) {
            const world = hp.HP_World_Create()[1];
            hp.HP_World_SetGravity(world, [0,0,0]);
            const shape = hp.HP_Shape_CreateBox([0,0,0], [0,0,0,1], [1,1,1])[1];
            const properties = hp.HP_Shape_BuildMassProperties(shape)[1] as MassProperties;
            properties[1] = mass;
            const bodies: HP_BodyId[] = [];
            for (let i = 0; i < 2; ++i) {
                const body = hp.HP_Body_Create()[1];
                hp.HP_Body_SetShape(body, shape);
                hp.HP_Body_SetMotionType(body, i ? hp.MotionType.DYNAMIC : type);
                hp.HP_Body_SetQTransform(body, [[i ? 1-depth : 0,0,0], [0,0,0,1]]);
                if (i || motion === "dynamic") hp.HP_Body_SetMassProperties(body, properties);
                hp.HP_World_AddBody(world, body, false); bodies.push(body);
            }
            const expected: number[][] = [];
            for (let step = 0; step < 4; ++step) {
                hp.HP_World_Step(world, dt);
                expected.push(bodies.map(body => hp.HP_Body_GetPosition(body)[1][0]));
            }
            cases.push({ motion, mass, dt, depth, expected, actual: actual[cases.length]! });
            for (const body of bodies) { hp.HP_World_RemoveBody(world, body); hp.HP_Body_Release(body); }
            hp.HP_Shape_Release(shape); hp.HP_World_Release(world);
        }
    }
    assert.equal(actual.length, cases.length);
    const errors = cases.flatMap(value => value.actual.flatMap((step, i) => step.map((x, body) => Math.abs(x-value.expected[i]![body]!))));
    const maxPositionError = Math.max(...errors);
    writeFileSync(join(directory, "report.json"), JSON.stringify({ cases, maxPositionError }, null, 2));
    assert(maxPositionError < .01, `Initial overlap recovery error ${maxPositionError}`);
});

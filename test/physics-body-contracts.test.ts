import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import HavokPhysics, { type HP_BodyId } from "@babylonjs/havok";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

test("Bullet preserves Havok speed limits and damping, convex mass frames, filters and contact activation", { skip: !tools }, async () => {
    const output = resolve("artifacts/physics-body-contracts");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2",
        "/DBBLITE_HAS_PHYSICS_FLOATING_ORIGIN=1", "/DBBLITE_HAS_PHYSICS_TRIGGER=1",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/src", "/I", "native/include",
        `/external:I${join(nativeFixtureVcpkgRoot, "include/bullet")}`, "/external:W0",
        "test/fixtures/physics-body-contracts-check.cpp", "/link", `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
        "BulletDynamics.lib", "BulletCollision.lib", "LinearMath.lib"]);
    const actual: { limits: number[]; impulses: number[][]; damped: number[] } = JSON.parse(execFileSync(executable, {
        encoding: "utf8", env: { ...tools!.environment, PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}` },
    }));
    const require = createRequire(import.meta.url);
    const hp = await HavokPhysics({ wasmBinary: new Uint8Array(readFileSync(require.resolve("@babylonjs/havok/lib/esm/HavokPhysics.wasm"))).buffer });
    const world = hp.HP_World_Create()[1], migrated = hp.HP_World_Create()[1];
    hp.HP_World_SetGravity(world, [0,0,0]);
    const shape = hp.HP_Shape_CreateSphere([0,0,0], .5)[1];
    const create = (): HP_BodyId => {
        const body = hp.HP_Body_Create()[1];
        hp.HP_Body_SetShape(body, shape);
        hp.HP_Body_SetMotionType(body, hp.MotionType.DYNAMIC);
        hp.HP_Body_SetMassProperties(body, [[0,0,0], 1, [1,1,1], [0,0,0,1]]);
        hp.HP_World_AddBody(world, body, false);
        return body;
    };
    const velocities = (body: HP_BodyId): number[] => [...hp.HP_Body_GetLinearVelocity(body)[1], ...hp.HP_Body_GetAngularVelocity(body)[1]];
    const limits = hp.HP_World_GetSpeedLimit(world).slice(1);
    assert.deepEqual(actual.limits, limits);
    const body = create(), damped = create();
    try {
        const expected: number[][] = [];
        for (const [linear, angular] of [limits, [7,3], [20,11]]) {
            hp.HP_World_SetSpeedLimit(world, linear!, angular!);
            hp.HP_Body_SetLinearVelocity(body, [0,0,0]);
            hp.HP_Body_SetAngularVelocity(body, [0,0,0]);
            hp.HP_Body_ApplyImpulse(body, [0,1,0], [1000,2000,0]);
            expected.push(velocities(body));
        }
        hp.HP_World_RemoveBody(world, body);
        hp.HP_World_SetSpeedLimit(migrated, 5, 2);
        hp.HP_World_AddBody(migrated, body, false);
        hp.HP_Body_SetLinearVelocity(body, [0,0,0]);
        hp.HP_Body_SetAngularVelocity(body, [0,0,0]);
        hp.HP_Body_ApplyImpulse(body, [0,1,0], [1000,2000,0]);
        expected.push(velocities(body));
        assert.equal(actual.impulses.length, expected.length);
        for (const [row, values] of expected.entries()) for (const [lane, value] of values.entries())
            assert.ok(Math.abs(actual.impulses[row]![lane]! - value) < 1e-4, `impulse ${row}, lane ${lane}`);
        hp.HP_Body_SetLinearVelocity(damped, [1,2,3]);
        hp.HP_Body_SetAngularVelocity(damped, [0,0,10]);
        hp.HP_World_Step(world, 1/60);
        for (const [lane, value] of velocities(damped).entries())
            assert.ok(Math.abs(actual.damped[lane]! - value) < 1e-4, `damping lane ${lane}`);
    } finally {
        hp.HP_World_RemoveBody(migrated, body); hp.HP_Body_Release(body);
        hp.HP_World_RemoveBody(world, damped); hp.HP_Body_Release(damped);
        hp.HP_Shape_Release(shape); hp.HP_World_Release(world); hp.HP_World_Release(migrated);
    }
});

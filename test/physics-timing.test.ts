import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import HavokPhysics, { type HP_WorldId } from "@babylonjs/havok";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

test("native physics and pinned Havok consume equal time at 60 and 240 fps", { skip: !tools }, async () => {
    const require = createRequire(import.meta.url);
    const wasmBinary = new Uint8Array(readFileSync(require.resolve("@babylonjs/havok/lib/esm/HavokPhysics.wasm"))).buffer;
    const hknp = await HavokPhysics({ wasmBinary });
    interface World { _hkWorld: HP_WorldId }
    const pinned = await importPinnedModule<{
        createHavokWorld(scene: { _beforeRender: Array<(ms: number) => void> }, hk: typeof hknp, gravity: { x: number; y: number; z: number }): World;
        setPhysicsTimestepMs(world: World, ms: number): void;
        onPhysicsAfterStep(world: World, callback: (seconds: number) => void): void;
    }>("physics/havok.js");
    const reference: Array<{ mode: string; fps: number; calls: number; seconds: number; distance: number }> = [];
    for (const fixed of [true, false]) for (const fps of [60, 240]) {
        const scene = { _beforeRender: [] as Array<(ms: number) => void> };
        const world = pinned.createHavokWorld(scene, hknp, { x: 0, y: 0, z: 0 });
        const shape = hknp.HP_Shape_CreateSphere([0, 0, 0], 0.5)[1];
        const body = hknp.HP_Body_Create()[1];
        try {
            pinned.setPhysicsTimestepMs(world, fixed ? (1000 / 60 / 8) * 6 : 0);
            hknp.HP_Body_SetShape(body, shape);
            hknp.HP_Body_SetMotionType(body, hknp.MotionType.DYNAMIC);
            hknp.HP_Body_SetMassProperties(body, hknp.HP_Shape_BuildMassProperties(shape)[1]);
            hknp.HP_Body_SetQTransform(body, [[0, 0, 0], [0, 0, 0, 1]]);
            hknp.HP_World_AddBody(world._hkWorld, body, false);
            hknp.HP_Body_SetLinearVelocity(body, [1, 0, 0]);
            let calls = 0, seconds = 0;
            pinned.onPhysicsAfterStep(world, dt => { ++calls; seconds += dt; });
            for (let frame = 0; frame < fps; ++frame) {
                for (const callback of scene._beforeRender) callback(1000 / (fixed ? 60 : fps));
            }
            const distance = hknp.HP_Body_GetQTransform(body)[1][0][0];
            const expected = fixed ? fps * 0.0125 : 1;
            assert.equal(calls, fps);
            assert(Math.abs(seconds - expected) < 1e-10);
            assert(Math.abs(distance - expected) < 1e-5);
            reference.push({ mode: fixed ? "fixed" : "variable", fps, calls, seconds, distance });
        } finally {
            hknp.HP_World_RemoveBody(world._hkWorld, body);
            hknp.HP_Body_Release(body);
            hknp.HP_Shape_Release(shape);
            hknp.HP_World_Release(world._hkWorld);
        }
    }

    const output = resolve("artifacts/physics-timing-check");
    mkdirSync(output, { recursive: true });
    emitUpstreamGenerated(output, ["core", "camera:free", "renderer:scene", "physics:world"]);
    const executable = join(output, "physics-timing-check.exe");
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2", "/Gy",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/src", "/I", "native/include",
        "/I", join(output, "upstream/include"), "/I", join(output, "upstream/src"),
        `/external:I${join(nativeFixtureVcpkgRoot, "include/bullet")}`, "/external:W0",
        "test/fixtures/physics-timing-check.cpp", join(output, "upstream/src/scene_core.cpp"),
        "/link", "/OPT:REF", `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
        "BulletDynamics.lib", "BulletCollision.lib", "LinearMath.lib",
    ]);
    const stdout = execFileSync(executable, {
        encoding: "utf8",
        env: { ...tools!.environment, PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}` },
    });
    const lines = stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, reference.length);
    for (const [index, line] of lines.entries()) {
        const [mode, fps, calls, seconds, distance] = line.split(" ");
        const expected = reference[index]!;
        assert.equal(mode, expected.mode);
        assert.equal(Number(fps), expected.fps);
        assert.equal(Number(calls), expected.calls);
        assert(Math.abs(Number(seconds) - expected.seconds) < 1e-6);
        assert(Math.abs(Number(distance) - expected.distance) < 1e-5);
    }
});

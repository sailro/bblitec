import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import HavokPhysics from "@babylonjs/havok";
import { compileSource } from "../src/compiler.js";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

test("shape queries preserve live cylinder rotation, closest-feature ties and filters", { skip: !tools }, async () => {
    const output = resolve("artifacts/physics-shape-queries");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "physics-queries-check.exe");
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/src", "/I", "native/include",
        `/external:I${join(nativeFixtureVcpkgRoot, "include/bullet")}`, "/external:W0",
        "test/fixtures/physics-queries-check.cpp", "/link",
        `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
        "BulletDynamics.lib", "BulletCollision.lib", "LinearMath.lib",
    ]);
    const native: number[][][] = JSON.parse(execFileSync(executable, {
        encoding: "utf8", env: { ...tools!.environment, PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}` },
    }));
    const require = createRequire(import.meta.url);
    const hknp = await HavokPhysics({ wasmBinary: new Uint8Array(readFileSync(require.resolve("@babylonjs/havok/lib/esm/HavokPhysics.wasm"))).buffer });
    const world = hknp.HP_World_Create()[1];
    const body = hknp.HP_Body_Create()[1];
    const cylinder = hknp.HP_Shape_CreateCylinder([0, -1, 0], [0, 1, 0], .5)[1];
    const capsule = hknp.HP_Shape_CreateCapsule([0, -.5, 0], [0, .5, 0], .5)[1];
    const collector = hknp.HP_QueryCollector_Create(1)[1];
    const reference: number[][][] = [];
    try {
        hknp.HP_World_SetGravity(world, [0, 0, 0]);
        hknp.HP_Body_SetShape(body, capsule);
        hknp.HP_Body_SetMotionType(body, hknp.MotionType.KINEMATIC);
        hknp.HP_Body_SetQTransform(body, [[1, 2.5, 0], [0, 0, 0, 1]]);
        hknp.HP_World_AddBody(world, body, false);
        hknp.HP_World_Step(world, 1 / 60);
        for (const angle of [0, .2, .6, 1.1]) {
            const rotation: [number, number, number, number] = [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
            hknp.HP_World_ShapeProximityWithCollector(world, collector, [cylinder, [-1, 2.5, 0], rotation, 10, false, [0n]]);
            const proximity = hknp.HP_QueryCollector_GetShapeProximityResult(collector, 0)[1];
            hknp.HP_World_ShapeCastWithCollector(world, collector, [cylinder, rotation, [-1, 2.5, 0], [4, 2.5, 0], false, [0n]]);
            const cast = hknp.HP_QueryCollector_GetShapeCastResult(collector, 0)[1];
            reference.push([proximity, cast].map(hit => [1, hit[0], ...hit[1][3], ...hit[2][3], ...hit[1][4], ...hit[2][4]]));
        }
    } finally {
        hknp.HP_QueryCollector_Release(collector);
        hknp.HP_World_RemoveBody(world, body);
        hknp.HP_Body_Release(body);
        hknp.HP_Shape_Release(cylinder);
        hknp.HP_Shape_Release(capsule);
        hknp.HP_World_Release(world);
    }
    const errors = native.map((queries, pose) => queries.map((result, query) => result.map((value, lane) => Math.abs(value - reference[pose]![query]![lane]!))));
    writeFileSync(join(output, "comparison.json"), JSON.stringify({ native, reference, errors }, null, 2) + "\n");
    assert(Math.max(...errors.flat(2)) < .005, `Physics query error ${Math.max(...errors.flat(2))}`);
});

test("scene49 reaches shape queries without replacing authored query and picking flow", () => {
    const path = "corpus/babylon-lite/lab/lite/src/lite/scene49.ts";
    const result = compileSource(readFileSync(path, "utf8"), { fileName: path, search: "?capture" });
    assert(result.manifest.features.includes("physics:queries"));
    assert(result.manifest.features.includes("gizmo:pointer-drag"));
    assert.match(result.cpp, /shape_proximity\(/);
    assert.match(result.cpp, /shape_cast\(/);
    assert.match(result.cpp, /\.rotation_quaternion/);
});

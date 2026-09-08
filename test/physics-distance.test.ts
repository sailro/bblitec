import assert from "node:assert/strict";
import HavokPhysics from "@babylonjs/havok";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();
test("radial constraints preserve measured limit correction, predicted anchors and mixed Cartesian rows", { skip: !tools }, async () => {
    const havok = await HavokPhysics({ wasmBinary: new Uint8Array(readFileSync("node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm")).buffer });
    const cases = [-0.5, 0, 0.5].flatMap(child => [-0.5, 0, 0.5].map(parent => ({ parent, child, y: 2.5, dt: 1 / 60 })));
    for (const dt of [1 / 960, 1 / 480, 1 / 240, 1 / 120, 1 / 30]) cases.push({ parent: 0, child: 0, y: 2.5, dt });
    for (const y of [0.25, 1.5]) cases.push({ parent: 0, child: 0, y, dt: 1 / 60 });
    const observations = [];
    const checks: string[] = [];
    for (const row of cases) {
        const world = havok.HP_World_Create()[1];
        havok.HP_World_SetGravity(world, [0, 0, 0]);
        const shape = havok.HP_Shape_CreateBox([0, 0, 0], [0, 0, 0, 1], [1, 1, 1])[1];
        const a = havok.HP_Body_Create()[1], b = havok.HP_Body_Create()[1];
        havok.HP_Body_SetShape(a, shape); havok.HP_Body_SetShape(b, shape);
        const mass = havok.HP_Shape_BuildMassProperties(shape)[1]; mass[1] = 1;
        havok.HP_Body_SetMassProperties(b, mass); havok.HP_Body_SetMotionType(b, havok.MotionType.DYNAMIC);
        havok.HP_World_AddBody(world, a, false); havok.HP_World_AddBody(world, b, false);
        havok.HP_Body_SetQTransform(b, [[0, row.y, -0.2], [0, 0, 0, 1]]);
        const joint = havok.HP_Constraint_Create()[1];
        havok.HP_Constraint_SetParentBody(joint, a); havok.HP_Constraint_SetChildBody(joint, b);
        havok.HP_Constraint_SetAnchorInParent(joint, [0, row.parent, 0], [1, 0, 0], [0, 1, 0]);
        havok.HP_Constraint_SetAnchorInChild(joint, [0, row.child, 0], [1, 0, 0], [0, 1, 0]);
        havok.HP_Constraint_SetAxisMode(joint, havok.ConstraintAxis.LINEAR_DISTANCE, havok.ConstraintAxisLimitMode.LIMITED);
        havok.HP_Constraint_SetAxisMinLimit(joint, havok.ConstraintAxis.LINEAR_DISTANCE, 1);
        havok.HP_Constraint_SetAxisMaxLimit(joint, havok.ConstraintAxis.LINEAR_DISTANCE, 2);
        havok.HP_Constraint_SetEnabled(joint, 1);
        havok.HP_World_Step(world, row.dt);
        const transform = havok.HP_Body_GetQTransform(b)[1];
        const velocity = havok.HP_Body_GetLinearVelocity(b)[1];
        observations.push({ ...row, transform, velocity, angular: havok.HP_Body_GetAngularVelocity(b)[1] });
        checks.push(`check(${row.parent}, ${row.child}, ${row.y}, ${row.dt}, {{${transform[0].join(",")}}, {${transform[1].join(",")}}}, {${velocity.join(",")}});`);
        havok.HP_Constraint_Release(joint); havok.HP_World_RemoveBody(world, a); havok.HP_World_RemoveBody(world, b);
        havok.HP_Body_Release(a); havok.HP_Body_Release(b); havok.HP_Shape_Release(shape); havok.HP_World_Release(world);
    }
    const output = resolve("artifacts/physics-distance"); mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "havok.json"), JSON.stringify(observations, null, 2) + "\n");
    writeFileSync(join(output, "radial-cases.inc"), checks.join("\n"));
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2", "/Gy",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/src", "/I", "native/include", "/I", output,
        `/external:I${join(nativeFixtureVcpkgRoot, "include/bullet")}`, "/external:W0", "test/fixtures/physics-distance-check.cpp",
        "/link", "/OPT:REF", `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`, "BulletDynamics.lib", "BulletCollision.lib", "LinearMath.lib"]);
    const result = execFileSync(executable, { encoding: "utf8", env: { ...tools!.environment,
        PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}` } });
    assert.match(result, /physics-distance: ok/);
    writeFileSync(join(output, "measurements.txt"), result);
});

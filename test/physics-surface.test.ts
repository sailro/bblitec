import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const helper = readFileSync(
    "corpus/babylon-lite/lab/lite/src/demos/playroom/physics-instances.ts",
    "utf8",
);
const setup = `
import Havok from "@babylonjs/havok";
import {createEngine,createSceneContext,createHavokWorld,createBox,createPhysicsAggregate,PhysicsShapeType,enableHavokThinInstancePhysics} from "babylon-lite";
async function main(){
const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
const scene=createSceneContext(engine);
const world=createHavokWorld(scene, await Havok());
enableHavokThinInstancePhysics(world);
const mesh=createBox(engine,1);
const body=createPhysicsAggregate(world,mesh,PhysicsShapeType.BOX,{mass:1}).body;
applyPhysicsBodyInstanceImpulse(world,body,0,{x:1,y:2,z:3},{x:0,y:0,z:0});
const result={x:0,y:0,z:0}; getPhysicsBodyInstanceLinearVelocityToRef(world,body,0,result);
capturePhysicsBodyInstanceResetState(world,body); resetPhysicsBodyInstances(world,body);
} main();`;

test("the unchanged instance helper lowers its source guards, raw calls and reset storage", () => {
    for (const source of [
        helper,
        helper
            .replaceAll("resolveBodyInstance", "chooseSolverBody")
            .replaceAll("instanceIndex", "selectedIndex"),
    ]) {
        const compiled = compileSource(source + setup, {
            fileName: "physics-instance-helper.ts",
        });
        for (const name of [
            "physics_thin_count",
            "physics_thin_instance",
            "physics_body_world",
            "physics_native_apply_impulse",
            "physics_native_get_linear_velocity",
            "physics_native_get_transform",
            "physics_native_set_transform",
            "physics_native_set_active",
            "thin_instance_matrices",
        ])
            assert.ok(compiled.cpp.includes(name), name);
        assert.match(
            compiled.cpp,
            /Ordinary physics bodies only have instance index 0/,
        );
        assert.match(
            compiled.cpp,
            /Thin-instance reset requires the carrier world transform to remain unchanged/,
        );
        assert.ok(
            compiled.manifest.features.includes("physics:thin-instances"),
        );
    }
});

const tools = optionalNativeFixtureTools(false);
test(
    "raw physics source has compatible optional, tuple and retained array storage in native C++",
    { skip: !tools },
    () => {
        const compiled = compileSource(helper + setup, {
            fileName: "physics-instance-helper.ts",
        });
        const output = resolve("artifacts", "physics-surface-native");
        mkdirSync(output, { recursive: true });
        emitUpstreamGenerated(output, compiled.manifest.features);
        const path = join(output, "check.cpp");
        writeFileSync(path, compiled.cpp);
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            "/permissive-",
            "/c",
            "/I",
            "native/include",
            "/I",
            join(output, "upstream/include"),
            `/Fo:${join(output, "check.obj")}`,
            path,
        ]);
    },
);

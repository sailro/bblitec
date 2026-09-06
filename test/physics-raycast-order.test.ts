import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { PhysicsLowerer } from "../src/lowering/physics-lowerer.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const source = `
import HavokPhysics from "@babylonjs/havok";
import { createEngine, createSceneContext, createHavokWorld, physicsRaycast, type PhysicsWorld, type Vec3 } from "@babylonjs/lite";
const engine = await createEngine({});
const scene = createSceneContext(engine);
const world = createHavokWorld(scene, await HavokPhysics());
let order = 0;
let scalar = 7;
function getWorld(): PhysicsWorld { order = order * 10 + 1; return world; }
function numberStep(tag: number): number { order = order * 10 + tag; return tag; }
function triggerStep(): { enabled: boolean } { order = order * 10 + 5; scalar = 19; return { enabled: true }; }
if (!physicsRaycast(getWorld(), { z: numberStep(2), x: scalar, y: 0 }, { x: numberStep(3), y: 0, z: 0 }, {
    collideWith: numberStep(4), shouldHitTriggers: triggerStep().enabled, membership: numberStep(6),
}).hasHit) throw new Error("first ray failed");
if (order !== 123456) throw new Error("argument or option evaluation order changed");

const flags = { enabled: true };
function clearFlag(): number { flags.enabled = false; return 9; }
if (!physicsRaycast(world, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, {
    shouldHitTriggers: flags.enabled, collideWith: clearFlag(),
}).hasHit) throw new Error("flag snapshot ray failed");

let origin: Vec3 = { x: 1, y: 2, z: 3 };
let target: Vec3 = { x: 4, y: 5, z: 6 };
function mutateAndReplace(): { enabled: boolean } {
    origin.x = 10; target.z = 60;
    origin = { x: 100, y: 200, z: 300 };
    target = { x: 400, y: 500, z: 600 };
    return { enabled: true };
}
if (!physicsRaycast(world, origin, target, { shouldHitTriggers: mutateAndReplace().enabled }).hasHit)
    throw new Error("retained object ray failed");

order = 0;
function getOrigin(): Vec3 { order = order * 10 + 1; return origin; }
function getTarget(): Vec3 { order = order * 10 + 2; return target; }
function mutateSelected(): { enabled: boolean } { order = order * 10 + 3; origin.y = 2000; return { enabled: true }; }
if (!physicsRaycast(world, getOrigin(), getTarget(), { shouldHitTriggers: mutateSelected().enabled }).hasHit)
    throw new Error("returned object ray failed");
if (order !== 123) throw new Error("returned object evaluation order changed");

let mask = 3;
function mutateSpreadSource(): { enabled: boolean } { origin.y = 3000; mask = 7; return { enabled: true }; }
if (!physicsRaycast(world, { ...origin }, target, {
    membership: mask, shouldHitTriggers: mutateSpreadSource().enabled,
}).hasHit) throw new Error("spread snapshot ray failed");
`;

type ObservedRay = {
    from: { x: number; y: number; z: number };
    to: { x: number; y: number; z: number };
    membership: number; collideWith: number; shouldHitTriggers: boolean;
};

async function javascriptRays(): Promise<ObservedRay[]> {
    // Observe arguments at the same function-entry boundary as Havok's
    // query, after JavaScript has evaluated the entire argument list.
    const script = ts.transpileModule(source.replace(/^import .+;$/gm, ""), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    return new Function(`return (async () => {
        const observed = [];
        const createEngine = async () => ({}), createSceneContext = () => ({});
        const createHavokWorld = () => ({}), HavokPhysics = async () => ({});
        function physicsRaycast(world, from, to, options = {}) {
            observed.push({from: {...from}, to: {...to}, membership: options.membership ?? 0xffffffff,
                collideWith: options.collideWith ?? 0xffffffff, shouldHitTriggers: options.shouldHitTriggers ?? false});
            return {hasHit: true};
        }
        ${script}
        return observed;
    })();`)() as Promise<ObservedRay[]>;
}

test("physics ray arguments compile with side effects and retained point objects", async () => {
    const rays = await javascriptRays();
    assert.equal(rays[0]!.from.x, 7);
    assert.equal(rays[1]!.shouldHitTriggers, true);
    assert.deepEqual(rays[2]!.from, { x: 10, y: 2, z: 3 });
    assert.deepEqual(rays[2]!.to, { x: 4, y: 5, z: 60 });
    assert.equal(rays[3]!.from.y, 2000);
    assert.equal(rays[4]!.from.y, 2000);
    assert.equal(rays[4]!.membership, 3);
    assert.equal(compileSource(source).cpp.match(/bbl::upstream::physics_raycast\(/g)?.length, rays.length);
});

const nativeTools = optionalNativeFixtureTools(false);
test("native physics ray arguments match JavaScript evaluation and object identity", { skip: !nativeTools }, async () => {
    const rays = await javascriptRays();
    const output = resolve("artifacts/physics-raycast-order");
    const include = join(output, "bblite/upstream");
    mkdirSync(include, { recursive: true });
    writeFileSync(join(output, "program.hpp"), compileSource(source).cpp);
    writeFileSync(join(include, "physics.hpp"), new PhysicsLowerer(new LoweringContext()).lowerPhysics().header);
    const cases = rays.map((ray, index) => `case ${index}:\n` + [
        ...["x", "y", "z"].map((axis) => `assert(from.${axis} == ${ray.from[axis as keyof typeof ray.from]});`),
        ...["x", "y", "z"].map((axis) => `assert(to.${axis} == ${ray.to[axis as keyof typeof ray.to]});`),
        `assert(membership == ${ray.membership}u);`,
        `assert(collide_with == ${ray.collideWith}u);`,
        `assert(should_hit_triggers == ${ray.shouldHitTriggers}); break;`,
    ].join("\n")).join("\n");
    const fixture = join(output, "check.cpp");
    writeFileSync(fixture, `
        #define main generated_scene_main
        #include "program.hpp"
        #undef main
        #include <cassert>
        namespace { unsigned raycasts = 0; }
        namespace bbl {
        Scene create_scene_context(Engine& engine) { Scene scene; scene.engine = &engine; return scene; }
        }
        namespace bbl::upstream {
        PhysicsWorldHandle create_havok_world(Scene&, Vec3d) { return {}; }
        PhysicsRaycastResult physics_raycast(PhysicsWorldHandle, Vec3d from, Vec3d to,
            std::uint32_t membership, std::uint32_t collide_with, bool should_hit_triggers) {
            switch (raycasts++) { ${cases} default: assert(false); }
            return {.has_hit = true};
        }
        }
        int main() { assert(generated_scene_main() == 0); assert(raycasts == ${rays.length}); }
    `);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", "/I", output, fixture,
        "test/fixtures/js-callback/data-engine-stubs.cpp",
    ]);
    execFileSync(executable, { encoding: "utf8" });
});

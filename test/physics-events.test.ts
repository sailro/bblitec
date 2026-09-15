import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { discoverWindowsBuildTools } from "../src/development-tools.js";
import { lowerPhysicsAfterStep, lowerPhysicsCollisionInfo } from "../src/lowering/physics-event-lowerer.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { doctoredContext } from "./doctored-store.js";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("collision fields and separation are read from the pinned event object", () => {
    const changed = lowerPhysicsCollisionInfo(doctoredContext("src/physics/havok-collision.ts",
        "(pointB.x - pointA.x) * normal.x", "(pointB.x - pointA.x) * normal.x * 2"));
    assert.match(changed.fields, /normal.x\) \* 2\.0/);
    assert.throws(() => lowerPhysicsAfterStep(doctoredContext("src/physics/havok.ts", "cbs[i]!(dt);", "return;")), /finally lowering does not admit early returns/);
    const { cpp } = compileSource(`import HavokPhysics from "@babylonjs/havok";
        import { createEngine, createSceneContext, createFreeCamera,
        createHavokWorld, onPhysicsCollision, removePhysicsBody, registerScene, startEngine } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
            const scene = createSceneContext(engine);
            scene.camera = createFreeCamera({x:0,y:5,z:-10}, {x:0,y:0,z:0});
            const world = createHavokWorld(scene, await HavokPhysics());
            onPhysicsCollision(world, info => {
                if (info.distance < 0 && info.colliderIndex === 1) removePhysicsBody(world, info.collider);
                if (info.collidedAgainstIndex === 2) removePhysicsBody(world, info.collidedAgainst);
            });
            await registerScene(scene);
            await startEngine(engine);
        }`, { fileName: "examples/physics-events.ts" });
    for (const field of ["distance", "collider_index", "collider", "collided_against_index", "collided_against"])
        assert(cpp.includes(`.${field}`), field);
});

const tools = optionalNativeFixtureTools();
for (const compiler of ["msvc", "clangcl"] as const)
for (const thin of [false, true]) test(`collision callbacks preserve identities, deferred release and finally semantics (thin=${thin}, compiler=${compiler})`, { skip: !tools }, () => {
    const nativeTools = discoverWindowsBuildTools(compiler);
    const output = resolve(`artifacts/physics-events-${thin ? "thin" : "ordinary"}-${compiler}`);
    mkdirSync(output, { recursive: true });
    emitUpstreamGenerated(output, ["core", "camera:free", "renderer:scene", "physics:world", ...(thin ? ["physics:thin-instances" as const] : [])]);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(nativeTools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2", "/Gy",
        `/DTEST_THIN=${thin ? 1 : 0}`, `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/src", "/I", "native/include",
        "/I", join(output, "upstream/include"), "/I", join(output, "upstream/src"),
        `/external:I${join(nativeFixtureVcpkgRoot, "include/bullet")}`, "/external:W0",
        "test/fixtures/physics-events-check.cpp", join(output, "upstream/src/scene_core.cpp"),
        "/link", "/OPT:REF", `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`, "BulletDynamics.lib", "BulletCollision.lib", "LinearMath.lib"]);
    execFileSync(executable, { encoding: "utf8", env: { ...nativeTools.environment,
        PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${nativeTools.environment.PATH ?? ""}` } });
});

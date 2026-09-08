import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();
test("character vectors retain returned references across controller rebinding and evaluate their owner once", { skip: !tools }, () => {
    const compiled = compileSource(`
        import HavokPhysics from "@babylonjs/havok";
        import { createEngine, createSceneContext, createHavokWorld, createPhysicsCharacterController } from "@babylonjs/lite";
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        const world = createHavokWorld(scene, await HavokPhysics());
        const first = createPhysicsCharacterController(world, {x:1,y:2,z:3}, {});
        const second = createPhysicsCharacterController(world, {x:9,y:8,z:7}, {});
        let controller = first;
        const position = controller.getPosition();
        const velocity = controller.getVelocity();
        const up = controller.up;
        controller = second;
        position.x = 4; velocity.y = 5; up.z = 6;
        if (first.getPosition().x !== 4 || first.getVelocity().y !== 5 || first.up.z !== 6 || second.getPosition().x !== 9)
            throw new Error("A retained vector followed the rebound controller");
        let calls = 0;
        function choose() { calls++; return first; }
        const returnedPosition = choose().getPosition();
        const returnedVelocity = choose().getVelocity();
        const returnedUp = choose().up;
        returnedPosition.z = 11; returnedVelocity.x = 12; returnedUp.y = 13;
        if (calls !== 3 || first.getPosition().z !== 11 || first.getVelocity().x !== 12 || first.up.y !== 13)
            throw new Error("A vector owner was evaluated more than once or lost its alias");
    `);
    const output = resolve("artifacts/character-controller-vector-alias");
    mkdirSync(output, { recursive: true });
    emitUpstreamGenerated(output, [...compiled.manifest.features, "camera:free", "renderer:scene"]);
    writeFileSync(join(output, "program.hpp"), compiled.cpp);
    // Geometry aggregation is outside this compiler ownership fixture.
    writeFileSync(join(output, "check.cpp"), `
        #include "pal_physics_bullet.cpp"
        #include "physics.cpp"
        #include "program.hpp"
        namespace bbl::upstream {
        std::array<float,16> mesh_local_matrix(const MeshRecord&) { std::abort(); }
        std::array<float,16> mesh_world_matrix(const Engine&, const MeshRecord&) { std::abort(); }
        std::array<float,16> transform_node_world(const Engine&, TransformNodeHandle) { std::abort(); }
        }
    `);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2", "/Gy",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/src", "/I", "native/include", "/I", output,
        "/I", join(output, "upstream/include"), "/I", join(output, "upstream/src"),
        `/external:I${join(nativeFixtureVcpkgRoot, "include/bullet")}`, "/external:W0",
        join(output, "check.cpp"), join(output, "upstream/src/scene_core.cpp"), "test/fixtures/js-callback/data-engine-stubs.cpp",
        "/link", "/OPT:REF", `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`, "BulletDynamics.lib", "BulletCollision.lib", "LinearMath.lib"]);
    execFileSync(executable, { encoding: "utf8", env: { ...tools!.environment,
        PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}` } });
});

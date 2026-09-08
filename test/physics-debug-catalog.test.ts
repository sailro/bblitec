import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { materializePhysicsDebugCatalog, physicsDebugDescriptor, renderPhysicsDebugCatalog } from "../src/physics-debug-catalog.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const box = { type: "BOX", parameters: [0, 0, 0, 0, 0, 0, 1, 2, 3, 4], indices: [], children: [] };
const sphere = { type: "SPHERE", parameters: [0, 0, 0, 1], indices: [], children: [] };

test("constructor descriptors refuse unrepresented fields, widths and parameter order/arity", () => {
    assert.deepEqual(physicsDebugDescriptor(box), box);
    for (const value of [
        { ...box, bodyPose: [0, 1, 0] }, { ...box, parameters: [0, 0, 0] },
        { ...box, indices: [0] }, { ...box, children: [sphere] },
        { ...box, parameters: [...box.parameters.slice(0, -1), Infinity] },
        { ...box, type: "UNSUPPORTED" }, { ...box, parameters: [...box.parameters, 1] },
    ]) assert.throws(() => physicsDebugDescriptor(value), /constructor inputs/);
});

test("catalog identity depends on complete descriptors and is independent of construction order", async () => {
    const entries = await materializePhysicsDebugCatalog([box, sphere, box]);
    assert.equal(entries.length, 2);
    assert.equal(renderPhysicsDebugCatalog(entries), renderPhysicsDebugCatalog(await materializePhysicsDebugCatalog([sphere, box])));
    const changed = await materializePhysicsDebugCatalog([{ ...box, parameters: [...box.parameters.slice(0, -1), 4.5] }]);
    assert(!entries.some(entry => entry.shapeIdentity === changed[0]!.shapeIdentity));
});

const tools = optionalNativeFixtureTools();
test("native catalog selects exact inputs, refuses drift and guards construction execution", { skip: !tools }, async () => {
    const output = resolve("artifacts/physics-debug-catalog");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "catalog.cpp"), renderPhysicsDebugCatalog(await materializePhysicsDebugCatalog([box, sphere])));
    writeFileSync(join(output, "check.cpp"), `
        #include <bblite/pal_physics_debug.hpp>
        #include <cassert>
        #include <iostream>
        using namespace bbl::pal;
        int main(int argc, char** argv) {
            assert(argc == 2);
            PhysicsDebugShapeDescriptor box{"BOX", {0,0,0,0,0,0,1,2,3,4}, {}, {}};
            PhysicsDebugShapeDescriptor sphere{"SPHERE", {0,0,0,1}, {}, {}};
            assert(materialized_physics_debug_geometry(sphere).positions.size() == 486);
            assert(materialized_physics_debug_geometry(box).positions.size() == 24);
            auto drift = box; drift.parameters.back() += 0.125f;
            bool refused = false;
            try { static_cast<void>(materialized_physics_debug_geometry(drift)); } catch (const std::runtime_error&) { refused = true; }
            assert(refused);
            { PhysicsDebugExtractionScope extraction;
              assert(materialized_physics_debug_geometry(box).positions.empty());
              assert(materialized_physics_debug_geometry(box).positions.empty());
              assert(materialized_physics_debug_geometry(drift).positions.empty());
              assert(materialized_physics_debug_geometry(sphere).positions.empty());
              refused = false;
              try { require_runtime_execution("clock/input/physics/frame"); } catch (const std::runtime_error&) { refused = true; }
              assert(refused); extraction.write(argv[1]);
            }
            require_runtime_execution("normal execution");
            assert(materialized_physics_debug_geometry(box).indices.size() == 36);
            std::cout << "physics-debug-catalog: ok\\n";
        }
    `);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2", "/DBBLITE_PHYSICS_VIEWER=1",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", join(output, "check.cpp"), join(output, "catalog.cpp"), "native/src/pal_physics_debug.cpp"]);
    const inputs = join(output, "inputs.json");
    assert.match(execFileSync(executable, [inputs], { encoding: "utf8", env: tools!.environment }), /physics-debug-catalog: ok/);
    const captured = JSON.parse(readFileSync(inputs, "utf8"));
    assert.equal(captured.length, 3);
    assert.equal(captured[1].parameters[9], 4.125);
    assert.equal(captured[2].type, "SPHERE");
});

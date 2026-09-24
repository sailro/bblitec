import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { CameraLowerer } from "../src/lowering/camera-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { compileSource } from "../src/compiler.js";
import {
    cppFunction,
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    sharedGpuSource,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);
test(
    "authored scene deltas survive the initial zero engine delta and remain per scene",
    { skip: !tools },
    () => {
        const output = resolve("artifacts/scene-callback-delta");
        mkdirSync(output, { recursive: true });
        const file = join(output, "check.cpp"),
            executable = join(output, "check.exe");
        const lowered = new SceneLowerer(new LoweringContext()).lowerCore()
            .source;
        writeFileSync(
            file,
            `#include <cassert>
#include <limits>
struct Scene { double fixed_delta_ms; };
${cppFunction(lowered, "double scene_callback_delta(")}
int main() {
    Scene fixed{1000.0 / 60.0}, other{25}, live{0};
    assert(scene_callback_delta(fixed, 0) == 1000.0 / 60.0);
    assert(scene_callback_delta(other, 0) == 25);
    assert(scene_callback_delta(live, 0) == 0);
    assert(scene_callback_delta(live, 7.125) == 7.125);
    fixed.fixed_delta_ms = -1;
    assert(scene_callback_delta(fixed, 9) == 9);
    fixed.fixed_delta_ms = std::numeric_limits<double>::quiet_NaN();
    assert(scene_callback_delta(fixed, 9) == 9);
    fixed.fixed_delta_ms = 40;
    assert(scene_callback_delta(fixed, 9) == 40);
}`,
        );
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            file,
        ]);
        execFileSync(executable);
        const shared = sharedGpuSource();
        assert.match(shared, /frame_clock.advance\(frame_delta_ms\)/);
        assert.match(shared, /scene_callback_delta\(\*registered, delta_ms\)/);
        const compiled =
            compileSource(`import {createEngine,createSceneContext} from '@babylonjs/lite';
        const engine=await createEngine({});const scene=createSceneContext(engine);scene.fixedDeltaMs=1000/60;`);
        assert.match(compiled.cpp, /fixed_delta_ms = \(1000\.0 \/ 60\.0\)/);
    },
);

const cameraTools = optionalNativeFixtureTools();
test(
    "a camera control advances by the delta of the scene it was attached to",
    { skip: !cameraTools },
    () => {
        const output = resolve("artifacts/camera-scene-delta");
        const headers = join(output, "include/bblite/upstream");
        mkdirSync(headers, { recursive: true });
        const controls = new CameraLowerer(
            new LoweringContext(),
        ).lowerControls();
        writeFileSync(join(headers, "camera_controls.hpp"), controls.header);
        writeFileSync(join(output, "controls.cpp"), controls.source);
        const scene = new SceneLowerer(new LoweringContext()).lowerCore()
            .source;
        writeFileSync(
            join(output, "scene-callback-delta.hpp"),
            `namespace bbl {\n${cppFunction(scene, "double scene_callback_delta(")}\n}\n`,
        );
        const executable = join(output, "camera-scene-delta-check.exe");
        runNativeFixtureCompiler(cameraTools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/permissive-",
            "/EHsc",
            "/DSDL_STATIC_LIB",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/include",
            "/I",
            "native/src",
            "/I",
            join(output, "include"),
            "/I",
            output,
            "/I",
            join(nativeFixtureVcpkgRoot, "include"),
            "test/fixtures/camera-scene-delta-check.cpp",
            join(output, "controls.cpp"),
        ]);
        assert.match(
            execFileSync(executable, [], { encoding: "utf8" }),
            /camera-scene-delta-check: ok/,
        );
    },
);

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { compileSource } from "../src/compiler.js";
import { cppFunction, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);
test("authored scene deltas survive the initial zero engine delta and remain per scene", { skip: !tools }, () => {
    const output = resolve("artifacts/scene-callback-delta");
    mkdirSync(output, { recursive: true });
    const file = join(output, "check.cpp"), executable = join(output, "check.exe");
    const lowered = new SceneLowerer(new LoweringContext()).lowerCore().source;
    writeFileSync(file, `#include <cassert>
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
}`);
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", `/Fo:${output}\\`, `/Fe:${executable}`, file]);
    execFileSync(executable);
    const shared = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
    assert.match(shared, /frame_clock.advance\(frame_delta_ms\)/);
    assert.match(shared, /scene_callback_delta\(\*registered, delta_ms\)/);
    const compiled = compileSource(`import {createEngine,createSceneContext} from '@babylonjs/lite';
        const engine=await createEngine({});const scene=createSceneContext(engine);scene.fixedDeltaMs=1000/60;`);
    assert.match(compiled.cpp, /fixed_delta_ms = \(1000\.0 \/ 60\.0\)/);
});

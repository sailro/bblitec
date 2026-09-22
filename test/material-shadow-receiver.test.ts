import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { materialShadowReceiverCpp } from "../src/lowering/material-shadow-receiver.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("material shadow receivers follow generator membership and caster views", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/material-shadow-receiver-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        `#include <bblite/runtime.hpp>
#include <cassert>
namespace bbl::upstream { ${materialShadowReceiverCpp(new LoweringContext())} }
int main() {
    bbl::Engine engine;
    bbl::Scene scene;
    engine.lights.emplace_back();
    engine.lights.emplace_back();
    scene.lights.push_back(bbl::LightHandle{0u});
    engine.lights[1].shadow_generator = bbl::ShadowGeneratorHandle{0u};
    assert(!bbl::upstream::pinned_scene_has_shadows(engine, scene));
    assert(!bbl::upstream::pinned_material_receives_shadows(false, true, false));
    scene.lights.push_back(bbl::LightHandle{1u});
    assert(bbl::upstream::pinned_scene_has_shadows(engine, scene));
    for (bool caster : {false, true}) for (bool receives : {false, true}) for (bool present : {false, true})
        assert(bbl::upstream::pinned_material_receives_shadows(caster, receives, present) == (!caster && receives && present));
    scene.lights.pop_back();
    assert(!bbl::upstream::pinned_scene_has_shadows(engine, scene));
}
`,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        `/I${resolve("native/include")}`,
        cpp,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});

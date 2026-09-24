import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const imports = `import {createEngine,createSceneContext,registerScene,getRenderTaskGpuTimings,onBeforeRender} from "@babylonjs/lite";
    const engine=await createEngine(document.createElement("canvas"));`;

for (const placement of ["before", "after", "callback"] as const) {
    test(`GPU timing reached ${placement} registration materializes the default scene tasks`, (t) => {
        const query = "getRenderTaskGpuTimings(engine);";
        const result = compileSource(`${imports}
            const scene=createSceneContext(engine);
            ${placement === "before" ? query : ""}
            registerScene(scene);
            ${placement === "after" ? query : ""}
            ${placement === "callback" ? `onBeforeRender(scene,()=>{${query}});` : ""}`);
        assert.ok(
            result.manifest.features.includes("renderer:geometry-output"),
        );
        assert.ok(result.manifest.features.includes("frame-graph:resources"));
        assert.match(
            result.cpp,
            /void bbl_register_scene\(bbl::Scene& scene\) \{\s+auto (\w+) = scene;\s+bblscene::bbl_ensure_default_render_task\(\1\);\s+bbl::register_scene\(\1\);/,
        );
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native compiler unavailable.");
            return;
        }
        const directory = resolve("artifacts/gpu-task-timing-scene");
        mkdirSync(directory, { recursive: true });
        const cpp = join(directory, `${placement}.cpp`);
        writeFileSync(cpp, result.cpp);
        runNativeFixtureCompiler(tools, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            "/Zs",
            "/DBBLITE_WORKERS=1",
            "/DBBLITE_OFFSCREEN_SURFACES=1",
            "/DBBLITE_HAS_UI=1",
            "/I",
            "native/include",
            cpp,
        ]);
    });
}

test("timing respects disabled default tasks and remains isolated when unreached", () => {
    const timed = compileSource(`${imports}
        const scene=createSceneContext(engine,{defaultRenderTask:false});
        registerScene(scene);
        getRenderTaskGpuTimings(engine);`);
    assert.match(timed.cpp, /configure_scene_render_defaults\([^\n]+, false,/);
    assert.match(
        timed.cpp,
        /if \(scene\.state->default_render_task && !scene\.state->default_render_task_created\)/,
    );
    const plain = compileSource(`${imports}
        const scene=createSceneContext(engine);
        registerScene(scene);`);
    assert.ok(!plain.manifest.features.includes("frame-graph:resources"));
    assert.doesNotMatch(plain.cpp, /bbl_ensure_default_render_task/);
});

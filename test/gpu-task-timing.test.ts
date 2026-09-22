import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { executeNativeTaskTiming } from "../src/pinned-gpu-task-timing.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("native timing capability executes the pinned unsupported result", async () => {
    const result = await executeNativeTaskTiming();
    assert.deepEqual(result, {
        status: "unsupported",
        supported: false,
        enabled: false,
        frameIndex: 0,
        tasks: [],
        droppedTaskCount: 0,
        error: undefined,
    });
});

test("task timing queries retain typed snapshots and enable completion without fabricated measurements", (t) => {
    const source = `import {createEngine,isRenderTaskGpuTimingSupported,getRenderTaskGpuTimings,setRenderTaskGpuTimingEnabled} from "@babylonjs/lite";
        const engine = await createEngine(document.createElement("canvas"));
        if(isRenderTaskGpuTimingSupported(engine)) throw new Error("Unsupported capability advertised");
        const first = getRenderTaskGpuTimings(engine);
        if(first.status!=="unsupported"||first.tasks.length!==0||first.supported||first.enabled||first.frameIndex!==0)
            throw new Error("Invalid unsupported snapshot");
        const enabled = await setRenderTaskGpuTimingEnabled(engine,true);
        const disabled = await setRenderTaskGpuTimingEnabled(engine,false);
        if(enabled.status!=="unsupported"||disabled.status!=="unsupported")
            throw new Error("Unsupported timing enabled");`;
    const result = compileSource(source);
    assert.match(result.cpp, /RenderTaskGpuTimingStatus::unsupported/);
    assert.match(result.cpp, /Promise<[^;]+>::resolved/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/gpu-task-timing");
    mkdirSync(directory, { recursive: true });
    const cpp = join(directory, "check.cpp");
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
        "/DBBLITE_WINDOW_SURFACES=1",
        "/DBBLITE_HAS_UI=1",
        "/I",
        "native/include",
        cpp,
    ]);
});

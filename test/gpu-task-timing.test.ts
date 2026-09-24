import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerGpuTaskTiming } from "../src/lowering/gpu-task-timing-lowerer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("GPU timing queries use runtime capability and typed task snapshots", (t) => {
    const result =
        compileSource(`import {createEngine,isRenderTaskGpuTimingSupported,getRenderTaskGpuTimings,setRenderTaskGpuTimingEnabled} from "@babylonjs/lite";
        const engine = await createEngine(document.createElement("canvas"));
        if(isRenderTaskGpuTimingSupported(engine)) {
            const enabled=await setRenderTaskGpuTimingEnabled(engine,true);
            if(!enabled.supported) throw new Error("Lost supported capability");
            const result=getRenderTaskGpuTimings(engine);
            for(const task of result.tasks) console.log(task.name,task.durationMs);
            await setRenderTaskGpuTimingEnabled(engine,false);
        }`);
    assert.match(result.cpp, /is_render_task_gpu_timing_supported/);
    assert.match(result.cpp, /set_render_task_gpu_timing_enabled/);
    assert.match(result.cpp, /project_gpu_task_timing_snapshot/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/gpu-task-timing");
    mkdirSync(directory, { recursive: true });
    const cpp = join(directory, "entry.cpp");
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

test("pinned GPU timer preserves async enable, capacity, readback, failure and disable semantics", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/gpu-task-timing-policy");
    mkdirSync(directory, { recursive: true });
    const cpp = join(directory, "check.cpp"),
        exe = join(directory, "check.exe");
    const context = new LoweringContext();
    writeFileSync(
        cpp,
        lowerGpuTaskTiming(context).source +
            readFileSync(
                resolve("test/fixtures/gpu-task-timing-check.cpp"),
                "utf8",
            ),
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_OFFSCREEN_SURFACES=1",
        `/I${resolve("native/include")}`,
        cpp,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(
        execFileSync(exe, {
            encoding: "utf8",
            timeout: 10000,
            windowsHide: true,
        }).trim(),
        "timing policy passed",
    );
});

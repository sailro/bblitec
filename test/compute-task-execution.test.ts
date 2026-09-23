import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerComputeDispatch } from "../src/lowering/compute-dispatch-lowerer.js";
import { lowerComputeTask } from "../src/lowering/compute-task-lowerer.js";
import { lowerComputeTaskExecution } from "../src/lowering/compute-task-execution-lowerer.js";
import { lowerComputeFrameGraph } from "../src/lowering/compute-frame-graph-lowerer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("source task execution retains dispatch order, dynamic offsets, submission cleanup and preparation", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/compute-task-execution-check");
    mkdirSync(directory, { recursive: true });
    const file = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe"),
        context = new LoweringContext();
    writeFileSync(
        file,
        [
            lowerComputeDispatch(context).source,
            lowerComputeTask(context, true).source,
            lowerComputeTaskExecution(context).source,
            lowerComputeFrameGraph(context).source,
            readFileSync(
                resolve("test/fixtures/compute-task-execution-check.cpp"),
                "utf8",
            ),
        ].join("\n"),
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
        file,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});

test("compute task preparation, recording and typed submission reach execution support", () => {
    const result = compileSource(`
import {createEngine, createSceneContext, createComputeTask, prepareComputeTask, submitComputeTasks, addTaskAtStart} from "@babylonjs/lite";
async function main(){
 const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
 const task=createComputeTask(engine,"direct");
 const scene=createSceneContext(engine);addTaskAtStart(scene,task);
 await prepareComputeTask(task);
 const record=task.record.bind(task);record();
 const tasks=[task];submitComputeTasks(tasks);submitComputeTasks([task]);
 task.dispose();
}
void main();`);
    assert.ok(result.manifest.features.includes("compute:task-execution"));
    assert.ok(result.manifest.features.includes("compute:bindings"));
    assert.ok(result.manifest.features.includes("compute:frame-graph"));
    assert.match(result.cpp, /prepare_compute_task/);
    assert.match(result.cpp, /submit_compute_tasks/);
});

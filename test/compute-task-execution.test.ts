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
import { pinnedError, pinnedErrorsCpp } from "./pinned-errors.js";

const task = "src/compute/compute-task.ts";

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
            pinnedErrorsCpp({
                dispatch_size: pinnedError(
                    "ComputeDispatch: ${a0} workgroup dimension must be an integer in [0, ${a1}], received ${a2}x${a3}x${a4}.",
                ),
                dispatch_binding_set: pinnedError(
                    "ComputeDispatch: binding set belongs to a different ComputeShader.",
                ),
                dynamic_binding: pinnedError(
                    'ComputeDispatch: binding "${a0}" is not a dynamic buffer binding.',
                ),
                dynamic_alignment: pinnedError(
                    'ComputeDispatch: dynamic offset for "${a0}" must be a non-negative multiple of ${a1}.',
                ),
                dynamic_range: pinnedError(
                    'ComputeDispatch: dynamic offset for "${a0}" exceeds the bound buffer range.',
                ),
                shader_disposed: pinnedError(
                    'ComputeShader "${a0}" has been disposed.',
                    {
                        module: "src/compute/compute-shader.ts",
                        name: "_assertComputeShaderLive",
                    },
                ),
                record_disposed: pinnedError(
                    'ComputeTask "${a0}" has been disposed.',
                    { module: task, name: "createComputeTask" },
                ),
                add_disposed: pinnedError(
                    'ComputeTask "${a0}" has been disposed.',
                    { module: task, name: "addComputeDispatch" },
                ),
                add_engines: pinnedError(
                    'ComputeTask "${a0}" and its dispatch belong to different engines.',
                ),
                submit_engines: pinnedError(
                    "submitComputeTasks requires tasks from the same engine.",
                ),
                submit_unrecorded: pinnedError(
                    'ComputeTask "${a0}" must be recorded and active before direct submission.',
                ),
                submit_recording: pinnedError(
                    "submitComputeTasks cannot run while a frame is being recorded.",
                ),
                prepare_disposed: pinnedError(
                    'ComputeTask "${a0}" has been disposed.',
                    { module: task, name: "prepareComputeTask" },
                ),
            }),
            readFileSync(
                resolve("test/fixtures/compute-task-execution-check.cpp"),
                "utf8",
            ),
        ].join("\n"),
    );
    runNativeFixtureCompiler(tools, [
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_OFFSCREEN_SURFACES=1",
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

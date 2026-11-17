import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerTaskRemoval } from "../src/lowering/frame-graph-task-removal.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

// A registered scene with a render task added to it, then `body`.
const program = (body: string): string => `
import { createEngine, createSceneContext, createFreeCamera, createSphere, addToScene, registerScene, createRenderTask, addTask, removeTask, getFrameGraph, buildFrameGraphTask, createRenderTargetTexture, createStandardMaterial, startEngine, type Task } from "@babylonjs/lite";
const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
const scene = createSceneContext(engine);
scene.camera = createFreeCamera([0, 0, -5], [0, 0, 0]);
const sphere = createSphere(engine, { diameter: 1 });
sphere.material = createStandardMaterial();
addToScene(scene, sphere);
await registerScene(scene);
const target = createRenderTargetTexture(engine, { lbl: "t", format: "rgba8unorm", dFormat: "depth24plus", samples: 1, size: { width: 8, height: 8 } });
const task = createRenderTask({ name: "mask", rt: target.rt, autoMirror: false }, engine, scene);
addTask(scene, task);
const frameGraph = getFrameGraph(scene);
${body}
await startEngine(engine);
`;

test("removeTask unlists a task from a scene's graph and says whether it was listed", () => {
    const { cpp, manifest } = compileSource(
        program(`
const removed = removeTask(frameGraph, task);
if (!removed || removeTask(scene, task)) throw new Error("removal");`),
    );
    assert.ok(manifest.features.includes("frame-graph:task-removal"));
    assert.match(cpp, /bool v_removed = bbl::remove_task\(v_\w+, v_task\);/);
    assert.match(cpp, /\|\| bbl::remove_task\(v_\w+, v_task\)/);
});

test("a private _tasks indexOf whose position splices the same list removes that task", () => {
    const { cpp, manifest } = compileSource(
        program(`
const removeTaskFromGraph = (removed: Task): void => {
    const tasks = (frameGraph as unknown as { _tasks: Task[] })._tasks;
    const i = tasks.indexOf(removed);
    if (i >= 0) {
        tasks.splice(i, 1);
    }
};
try {
    buildFrameGraphTask(frameGraph, task);
} catch {
    removeTaskFromGraph(task);
}`),
    );
    assert.match(
        cpp,
        /double (v_\w+) = bbl::js::array_index_of\((v_\w+)\.tasks, v_task\);\s*if \(\(?\1 >= 0(\.0)?\)?\) \{\s*bbl::js::array_splice_one\(\2\.tasks, \1\);/,
    );
    assert.ok(manifest.features.includes("frame-graph:task-removal"));
});

test("a task added back after its removal draws its kept passes", () => {
    const liveAdd = (taskRemoval: boolean): string =>
        cppFunction(
            new SceneLowerer(new LoweringContext()).lowerCore({
                liveTaskAdd: true,
                taskRemoval,
            }).source,
            "void add_live_task(",
        );
    // A recorded task's draw lists rebuild with the graph's next frame.
    assert.match(
        liveAdd(true),
        /else if \(record\.record_state == FrameTaskRecordState::recorded\)\s*\+\+scene\.engine->draw_list_epoch;/,
    );
    assert.doesNotMatch(liveAdd(false), /draw_list_epoch/);
});

test("every other use of a graph's private _tasks keeps refusing", () => {
    for (const body of [
        'if ((frameGraph as unknown as { _tasks: Task[] })._tasks.length > 1) throw new Error("tasks");',
        `const tasks = (frameGraph as unknown as { _tasks: Task[] })._tasks;
const i = tasks.indexOf(task);
if (i >= 0) tasks.splice(i, 2);`,
        `const tasks = (frameGraph as unknown as { _tasks: Task[] })._tasks;
const i = tasks.indexOf(task);
if (i > 3) throw new Error("index");
if (i >= 0) tasks.splice(i, 1);`,
        `const tasks = (frameGraph as unknown as { _tasks: Task[] })._tasks;
const i = tasks.indexOf(task);
if (i >= 0) tasks.splice(i, 1);
if (tasks.length > 1) throw new Error("tasks");`,
    ])
        assert.throws(
            () => compileSource(program(body)),
            /FrameGraph\._tasks is private and is not represented/,
        );
});

test("a removed task leaves the graph's passes, keeps its record and comes back when added", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "frame-graph-task-removal-check",
        `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
#include <vector>
namespace bbl {
${lowerTaskRemoval(new LoweringContext())}
}
int main() {
    bbl::Engine engine;
    for (int index = 0; index < 4; ++index) engine.frame_tasks.push_back(bbl::FrameTaskRecord{});
    const bbl::TaskHandle first{0}, second{1}, third{2}, copy{3};
    engine.frame_tasks[0].render.name = "mask";
    engine.frame_tasks[0].record_state = bbl::FrameTaskRecordState::recorded;
    bbl::Scene scene;
    scene.engine = &engine;
    // Registered twice; a copy pass follows the first registration.
    scene.tasks = {first, second, first, third};
    scene.state->internal_passes.push_back(bbl::SceneInternalPass{copy, first});
    assert(bbl::remove_task(scene, first));
    assert((scene.tasks == std::vector<bbl::TaskHandle>{second, third}));
    assert((bbl::scene_frame_passes(*scene.state) == std::vector<bbl::TaskHandle>{second, third}));
    // Not disposed: its record and the pass it anchors stay as they were.
    assert(engine.frame_tasks[0].render.name == "mask");
    assert(engine.frame_tasks[0].record_state == bbl::FrameTaskRecordState::recorded);
    assert(!bbl::remove_task(scene, first));
    assert((scene.tasks == std::vector<bbl::TaskHandle>{second, third}));
    scene.tasks.push_back(first);
    assert((bbl::scene_frame_passes(*scene.state) == std::vector<bbl::TaskHandle>{second, third, first, copy}));
    // The private idiom removes the first registration it finds.
    scene.tasks = {third, first, second, first};
    const double position = bbl::js::array_index_of(scene.tasks, first);
    assert(position == 1.0);
    bbl::js::array_splice_one(scene.tasks, position);
    assert((scene.tasks == std::vector<bbl::TaskHandle>{third, second, first}));
    assert(bbl::js::array_index_of(scene.tasks, copy) == -1.0);
    bbl::FrameGraphContext context;
    context.engine = &engine;
    context.tasks = {second, first};
    assert(bbl::remove_task(context, second));
    assert((context.tasks == std::vector<bbl::TaskHandle>{first}));
    assert(!bbl::remove_task(context, second));
}
`,
        { expectedOutput: "" },
    );
});

import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerFrameGraphTaskActions } from "../src/lowering/frame-graph-task-actions.js";
import { GeometryOutputLowerer } from "../src/lowering/geometry-output-lowerer.js";
import { RenderTargetLowerer } from "../src/lowering/render-target-lowerer.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { doctoredContext } from "./doctored-store.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const actionsModule = "src/frame-graph/frame-graph-actions.ts";
const prefix = `
import {createEngine,createSceneContext,createFrameGraphContext,createRenderTarget,
createRenderTask,addTaskAfter,createArcRotateCamera,createTaaPostProcessTask,
registerScene,registerFrameGraphContext,startEngine,onBeforeRender,createComputeTask,type Task} from "babylon-lite";
const engine=await createEngine({});
const scene=createSceneContext(engine,{defaultRenderTask:false});
const rt=createRenderTarget({format:engine.format,dFormat:"depth24plus-stencil8",samples:1,size:engine});
const task=createRenderTask({name:"pass",rt,autoMirror:false},engine,scene);
`;

test("task insertion lowers pinned first-identity lookup, append and duplicate behavior", async (t) => {
    interface TaskIdentity {
        id: number;
        name: string;
    }
    interface TaskList {
        _tasks: TaskIdentity[];
    }
    const store = new UpstreamSourceStore();
    const { addTaskAfter } = (await import(
        pathToFileURL(
            resolve(
                store.packageRoot,
                "lib",
                store.packagedModulePath(actionsModule),
            ),
        ).href
    )) as {
        addTaskAfter(
            this: void,
            target: TaskList | { _frameGraph: TaskList },
            task: TaskIdentity,
            after: TaskIdentity,
        ): void;
    };
    const tasks = Array.from({ length: 5 }, (_, id) => ({
        id,
        name: id < 2 ? "same-name" : `task-${id}`,
    }));
    const cases: {
        initial: number[];
        operations: [number, number][];
        expected: number[];
    }[] = [
        {
            initial: [0, 1, 0],
            operations: [
                [2, 0],
                [2, 0],
            ],
            expected: [0, 2, 2, 1, 0],
        },
        { initial: [0], operations: [[2, 1]], expected: [0, 2] },
        { initial: [], operations: [[2, 1]], expected: [2] },
        {
            initial: [0],
            operations: [
                [0, 0],
                [0, 0],
            ],
            expected: [0, 0, 0],
        },
        { initial: [0, 1], operations: [[0, 4]], expected: [0, 1, 0] },
    ];
    const handles = (values: readonly number[]) =>
        values.map((value) => `bbl::TaskHandle{${value}}`).join(", ");
    const checks: string[] = [];
    for (const scenario of cases) {
        for (const receiver of ["scene", "graph"]) {
            const graph = { _tasks: scenario.initial.map((id) => tasks[id]!) };
            const target =
                receiver === "scene" ? { _frameGraph: graph } : graph;
            for (const [task, after] of scenario.operations)
                addTaskAfter(target, tasks[task]!, tasks[after]!);
            const result = graph._tasks.map((task) => task.id);
            assert.deepEqual(result, scenario.expected);
            checks.push(`{
                auto& target = ${receiver};
                target.tasks = {${handles(scenario.initial)}};
                ${scenario.operations
                    .map(
                        ([task, after]) =>
                            `bbl::add_task_after(target, bbl::TaskHandle{${task}}, bbl::TaskHandle{${after}});`,
                    )
                    .join("\n")}
                assert(target.tasks == std::vector<bbl::TaskHandle>({${handles(result)}}));
            }`);
        }
    }
    assert.throws(
        () => Reflect.apply(addTaskAfter, undefined, [{}, tasks[0], tasks[1]]),
        /#116/,
    );
    const context = new LoweringContext();
    const generated = lowerFrameGraphTaskActions(context);
    const changed = lowerFrameGraphTaskActions(
        doctoredContext(
            actionsModule,
            "fg._tasks.splice(i + 1, 0, task);",
            "fg._tasks.splice(i, 0, task);",
        ),
    );
    assert.notEqual(generated, changed);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const geometry = new GeometryOutputLowerer(context).lowerTaskRecords()
        .source;
    runGeneratedProgram(
        tools,
        "frame-graph-task-actions-check",
        `
#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
namespace bbl {
${cppFunction(geometry, "FrameTaskRecord& task_record(")}
${generated}
namespace changed { ${changed} }
}
int main() {
    bbl::Engine engine;
    engine.frame_tasks.resize(5);
    bbl::Scene scene;
    scene.engine = &engine;
    bbl::FrameGraphContext graph;
    graph.engine = &engine;
    ${checks.join("\n")}
    assert(engine.frame_tasks.size() == 5);
    for (const auto& task : engine.frame_tasks) assert(!task.render_recorded);
    graph.tasks = {bbl::TaskHandle{0}, bbl::TaskHandle{1}};
    bbl::changed::add_task_after(graph, bbl::TaskHandle{2}, bbl::TaskHandle{0});
    assert(graph.tasks == std::vector<bbl::TaskHandle>({bbl::TaskHandle{2}, bbl::TaskHandle{0}, bbl::TaskHandle{1}}));
}
`,
        { flags: ["/Gy"], timeoutMs: 10000, expectedOutput: "" },
    );
});

test("task insertion refuses runtime attachment for scene and frame-graph receivers", () => {
    for (const receiver of ["scene", "graph"]) {
        const setup = prefix + "const graph=createFrameGraphContext(engine);";
        const insert = `addTaskAfter(${receiver},task,task);`;
        for (const suffix of [
            `onBeforeRender(scene,()=>{${insert}});`,
            `await startEngine(engine);${insert}`,
            `${receiver === "scene" ? "await registerScene(scene)" : "registerFrameGraphContext(graph)"};${insert}`,
        ]) {
            assert.throws(
                () => compileSource(setup + suffix),
                /addTaskAfter requires initial setup/,
            );
        }
    }
});

test("task insertion keeps engine, temporal, argument and default-task admission", (t) => {
    for (const source of [
        prefix + "addTaskAfter(scene,task,task);",
        prefix +
            "const sceneAlias=scene,taskAlias=task;addTaskAfter(sceneAlias,taskAlias,task);",
        prefix +
            "const graph=createFrameGraphContext(engine);addTaskAfter(graph,task,task);",
        prefix.replace("defaultRenderTask:false", "defaultRenderTask:true") +
            "addTaskAfter(scene,task,task);",
    ]) {
        const result = compileSource(source);
        assert.equal(result.manifest.deferredCapabilities?.length ?? 0, 0);
        assert(result.manifest.features.includes("renderer:geometry-output"));
        assert.match(result.cpp, /bbl::add_task_after/);
    }
    const isolated = compileSource(
        `import {createEngine} from "babylon-lite";const engine=await createEngine({});`,
    );
    assert(!isolated.manifest.features.includes("renderer:geometry-output"));
    assert.throws(
        () => compileSource(prefix + "addTaskAfter(task,task,task);"),
        /requires a scene or frame-graph context/,
    );
    const foreign = `
const other=await createEngine({});
const otherScene=createSceneContext(other,{defaultRenderTask:false});
const otherRt=createRenderTarget({format:other.format,dFormat:"depth24plus-stencil8",samples:1,size:other});
const foreign=createRenderTask({rt:otherRt},other,otherScene);`;
    for (const arguments_ of ["scene,foreign,task", "scene,task,foreign"])
        assert.throws(
            () =>
                compileSource(
                    prefix + foreign + `addTaskAfter(${arguments_});`,
                ),
            /one engine per entry point/,
        );
    assert.throws(
        () =>
            compileSource(
                prefix +
                    `
const camera=createArcRotateCamera(0,1,5,{x:0,y:0,z:0});scene.camera=camera;
const taa=createTaaPostProcessTask({sourceTexture:rt,sourceRenderTask:task,targetTexture:engine.scRT},engine,scene);
await registerScene(scene);await startEngine(engine);addTaskAfter(scene,task,task);`,
            ),
        /addTaskAfter requires initial setup/,
    );
    assert.throws(
        () =>
            compileSource(
                prefix.replace(
                    "createEngine({})",
                    'createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement)',
                ) +
                    'const compute=createComputeTask(engine,"compute");addTaskAfter(scene,task,compute);',
            ),
        /task.*compute-task|compute-task.*task/i,
    );
    const compiled = compileSource(
        prefix +
            `
let order=0;
function choose(expected:number):Task {if(order!==expected)throw new Error("argument order");order++;return task;}
addTaskAfter(scene,choose(0),choose(1));
if(order!==2)throw new Error("argument calls");`,
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const context = new LoweringContext();
    const geometry = new GeometryOutputLowerer(context).lowerTaskRecords()
        .source;
    const scene = new SceneLowerer(context).lowerCore().source;
    const targets = new RenderTargetLowerer(context).lower().source;
    runGeneratedProgram(
        tools,
        "frame-graph-task-adapters-check",
        `
#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
namespace bbl {
${["FrameTaskRecord& task_record(", "TaskHandle append_task(", "TaskHandle create_render_task(", "TaskHandle create_copy_to_texture_task(", "void add_task(Scene&"].map((name) => cppFunction(geometry, name)).join("\n")}
${["RenderTargetHandle create_render_target(", "RenderTargetHandle swapchain_render_target(", "RenderTextureRef render_target_texture("].map((name) => cppFunction(targets, name)).join("\n")}
${cppFunction(scene, "Scene create_scene_context(Engine&")}
${lowerFrameGraphTaskActions(context)}
Engine create_engine(EngineOptions options) {Engine engine;engine.options=options;return engine;}
}
#define main staged_entry
${compiled.cpp}
#undef main
int main() {
    assert(staged_entry() == 0);
    bbl::Engine engine;
    auto scene = bbl::create_scene_context(engine);
    bblscene::bbl_ensure_default_render_task(scene);
    assert(scene.tasks.size() == 3 && engine.frame_tasks.size() == 3);
    assert(bbl::handle_at(engine.frame_tasks, scene.tasks[0]).render.name == "default-render-task");
    bblscene::bbl_ensure_default_render_task(scene);
    assert(scene.tasks.size() == 3);
    auto disabled = bbl::configure_scene_render_defaults(bbl::create_scene_context(engine), false, 1);
    bblscene::bbl_ensure_default_render_task(disabled);
    assert(disabled.tasks.empty());
}
`,
        { flags: ["/Gy"], timeoutMs: 10000, expectedOutput: "" },
    );
});

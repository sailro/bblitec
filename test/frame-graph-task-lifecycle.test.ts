import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerFrameGraphTaskBuild } from "../src/lowering/frame-graph-task-build.js";
import { lowerEffectTaskDisposal } from "../src/lowering/frame-graph-task-disposal.js";
import { GeometryOutputLowerer } from "../src/lowering/geometry-output-lowerer.js";
import { pinnedDepthStateHeader } from "../src/lowering/pinned-depth-state.js";
import { RenderTargetLowerer } from "../src/lowering/render-target-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

interface PinTask {
    name: string;
    _passes: { _initialize(): void }[];
    record(): void;
}

const prefix = `import {createEngine,createSceneContext,createFreeCamera,createSphere,addToScene,registerScene,
createRenderTask,enableRenderTaskMeshRefresh,addTaskAtStart,addTask,addMeshToTask,
createSurfaceRenderTargetTexture,createRenderTargetTexture,withSampledDepthTexture,createEffectWrapper,
createEffectRenderTask,disposeEffectWrapper,setEffectUniforms,createMeshFromData,disposeMeshGpu,
createStandardMaterial,getFrameGraph,buildFrameGraphTask,createCopyToTextureTask} from "@babylonjs/lite";
const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
const scene=createSceneContext(engine);
const camera=createFreeCamera([0,0,-5],[0,0,0]);
scene.camera=camera;
const sphere=createSphere(engine,{diameter:1});
sphere.material=createStandardMaterial();
addToScene(scene,sphere);
await registerScene(scene);
`;

// The application's selection outline: two tasks added to the live scene,
// then recorded one by one; a failed record releases what it allocated.
const outline = `
const maskTarget=createSurfaceRenderTargetTexture(engine,{lbl:"mask",dFormat:"depth24plus",samples:1,size:engine},withSampledDepthTexture);
const maskTask=createRenderTask({name:"mask",rt:maskTarget.rt,clr:true,cam:camera,cs:true,autoMirror:false},engine,scene);
enableRenderTaskMeshRefresh(maskTask);
maskTask.executionEnabled=false;
addTaskAtStart(scene,maskTask);
const sentinel=createMeshFromData(engine,"sentinel",new Float32Array(9),new Float32Array(9),new Uint32Array([0,1,2]),new Float32Array(6));
addMeshToTask(maskTask,sentinel,{material:createStandardMaterial()});
const outlineTarget=createRenderTargetTexture(engine,{lbl:"outline",format:"rgba8unorm",samples:1,size:{width:4,height:4}});
const outlineEffect=createEffectWrapper(engine,{name:"outline",fragmentWGSL:"@group(0) @binding(0) var<uniform> u: vec4<f32>; @fragment fn effectFragment() -> @location(0) vec4<f32> { return u; }",bindings:[{binding:0,kind:"uniform",uniformByteLength:16}]});
const outlineTask=createEffectRenderTask({name:"outline",effect:outlineEffect,target:outlineTarget.rt,clear:false},engine,scene);
outlineTask.executionEnabled=false;
addTask(scene,outlineTask);
setEffectUniforms(outlineEffect,new Float32Array([1,0,0,1]));
const frameGraph=getFrameGraph(scene);
let built=false;
try { buildFrameGraphTask(frameGraph,maskTask); buildFrameGraphTask(frameGraph,outlineTask); built=true; }
catch(err) { maskTask.dispose(); disposeMeshGpu(sentinel); outlineTask.dispose(); disposeEffectWrapper(outlineEffect); }
const enable=():void=>{ if(!built) return; maskTask.executionEnabled=true; outlineTask.executionEnabled=true; };
enable();
`;

test("buildFrameGraphTask records a live task and refuses one outside the graph as the pin does", async () => {
    const { createFrameGraph, buildFrameGraphTask } = await importPinnedModule<{
        createFrameGraph(this: void, engine: object): { _tasks: PinTask[] };
        buildFrameGraphTask(this: void, fg: object, task: PinTask): void;
    }>("frame-graph/frame-graph.js");
    const events: string[] = [];
    const task = (name: string): PinTask => ({
        name,
        _passes: [{ _initialize: () => events.push(`${name} stale pass`) }],
        record() {
            events.push(`${name} record`);
            this._passes.push({
                _initialize: () => events.push(`${name} initialize`),
            });
        },
    });
    const graph = createFrameGraph({});
    const live = task("live"),
        orphan = task("orphan");
    graph._tasks.push(live);
    buildFrameGraphTask(graph, live);
    // `recordTask` empties the passes before recording, so only the new
    // pass initializes.
    assert.deepEqual(events, ["live record", "live initialize"]);
    let message = "";
    try {
        buildFrameGraphTask(graph, orphan);
    } catch (error) {
        message = (error as Error).message;
    }
    assert.deepEqual(events, ["live record", "live initialize"]);
    const native = lowerFrameGraphTaskBuild(new LoweringContext(), "", true);
    assert.ok(
        native.includes(
            `throw std::runtime_error(${JSON.stringify(message)});`,
        ),
        message,
    );
    // Membership is the scene's task list; a native record is followed by
    // the draw-list epoch the backends rebuild from.
    assert.match(
        native,
        /std::find\(scene\.tasks\.begin\(\), scene\.tasks\.end\(\), handle\)/,
    );
    assert.match(native, /\+\+engine\.draw_list_epoch;\n\}/);
    assert.match(
        native,
        /require_effect_bind_group\(engine, task\.effect\.effect\)/,
    );
    assert.doesNotMatch(
        lowerFrameGraphTaskBuild(new LoweringContext(), "", false),
        /FrameTaskKind::effect/,
    );
});

test("the live outline build lowers in strict mode and other task kinds refuse precisely", () => {
    const result = compileSource(prefix + outline);
    assert.equal(result.manifest.deferredCapabilities?.length ?? 0, 0);
    for (const feature of [
        "frame-graph:task-build",
        "frame-graph:task-disposal",
    ])
        assert.ok(result.manifest.features.includes(feature), feature);
    assert.match(result.cpp, /bbl::dispose_render_task\([^;]*maskTask\);/);
    assert.match(
        result.cpp,
        /bbl::dispose_effect_render_task\([^;]*outlineTask\);/,
    );
    assert.equal(
        result.cpp.match(/bbl::build_frame_graph_task\(v_\w*frameGraph, /g)
            ?.length,
        2,
    );
    assert.throws(
        () =>
            compileSource(
                `${prefix}const t=createRenderTargetTexture(engine,{lbl:"c",format:"rgba8unorm",samples:1,size:{width:4,height:4}});
                const u=createRenderTargetTexture(engine,{lbl:"d",format:"rgba8unorm",samples:1,size:{width:4,height:4}});
                const copy=createCopyToTextureTask({name:"copy",sourceTexture:t.texture,targetTexture:u.rt},engine,scene);
                addTask(scene,copy);
                buildFrameGraphTask(getFrameGraph(scene),copy);`,
            ),
        /buildFrameGraphTask lowers render tasks and effect render tasks\./,
    );
    // The application's removal of a half-built task: no view of the native
    // list keeps the pin's indices, so the private read refuses.
    assert.throws(
        () =>
            compileSource(
                `${prefix}${outline}const frameGraphTasks=(frameGraph as unknown as {_tasks:unknown[]})._tasks;
                const i=frameGraphTasks.indexOf(maskTask);
                if(i>=0){ frameGraphTasks.splice(i,1); }`,
            ),
        /FrameGraph\._tasks is private and is not represented/,
    );
    assert.throws(
        () =>
            compileSource(
                `${prefix}buildFrameGraphTask(getFrameGraph(engine as never),createRenderTask({name:"x",rt:createRenderTargetTexture(engine,{lbl:"x",format:"rgba8unorm",samples:1,size:{width:1,height:1}}).rt,autoMirror:false},engine,scene));`,
            ),
        /scene/i,
    );
});

interface DisposablePinTask {
    _disposed?: boolean;
    _renderables: object[];
    _pendingMeshes?: object[];
    record(): void;
    execute(): number;
    dispose(): void;
}

test("RenderTask.dispose releases owned targets once and later adds and records refuse, as the pin does", async (t) => {
    const { createRenderTask, addMeshToTask } = await importPinnedModule<{
        createRenderTask(
            this: void,
            config: object,
            engine: object,
            scene: object,
        ): DisposablePinTask;
        addMeshToTask(
            this: void,
            task: DisposablePinTask,
            mesh: object,
            options?: object,
        ): void;
    }>("frame-graph/render-task.js");
    const { enableRenderTaskMeshRefresh } = await importPinnedModule<{
        enableRenderTaskMeshRefresh(this: void, task: DisposablePinTask): void;
    }>("frame-graph/render-task-mesh-refresh.js");
    const events: string[] = [];
    const engine = {
        _device: { createBuffer: () => ({ destroy() {} }) },
    };
    const scene = { _renderables: [], _renderableVersion: 1 };
    // An RTT's target releases through its hook, a plain target destroys
    // its textures, and the swapchain's (eager, no hook) is kept.
    const rtt = (name: string): object => ({
        _descriptor: { format: "rgba8unorm", samples: 1 },
        _eager: true,
        _colorTexture: {},
        _disposeAttachments: () => events.push(`${name} retired`),
    });
    const plain = (name: string): object => ({
        _descriptor: { format: "rgba8unorm", samples: 1 },
        _colorTexture: { destroy: () => events.push(`${name} retired`) },
    });
    const swapchain = {
        _descriptor: { format: "rgba8unorm", samples: 1 },
        _eager: true,
    };
    const material = {};
    const owned = createRenderTask(
        { name: "owned", rt: rtt("rt"), rst: plain("rst"), autoMirror: false },
        engine,
        scene,
    );
    enableRenderTaskMeshRefresh(owned);
    addMeshToTask(owned, { material }, { material });
    const shared = createRenderTask(
        {
            name: "shared",
            rt: plain("shared"),
            sharedRt: true,
            autoMirror: false,
        },
        engine,
        scene,
    );
    addMeshToTask(shared, { material });
    const screen = createRenderTask(
        { name: "screen", rt: swapchain, autoMirror: false },
        engine,
        scene,
    );
    const refusal = (run: () => void): string => {
        try {
            run();
        } catch (error) {
            return (error as Error).message;
        }
        return "";
    };
    const results: string[] = [];
    for (const [name, task] of [
        ["owned", owned],
        ["shared", shared],
        ["screen", screen],
    ] as const) {
        task.dispose();
        task.dispose();
        results.push(
            `${name}:${events.splice(0).join("+")}:${task._pendingMeshes?.length ?? 0}:${refusal(() => addMeshToTask(task, { material }))}:${refusal(() => task.record())}`,
        );
    }
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const context = new LoweringContext();
    const records = new GeometryOutputLowerer(context).lowerTaskRecords(
        false,
        true,
        true,
        true,
    );
    const directory = resolve("artifacts/frame-graph-task-lifecycle/dispose"),
        include = join(directory, "include/bblite/upstream");
    mkdirSync(include, { recursive: true });
    writeFileSync(join(include, "frame_graph_geometry.hpp"), records.header);
    writeFileSync(
        join(include, "pinned_depth_state.hpp"),
        pinnedDepthStateHeader(context),
    );
    // Native targets do not tell a hook from destroyed textures: both retire.
    runGeneratedProgram(
        tools,
        "frame-graph-task-lifecycle/dispose",
        `${records.source}
${new RenderTargetLowerer(context, false, true).lower().source}
#include <iostream>
using namespace bbl;
template <class F> std::string refusal(F function) {
    try { function(); } catch (const std::runtime_error& error) { return error.what(); }
    return "";
}
int main() {
    Engine engine; Scene scene; scene.engine = &engine;
    engine.materials.resize(1); engine.meshes.resize(1);
    const char* target_names[] = {"rt", "rst", "shared", "swapchain"};
    engine.render_targets.resize(4);
    engine.render_targets[3].swapchain = true;
    const auto task = [&](RenderTargetHandle target, RenderTargetHandle resolve, bool shared) {
        RenderTaskOptions options; options.target = target; options.resolve_target = resolve;
        options.auto_mirror = false; options.shared_target = shared;
        return create_render_task(engine, scene, options);
    };
    const auto owned = task({0}, {1}, false), shared = task({2}, {}, true), screen = task({3}, {}, false);
    enable_render_task_mesh_refresh(engine, owned);
    add_render_task_mesh(engine, owned, {0}, {0}, true);
    add_render_task_mesh(engine, shared, {0}, {0}, false);
    std::string out;
    const std::pair<const char*, TaskHandle> tasks[] = {{"owned", owned}, {"shared", shared}, {"screen", screen}};
    std::uint32_t retired = 0;
    for (const auto& [name, handle] : tasks) {
        dispose_render_task(engine, handle);
        dispose_render_task(engine, handle);
        std::string released;
        for (std::uint32_t index = 0; index < 4; ++index)
            if (engine.render_targets[index].retired && !(retired & (1u << index))) {
                retired |= 1u << index;
                released += std::string(released.empty() ? "" : "+") + target_names[index] + " retired";
            }
        const auto& record = engine.frame_tasks[handle.value];
        out += std::string(out.empty() ? "" : "|") + name + ":" + released + ":" + std::to_string(record.render_meshes.size()) + ":" +
               refusal([&] { add_render_task_mesh(engine, handle, {0}, {0}, false); }) + ":" +
               // The record's first statement (build_frame_graph_task).
               refusal([&] { if (record.disposed) throw std::runtime_error("RenderTask has been disposed."); });
    }
    std::cout << out;
}
`,
        {
            flags: ["/DBBLITE_WORKERS=1", `/I${join(directory, "include")}`],
            timeoutMs: 10000,
            expectedOutput: results.join("|"),
        },
    );
});

test("an effect task's dispose clears its pipeline until the next record, as the pin does", async () => {
    const { createEffectWrapper, createEffectRenderTask } =
        await importPinnedModule<{
            createEffectWrapper(
                this: void,
                engine: object,
                options: object,
            ): object;
            createEffectRenderTask(
                this: void,
                config: object,
                engine: object,
            ): DisposablePinTask;
        }>("effect/effect-renderer.js");
    const pass = { setPipeline() {}, setBindGroup() {}, draw() {}, end() {} };
    const engine = {
        _device: {
            createShaderModule: () => ({}),
            createBindGroupLayout: () => ({}),
            createPipelineLayout: () => ({}),
            createRenderPipeline: () => ({}),
        },
        _currentEncoder: { beginRenderPass: () => pass },
    };
    const target = {
        _descriptor: {
            format: "rgba8unorm",
            samples: 1,
            size: { width: 4, height: 4 },
        },
        _eager: true,
    };
    const wrapper = createEffectWrapper(engine, {
        name: "fx",
        fragmentWGSL: "",
        bindings: [],
    });
    const task = createEffectRenderTask(
        { name: "fx", effect: wrapper, target },
        engine,
    );
    task.record();
    assert.equal(task.execute(), 1);
    task.dispose();
    let message = "";
    try {
        task.execute();
    } catch (error) {
        message = (error as Error).message;
    }
    task.record();
    assert.equal(task.execute(), 1);
    const native = lowerEffectTaskDisposal(new LoweringContext());
    assert.match(native, new RegExp(`execute throws ${message}`));
    assert.ok(
        readFileSync("native/src/pal_gpu_shared.cpp", "utf8").includes(
            `throw std::runtime_error(${JSON.stringify(message)});`,
        ),
    );
    assert.match(
        lowerFrameGraphTaskBuild(new LoweringContext(), "", true),
        /require_effect_bind_group\(engine, task\.effect\.effect\);\n\s+task\.disposed = false;/,
    );
});

test("a task added to a live scene waits for its record, as the pin's unrecorded execute fails", async () => {
    const { createEffectWrapper, createEffectRenderTask } =
        await importPinnedModule<{
            createEffectWrapper(
                this: void,
                engine: object,
                options: object,
            ): object;
            createEffectRenderTask(
                this: void,
                config: object,
                engine: object,
            ): DisposablePinTask;
        }>("effect/effect-renderer.js");
    const task = createEffectRenderTask(
        {
            name: "late",
            effect: createEffectWrapper(
                {},
                { name: "late", fragmentWGSL: "", bindings: [] },
            ),
            target: {
                _descriptor: { format: "rgba8unorm", samples: 1 },
                _eager: true,
            },
        },
        {},
    );
    let message = "";
    try {
        task.execute();
    } catch (error) {
        message = (error as Error).message;
    }
    assert.ok(
        readFileSync("native/src/pal_gpu_shared.cpp", "utf8").includes(
            `throw std::runtime_error(${JSON.stringify(message)});`,
        ),
        message,
    );
    const live = compileSource(
        `${prefix}const t=createRenderTargetTexture(engine,{lbl:"l",format:"rgba8unorm",samples:1,size:{width:4,height:4}});
        const task=createRenderTask({name:"late",rt:t.rt,autoMirror:false},engine,scene);
        addTaskAtStart(scene,task);
        buildFrameGraphTask(getFrameGraph(scene),task);`,
    );
    assert.ok(live.manifest.features.includes("frame-graph:live-task-add"));
    assert.match(live.cpp, /bbl::add_live_task\([^;]*, true\);/);
    // Before registration the build records every task: no live add.
    const setup = compileSource(
        prefix.replace(
            "await registerScene(scene);\n",
            `const t=createRenderTargetTexture(engine,{lbl:"l",format:"rgba8unorm",samples:1,size:{width:4,height:4}});
            addTask(scene,createRenderTask({name:"early",rt:t.rt,autoMirror:false},engine,scene));
            await registerScene(scene);\n`,
        ),
    );
    assert.ok(!setup.manifest.features.includes("frame-graph:live-task-add"));
    assert.doesNotMatch(setup.cpp, /add_live_task/);
});

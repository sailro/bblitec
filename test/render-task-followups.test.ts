import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { GeometryOutputLowerer } from "../src/lowering/geometry-output-lowerer.js";
import { renderTaskRemovalHeader } from "../src/lowering/render-task-removal.js";
import { pinnedDepthStateHeader } from "../src/lowering/pinned-depth-state.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
import { createPinnedScene, type PinnedScene } from "./pinned-scene.js";

interface PinMesh {
    name: string;
    material: object;
}
interface PinRenderable {
    mesh: PinMesh;
    order: number;
    bind(): object;
}
interface PinTask {
    _renderables: PinRenderable[];
    enabled?: boolean;
    record(): void;
    execute(): number;
}

/** Builds the lowered task records into a fixture folder with their headers. */
function taskRecordsFixture(
    name: string,
    lowered: { header: string; source: string },
): string {
    const directory = resolve("artifacts", name),
        include = join(directory, "include/bblite/upstream");
    mkdirSync(include, { recursive: true });
    writeFileSync(join(include, "frame_graph_geometry.hpp"), lowered.header);
    writeFileSync(
        join(include, "render_task_removal.hpp"),
        renderTaskRemovalHeader(new LoweringContext()),
    );
    writeFileSync(
        join(include, "pinned_depth_state.hpp"),
        pinnedDepthStateHeader(new LoweringContext()),
    );
    return join(directory, "include");
}

test("refreshed render tasks queue per-task overrides in the pin's renderable order", async (t) => {
    const { createRenderTask, addMeshToTask, removeMeshFromTask } =
        await importPinnedModule<{
            createRenderTask(
                this: void,
                config: object,
                engine: object,
                scene: PinnedScene,
            ): PinTask;
            addMeshToTask(
                this: void,
                task: PinTask,
                mesh: PinMesh,
                options?: { material: object },
            ): void;
            removeMeshFromTask(this: void, task: PinTask, mesh: object): void;
        }>("frame-graph/render-task.js");
    const { enableRenderTaskMeshRefresh } = await importPinnedModule<{
        enableRenderTaskMeshRefresh(this: void, task: PinTask): void;
    }>("frame-graph/render-task-mesh-refresh.js");
    const material = {
        _buildGroup: {
            _sceneIndependentRebuild: true,
            _rebuildSingle: (_scene: object, mesh: PinMesh) => {
                const renderable: PinRenderable = {
                    mesh,
                    order: 0,
                    bind: () => ({ renderable, pipeline: {}, draw: () => 1 }),
                };
                return renderable;
            },
        },
    };
    const engine = {
        _device: {
            createBuffer: () => ({ destroy() {} }),
            createBindGroupLayout: () => ({}),
            createBindGroup: () => ({}),
            queue: { writeBuffer() {} },
        },
    };
    const scene = await createPinnedScene({ engine }, { built: true });
    const rt = {
        _descriptor: { format: "rgba8unorm", samples: 1 },
        _eager: true,
        _width: 4,
        _height: 4,
    };
    const mesh = (name: string): PinMesh => ({ name, material });
    const [t1, t2, t3, o1, o2, o3] = ["t1", "t2", "t3", "o1", "o2", "o3"].map(
        mesh,
    ) as [PinMesh, PinMesh, PinMesh, PinMesh, PinMesh, PinMesh];
    const task = createRenderTask(
        { name: "refreshed", rt, autoMirror: false },
        engine,
        scene,
    );
    enableRenderTaskMeshRefresh(task);
    const orders: string[] = [];
    const order = (): void => {
        orders.push(
            task._renderables
                .map((renderable) => renderable.mesh.name)
                .join(" "),
        );
    };
    addMeshToTask(task, t1);
    addMeshToTask(task, o1, { material });
    addMeshToTask(task, t2);
    addMeshToTask(task, o2, { material });
    task.record();
    order();
    addMeshToTask(task, o3, { material });
    order();
    // The refreshed execute rebinds before drawing; a disabled pass draws nothing.
    task.enabled = false;
    task.execute();
    order();
    scene._renderableVersion++;
    task.execute();
    order();
    addMeshToTask(task, t3);
    order();
    removeMeshFromTask(task, o1);
    task.execute();
    order();
    assert.deepEqual(orders, [
        "t1 t2 o1 o2",
        "o1 o2 t1 t2 o3",
        "o1 o2 t1 t2 o3",
        "o1 o2 o3 t1 t2",
        "o1 o2 o3 t1 t2 t3",
        "o2 o3 t1 t2 t3",
    ]);

    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const lowered = new GeometryOutputLowerer(
        new LoweringContext(),
    ).lowerTaskRecords({ meshRemoval: true, refreshedOverrides: true });
    const include = taskRecordsFixture(
        "render-task-followups/refreshed-overrides",
        lowered,
    );
    runGeneratedProgram(
        tools,
        "render-task-followups/refreshed-overrides",
        `${lowered.source}
#include <cassert>
#include <iostream>
using namespace bbl;
int main() {
    Engine engine; Scene scene; scene.engine = &engine;
    engine.render_targets.emplace_back(); engine.materials.resize(2); engine.meshes.resize(6);
    for (auto& mesh : engine.meshes) mesh.material = {0};
    const char* names[] = {"t1", "t2", "t3", "o1", "o2", "o3"};
    const MeshHandle t1{0}, t2{1}, t3{2}, o1{3}, o2{4}, o3{5};
    const MaterialHandle view{1};
    RenderTaskOptions options; options.target = {0}; options.auto_mirror = false;
    const auto handle = create_render_task(engine, scene, options);
    enable_render_task_mesh_refresh(engine, handle);
    auto& task = engine.frame_tasks[handle.value];
    std::string orders;
    const auto order = [&] {
        std::string line;
        for (const auto& entry : task.render_meshes) line += std::string(line.empty() ? "" : " ") + names[entry.mesh.value];
        orders += line + ";";
    };
    // What a backend's draw-list build publishes after drawing.
    const auto build = [&] {
        order_refreshed_render_task(task);
        task.record_state = FrameTaskRecordState::recorded;
        task.render_meshes_dirty = false;
        task.shader_packet_rebuild_pending = false;
        task.shader_packet_scene_version = static_cast<double>(scene.state->renderable_version);
    };
    add_render_task_mesh(engine, handle, t1, {0}, false);
    add_render_task_mesh(engine, handle, o1, view, true);
    add_render_task_mesh(engine, handle, t2, {0}, false);
    add_render_task_mesh(engine, handle, o2, view, true);
    // Registration records the task.
    task.record_state = FrameTaskRecordState::recorded;
    task.shader_packet_scene_version = static_cast<double>(scene.state->renderable_version);
    build(); order();
    const auto epoch = engine.draw_list_epoch;
    add_render_task_mesh(engine, handle, o3, view, true);
    assert(engine.draw_list_epoch > epoch && !task.render_meshes_dirty && task.shader_packet_rebuild_pending);
    build(); order();
    build(); order();
    ++scene.state->renderable_version;
    build(); order();
    add_render_task_mesh(engine, handle, t3, {0}, false);
    build(); order();
    remove_render_task_mesh(engine, handle, o1);
    build(); order();
    for (const auto& entry : task.render_meshes)
        assert(entry.follows_material == (entry.mesh.value < 3) &&
               entry.material.value == (entry.follows_material ? 0u : 1u));
    std::cout << orders;
}
`,
        {
            flags: ["/DBBLITE_WORKERS=1", `/I${include}`],
            timeoutMs: 10000,
            expectedOutput: orders.map((line) => `${line};`).join(""),
        },
    );
});

test("refreshed task overrides lower where refresh and an override are both reached", () => {
    const source = `import {createEngine,createSceneContext,createFreeCamera,createSphere,addToScene,registerScene,
        createRenderTask,enableRenderTaskMeshRefresh,addTask,addMeshToTask,removeMeshFromTask,
        createRenderTargetTexture,createStandardMaterial} from "@babylonjs/lite";
        const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
        const scene=createSceneContext(engine);
        scene.camera=createFreeCamera([0,0,-5],[0,0,0]);
        const sphere=createSphere(engine,{diameter:1});
        sphere.material=createStandardMaterial();
        addToScene(scene,sphere);
        const target=createRenderTargetTexture(engine,{lbl:"t",format:"rgba8unorm",dFormat:"depth24plus",samples:1,size:{width:8,height:8}});
        const task=createRenderTask({name:"mask",rt:target.rt,autoMirror:false},engine,scene);
        enableRenderTaskMeshRefresh(task);
        addMeshToTask(task,sphere,{material:createStandardMaterial()});
        addTask(scene,task);
        await registerScene(scene);
        removeMeshFromTask(task,sphere);`;
    const result = compileSource(source);
    for (const feature of [
        "frame-graph:task-mesh-refresh",
        "frame-graph:task-material-override",
    ])
        assert.ok(result.manifest.features.includes(feature));
    const context = new LoweringContext();
    const geometry = new GeometryOutputLowerer(context);
    assert.match(
        geometry.lowerTaskRecords({ refreshedOverrides: true }).source,
        /queue_refreshed_render_task_mesh\(engine, record, mesh, material\)/,
    );
    assert.match(
        geometry.lowerTaskRecords().source,
        /Mesh refresh with per-task material overrides is not supported/,
    );
});

const nullableTaskPrefix = `import {createEngine,createSceneContext,createFreeCamera,createSphere,addToScene,registerScene,
createRenderTask,enableRenderTaskMeshRefresh,addTask,addMeshToTask,removeMeshFromTask,createRenderTarget,
createStandardMaterial,type Mesh,type Material,type RenderTask,type EngineContext,type SceneContext,
type Camera} from "@babylonjs/lite";
const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
const scene=createSceneContext(engine);
const camera=createFreeCamera([0,0,-5],[0,0,0]);
scene.camera=camera;
const sphere=createSphere(engine,{diameter:1});
sphere.material=createStandardMaterial();
addToScene(scene,sphere);
`;

test("a render task's own enabled gate lowers beside executionEnabled", () => {
    const result = compileSource(
        nullableTaskPrefix +
            `const target=createRenderTarget({lbl:"t",dFormat:"depth24plus",samples:1,size:engine});
const task=createRenderTask({name:"overlay",rt:target,cam:camera,autoMirror:false},engine,scene);
addTask(scene,task);
task.enabled = false;
(task as unknown as {enabled:boolean}).enabled = Math.random() < 2;
await registerScene(scene);`,
    );
    assert.equal(result.cpp.match(/\.render_enabled = /g)?.length, 2);
    assert.doesNotMatch(result.cpp, /execution_enabled = /);
});

// The application's optional visibility capture: a sample count fixed per
// call site selects the task or null, and every later use is guarded.
const visibilityCapture = (call: string): string => `
function setup(engine:EngineContext,scene:SceneContext,camera:Camera,sceneSamples:1|4=1):(mesh:Mesh)=>void{
  const visibilityTarget=sceneSamples>1?createRenderTarget({lbl:"vis",dFormat:"depth24plus-stencil8",samples:sceneSamples,size:engine}):null;
  const visibilityCapture=visibilityTarget?createRenderTask({name:"vis",rt:visibilityTarget,cam:camera,autoMirror:false},engine,scene):null;
  if(visibilityCapture) enableRenderTaskMeshRefresh(visibilityCapture);
  const depthView:Material|null=visibilityCapture?createStandardMaterial():null;
  if(depthView) addMeshToTask(visibilityCapture!,sphere,{material:depthView});
  if(visibilityCapture&&visibilityTarget) addTask(scene,visibilityCapture);
  return (mesh:Mesh):void=>{ if(visibilityCapture) removeMeshFromTask(visibilityCapture,mesh); };
}
const unregister=${call};
await registerScene(scene);
unregister(sphere);
`;

test("nullable render tasks lower through optional resource storage at every guarded use", () => {
    const shapes: Record<string, string> = {
        absentSamples: visibilityCapture("setup(engine,scene,camera)"),
        presentSamples: visibilityCapture("setup(engine,scene,camera,4)"),
        runtimeSelected: `
const rt=createRenderTarget({lbl:"x",format:"rgba8unorm",samples:1,size:engine});
const task=Math.random()<0.5?createRenderTask({name:"x",rt,autoMirror:false},engine,scene):null;
if(task) enableRenderTaskMeshRefresh(task);
if(task) addMeshToTask(task,sphere,{material:createStandardMaterial()});
if(task!==null) addTask(scene,task);
await registerScene(scene);
const drop=(mesh:Mesh):void=>{ if(!task) return; removeMeshFromTask(task,mesh); };
drop(sphere);
`,
        assignedLater: `
let late:RenderTask|null=null;
const start=():void=>{
  late=createRenderTask({name:"late",rt:createRenderTarget({lbl:"l",format:"rgba8unorm",samples:1,size:engine}),autoMirror:false},engine,scene);
  addMeshToTask(late,sphere); addTask(scene,late);
};
start();
await registerScene(scene);
if(late) removeMeshFromTask(late,sphere);
late=null;
`,
        classField: `
class Capture {
  private task: RenderTask | null = null;
  constructor(private readonly engine: EngineContext, private readonly scene: SceneContext) {}
  start(): void {
    this.task=createRenderTask({name:"c",rt:createRenderTarget({lbl:"c",format:"rgba8unorm",samples:1,size:this.engine}),autoMirror:false},this.engine,this.scene);
    addMeshToTask(this.task,sphere); addTask(this.scene,this.task);
  }
  drop(mesh: Mesh): void { if(this.task) removeMeshFromTask(this.task,mesh); }
}
const capture=new Capture(engine,scene);
capture.start();
await registerScene(scene);
capture.drop(sphere);
`,
    };
    for (const [name, body] of Object.entries(shapes)) {
        const result = compileSource(nullableTaskPrefix + body);
        assert.equal(
            result.manifest.deferredCapabilities?.length ?? 0,
            0,
            name,
        );
        assert.match(result.cpp, /std::optional<bbl::TaskHandle>/, name);
        assert.match(result.cpp, /\.has_value\(\)/, name);
        assert.match(
            result.cpp,
            /bbl::remove_render_task_mesh\(v_engine, \(\*[^;]*v_\w+\)+, v_\w+\);/,
            name,
        );
    }
    // A sample count of one folds the task away, yet the guarded uses still
    // name the entry engine and the type's render-task fact.
    assert.match(
        compileSource(nullableTaskPrefix + shapes.absentSamples).cpp,
        /std::optional<bbl::TaskHandle> v_fn\d+_visibilityCapture\{\};\s+if \(v_fn\d+_visibilityCapture\.has_value\(\)\) \{\s+bbl::enable_render_task_mesh_refresh\(v_engine,/,
    );
});

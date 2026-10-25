import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { GeometryOutputLowerer } from "../src/lowering/geometry-output-lowerer.js";
import { lowerTaskExecutionCheck } from "../src/lowering/frame-graph-task-build.js";
import { pinnedDepthStateHeader } from "../src/lowering/pinned-depth-state.js";
import { lowerGpuRetirement } from "../src/lowering/gpu-retirement-lowerer.js";
import { RenderTargetLowerer } from "../src/lowering/render-target-lowerer.js";
import { EffectLowerer } from "../src/lowering/effect-lowerer.js";
import { pinnedEffectVariantsHeader } from "../src/pinned-effect-cpp.js";
import { renderTaskRemovalHeader } from "../src/lowering/render-task-removal.js";
import { lowerMeshGpuDisposal } from "../src/lowering/mesh-gpu-disposal.js";
import {
    lowerThinInstanceDisposal,
    lowerThinInstanceOwnership,
} from "../src/lowering/thin-instance-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { doctoredContext } from "./doctored-store.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

/** The application's shapes around each API, over admitted surroundings. */
const shapePrefix = `import {createEngine,createSceneContext,createFreeCamera,createSphere,addToScene,registerScene,
createRenderTask,enableRenderTaskMeshRefresh,addTaskAtStart,addTask,addMeshToTask,removeMeshFromTask,
createSurfaceRenderTargetTexture,createRenderTargetTexture,withSampledDepthTexture,disposeRenderTargetTexture,
createEffectWrapper,createEffectRenderTask,disposeEffectWrapper,setEffectUniforms,createMeshFromData,disposeMeshGpu,
onSceneDispose,createStandardMaterial,type Mesh,type Material,type RenderTask,type SceneContext,
type RenderTargetTextureResult} from "@babylonjs/lite";
const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
const scene=createSceneContext(engine);
const camera=createFreeCamera([0,0,-5],[0,0,0]);
scene.camera=camera;
const sphere=createSphere(engine,{diameter:1});
sphere.material=createStandardMaterial();
addToScene(scene,sphere);
`;

const applicationShapes: Record<string, string> = {
    // A depth prepass registry: register/unregister methods over a closed task.
    depthPrepass: `
const target=createSurfaceRenderTargetTexture(engine,{lbl:"depth",dFormat:"depth24plus",samples:1,size:engine},withSampledDepthTexture);
const task=createRenderTask({name:"depth",rt:target.rt,clr:true,cam:camera,cs:true,autoMirror:false},engine,scene);
enableRenderTaskMeshRefresh(task);
addTaskAtStart(scene,task);
const registered=new Set<Mesh>();
const prepass={
  register(mesh:Mesh):void{ if(registered.has(mesh)||!mesh.material){return;} registered.add(mesh); addMeshToTask(task,mesh); },
  unregister(mesh:Mesh):void{ if(!registered.delete(mesh)){return;} removeMeshFromTask(task,mesh); },
};
prepass.register(sphere);
await registerScene(scene);
prepass.unregister(sphere);
`,
    // A per-frame capture sync: removal while iterating a Map of registrations.
    captureSync: `
const tags=createSurfaceRenderTargetTexture(engine,{lbl:"tags",format:"rgba16float",dFormat:"depth24plus-stencil8",samples:1,size:engine},withSampledDepthTexture);
const capture=createRenderTask({name:"tags",rt:tags.rt,cam:camera,autoMirror:false,clrColor:{r:0,g:0,b:0,a:0}},engine,scene);
enableRenderTaskMeshRefresh(capture);
const visibilityCapture:RenderTask=createRenderTask({name:"vis",rt:tags.rt,cam:camera,autoMirror:false},engine,scene);
enableRenderTaskMeshRefresh(visibilityCapture);
const sceneMeshes:Mesh[]=[sphere];
const registered=new Map<Mesh,Material>();
const syncMeshes=():void=>{
  const live=new Set(sceneMeshes);
  for(const [mesh,material] of registered) if(!live.has(mesh)||mesh.material!==material){
    removeMeshFromTask(capture,mesh); registered.delete(mesh);
    removeMeshFromTask(visibilityCapture,mesh);
  }
  for(const mesh of sceneMeshes){ if(!mesh.material||registered.has(mesh))continue; addMeshToTask(capture,mesh); registered.set(mesh,mesh.material); }
};
syncMeshes();
addTask(scene,capture);
await registerScene(scene);
sceneMeshes.length=0;
syncMeshes();
`,
    // A selection outline: unregisterAll over an array, sentinel and effect
    // disposal on the failed-build path and in dispose().
    outline: `
const maskTarget=createSurfaceRenderTargetTexture(engine,{lbl:"mask",dFormat:"depth24plus",samples:1,size:engine},withSampledDepthTexture);
const maskTask=createRenderTask({name:"mask",rt:maskTarget.rt,clr:true,clrColor:{r:0,g:0,b:0,a:0},cam:camera,cs:true,autoMirror:false},engine,scene);
enableRenderTaskMeshRefresh(maskTask);
maskTask.executionEnabled=false;
addTaskAtStart(scene,maskTask);
const sentinel=createMeshFromData(engine,"sentinel",new Float32Array(9),new Float32Array(9),new Uint32Array([0,1,2]),new Float32Array(6));
const outlineTarget=createRenderTargetTexture(engine,{lbl:"outline",format:"rgba8unorm",samples:1,size:{width:4,height:4}});
const outlineEffect=createEffectWrapper(engine,{name:"outline",fragmentWGSL:"@group(0) @binding(0) var<uniform> u: vec4<f32>; @fragment fn effectFragment() -> @location(0) vec4<f32> { return u; }",bindings:[{binding:0,kind:"uniform",uniformByteLength:16}]});
const outlineTask=createEffectRenderTask({name:"outline",effect:outlineEffect,target:outlineTarget.rt,clear:false},engine,scene);
addTask(scene,outlineTask);
setEffectUniforms(outlineEffect,new Float32Array([1,0,0,1]));
const registered:Mesh[]=[];
const unregisterAll=():void=>{ for(const m of registered){ removeMeshFromTask(maskTask,m); } registered.length=0; };
registered.push(sphere); addMeshToTask(maskTask,sphere);
let built=false;
try { await registerScene(scene); built=true; } catch(error){ disposeMeshGpu(sentinel); disposeEffectWrapper(outlineEffect); }
const outline={ dispose():void{ unregisterAll(); built=false; maskTask.executionEnabled=false; disposeEffectWrapper(outlineEffect); } };
if(built) outline.dispose();
disposeMeshGpu(sentinel);
`,
    // A scene-tracked sampled target, released by a generic dispose callback.
    trackedTarget: `
interface Entry { label: string }
const registry=new Set<Entry>();
function trackSceneEagerTarget<T extends RenderTargetTextureResult>(owner:SceneContext,rtt:T):T{
  const entry:Entry={label:"rt"};
  registry.add(entry);
  onSceneDispose(owner,()=>{ registry.delete(entry); disposeRenderTargetTexture(rtt); });
  return rtt;
}
const placeholder=trackSceneEagerTarget(scene,createRenderTargetTexture(engine,{lbl:"ph",dFormat:"depth24plus",samples:1,size:{width:1,height:1}},withSampledDepthTexture)).texture;
void placeholder;
await registerScene(scene);
`,
};

test("strict mode lowers task mesh removal and the three GPU disposals at the application's shapes", () => {
    const expected: Record<string, [string, string][]> = {
        depthPrepass: [
            ["frame-graph:task-mesh-removal", "bbl::remove_render_task_mesh("],
        ],
        captureSync: [
            ["frame-graph:task-mesh-removal", "bbl::remove_render_task_mesh("],
        ],
        outline: [
            ["frame-graph:task-mesh-removal", "bbl::remove_render_task_mesh("],
            ["mesh:dispose-gpu", "bbl::dispose_mesh_gpu("],
            ["effect:wrapper-disposal", "bbl::dispose_effect_wrapper("],
        ],
        trackedTarget: [
            [
                "frame-graph:target-disposal",
                "bbl::dispose_render_target_texture(",
            ],
        ],
    };
    for (const [name, body] of Object.entries(applicationShapes)) {
        for (const options of [
            {},
            { deferredCapabilities: "runtime-throw" as const },
        ]) {
            const result = compileSource(shapePrefix + body, options);
            assert.equal(
                result.manifest.deferredCapabilities?.length ?? 0,
                0,
                name,
            );
            for (const [feature, call] of expected[name]!) {
                assert.ok(result.manifest.features.includes(feature), name);
                assert.ok(result.cpp.includes(call), `${name}: ${call}`);
            }
        }
    }
    assert.throws(
        () =>
            compileSource(
                `${shapePrefix}const task=createRenderTask({name:"t",rt:createRenderTargetTexture(engine,{format:"rgba8unorm",samples:1,size:{width:1,height:1}}).rt,autoMirror:false},engine,scene);
                removeMeshFromTask(task,camera);`,
            ),
        /mesh/i,
    );
});

test("each disposal lowering is emitted only where its API is reached", () => {
    const context = new LoweringContext();
    const geometry = new GeometryOutputLowerer(context);
    assert.doesNotMatch(
        geometry.lowerTaskRecords().source,
        /remove_render_task_mesh/,
    );
    assert.match(
        geometry.lowerTaskRecords({ meshRemoval: true }).source,
        /void remove_render_task_mesh\(/,
    );
    assert.throws(
        () =>
            renderTaskRemovalHeader(
                doctoredContext(
                    "src/frame-graph/render-task-base.ts",
                    "        task._ob.length = 0;",
                    "        task._ob.length = 1;",
                ),
            ),
        /Removed-generation publication/,
    );
    assert.throws(
        () =>
            renderTaskRemovalHeader(
                doctoredContext(
                    "src/frame-graph/render-task-transaction.ts",
                    "task._config.autoMirror = false;",
                    "task._config.autoMirror = true;",
                ),
            ),
        /explicit population disabling scene mirroring/,
    );
});

interface PinMesh {
    name: string;
    material: object | null;
}
interface PinRenderable {
    mesh: PinMesh;
    _lifetimeDisposers?: (() => void)[];
}
interface PinTask {
    _pendingMeshes?: { mesh: PinMesh }[];
    _renderables: PinRenderable[];
    _opaqueBindings: { renderable: PinRenderable }[];
    _directBindings: { renderable: PinRenderable }[];
    _transparentBindings: { renderable: PinRenderable }[];
    _ob: object[];
    _lastVersion: number;
    _sceneBG?: object;
    _config: { autoMirror?: boolean };
    _prepareTaskMeshes?(
        candidate: { _renderables: PinRenderable[]; _pendingMeshes: object[] },
        commit: boolean,
    ): void;
}

test("render-task mesh removal matches the pin's queued, built and refreshed removals", async (t) => {
    const { createRenderTask, addMeshToTask, removeMeshFromTask } =
        await importPinnedModule<{
            createRenderTask(
                this: void,
                config: object,
                engine: object,
                scene: object,
            ): PinTask;
            addMeshToTask(this: void, task: PinTask, mesh: PinMesh): void;
            removeMeshFromTask(this: void, task: PinTask, mesh: object): void;
        }>("frame-graph/render-task.js");
    const { enableRenderTaskMeshRefresh } = await importPinnedModule<{
        enableRenderTaskMeshRefresh(this: void, task: PinTask): void;
    }>("frame-graph/render-task-mesh-refresh.js");
    const engine = { _device: { createBuffer: () => ({ destroy() {} }) } };
    const scene = { _renderables: [], _renderableVersion: 3 };
    const rt = { _descriptor: { format: "rgba8unorm", samples: 1 } };
    const a: PinMesh = { name: "a", material: {} },
        b: PinMesh = { name: "b", material: {} };
    // Queued requests of an unrecorded explicit task.
    const queued = createRenderTask(
        { name: "queued", rt, autoMirror: false },
        engine,
        scene,
    );
    addMeshToTask(queued, a);
    addMeshToTask(queued, b);
    removeMeshFromTask(queued, a);
    removeMeshFromTask(queued, a);
    assert.deepEqual(
        queued._pendingMeshes!.map((entry) => entry.mesh),
        [b],
    );
    assert.equal(queued._lastVersion, -1);
    // A built generation: the renderable retires and the bundle invalidates.
    const retired: string[] = [];
    const built = createRenderTask(
        { name: "built", rt, autoMirror: false },
        engine,
        scene,
    );
    addMeshToTask(built, a);
    const renderables = [a, b].map((mesh): PinRenderable => ({
        mesh,
        _lifetimeDisposers: [() => retired.push(mesh.name)],
    }));
    Object.assign(built, {
        _pendingMeshes: [],
        _renderables: [...renderables],
        _opaqueBindings: renderables.map((renderable) => ({ renderable })),
        _ob: [{}],
        _lastVersion: 7,
        _sceneBG: {},
    });
    removeMeshFromTask(built, a);
    assert.deepEqual(
        built._renderables.map((renderable) => renderable.mesh),
        [b],
    );
    assert.deepEqual(
        built._opaqueBindings.map((binding) => binding.renderable.mesh),
        [b],
    );
    assert.equal(built._ob.length, 0);
    assert.equal(built._lastVersion, -1);
    removeMeshFromTask(built, b);
    assert.equal(built._renderables.length, 0);
    // A refreshed task's tracked mesh leaves its next generation.
    const refreshed = createRenderTask(
        { name: "refreshed", rt, autoMirror: false },
        engine,
        scene,
    );
    enableRenderTaskMeshRefresh(refreshed);
    addMeshToTask(refreshed, a);
    const generation = (): object[] => {
        const candidate = { _renderables: [], _pendingMeshes: [] };
        refreshed._prepareTaskMeshes!(candidate, false);
        return candidate._pendingMeshes;
    };
    assert.equal(generation().length, 1);
    removeMeshFromTask(refreshed, a);
    assert.equal(generation().length, 0);
    // An automatic task mirrors the scene: nothing explicit to remove.
    const automatic = createRenderTask({ name: "auto", rt }, engine, scene);
    removeMeshFromTask(automatic, a);
    assert.equal(automatic._pendingMeshes, undefined);
    assert.equal(automatic._config.autoMirror, undefined);
    // Retirement is queued behind the next submission, not run inline.
    assert.deepEqual(retired, []);

    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const context = new LoweringContext();
    const lowered = new GeometryOutputLowerer(context).lowerTaskRecords({
        meshRemoval: true,
    });
    const directory = resolve("artifacts/engine-resource-lifetimes/removal"),
        include = join(directory, "include/bblite/upstream");
    mkdirSync(include, { recursive: true });
    writeFileSync(join(include, "frame_graph_geometry.hpp"), lowered.header);
    writeFileSync(
        join(include, "render_task_removal.hpp"),
        renderTaskRemovalHeader(context),
    );
    writeFileSync(
        join(include, "pinned_depth_state.hpp"),
        pinnedDepthStateHeader(context),
    );
    runGeneratedProgram(
        tools,
        "engine-resource-lifetimes/removal",
        `${lowered.source}
#include <cassert>
using namespace bbl;
int main() {
    Engine engine; Scene scene; scene.engine = &engine;
    engine.render_targets.emplace_back(); engine.materials.resize(2); engine.meshes.resize(3);
    engine.meshes[0].material = {0}; engine.meshes[1].material = {1}; engine.meshes[2].material = {1};
    RenderTaskOptions options; options.target = {0}; options.auto_mirror = false;
    const MeshHandle a{0}, b{1}, c{2};
    // Queued requests of an unrecorded explicit task.
    const auto queued = create_render_task(engine, scene, options);
    add_render_task_mesh(engine, queued, a, {0}, false);
    add_render_task_mesh(engine, queued, b, {1}, false);
    const auto epoch = engine.draw_list_epoch;
    remove_render_task_mesh(engine, queued, a);
    remove_render_task_mesh(engine, queued, a);
    auto& record = engine.frame_tasks[queued.value];
    assert(record.render_meshes.size() == 1 && record.render_meshes[0].mesh == b);
    assert(engine.draw_list_epoch == epoch && record.shader_packet_scene_version == -1);
    // The same task once built: the draw lists rebuild without the mesh.
    record.record_state = FrameTaskRecordState::recorded; record.shader_packet_scene_version = 7;
    add_render_task_mesh(engine, queued, a, {0}, false);
    const auto built = engine.draw_list_epoch;
    remove_render_task_mesh(engine, queued, a);
    assert(record.render_meshes.size() == 1 && record.render_meshes[0].mesh == b);
    assert(engine.draw_list_epoch == built + 1 && record.shader_packet_scene_version == -1);
    remove_render_task_mesh(engine, queued, b);
    remove_render_task_mesh(engine, queued, b);
    assert(record.render_meshes.empty() && engine.draw_list_epoch == built + 2);
    // A mirroring task that published explicit entries stops mirroring.
    RenderTaskOptions mirrored = options; mirrored.auto_mirror = true;
    const auto published = create_render_task(engine, scene, mirrored);
    add_render_task_mesh(engine, published, a, {0}, false);
    engine.frame_tasks[published.value].record_state = FrameTaskRecordState::recorded;
    remove_render_task_mesh(engine, published, a);
    assert(engine.frame_tasks[published.value].render_meshes.empty());
    assert(!engine.frame_tasks[published.value].render.auto_mirror);
    // Queued entries removed before recording leave it mirroring.
    const auto unpublished = create_render_task(engine, scene, mirrored);
    add_render_task_mesh(engine, unpublished, a, {0}, false);
    remove_render_task_mesh(engine, unpublished, a);
    assert(engine.frame_tasks[unpublished.value].render.auto_mirror);
    // A refreshed task's tracked mesh, before and after recording.
    const auto refreshed = create_render_task(engine, scene, options);
    enable_render_task_mesh_refresh(engine, refreshed);
    add_render_task_mesh(engine, refreshed, c, {1}, false);
    auto& tracked = engine.frame_tasks[refreshed.value];
    assert(tracked.render_meshes.size() == 1 && tracked.render_meshes[0].follows_material);
    tracked.render_meshes_dirty = false;
    const auto before = engine.draw_list_epoch;
    remove_render_task_mesh(engine, refreshed, c);
    assert(tracked.render_meshes.empty() && tracked.render_meshes_dirty && engine.draw_list_epoch == before);
    add_render_task_mesh(engine, refreshed, c, {1}, false);
    tracked.record_state = FrameTaskRecordState::recorded; tracked.render_meshes_dirty = false;
    const auto recorded = engine.draw_list_epoch;
    remove_render_task_mesh(engine, refreshed, c);
    assert(tracked.render_meshes.empty() && tracked.render_meshes_dirty && engine.draw_list_epoch > recorded);
    // An automatic task and a task of another kind have nothing to remove.
    const auto automatic = create_render_task(engine, scene, mirrored);
    const auto untouched = engine.draw_list_epoch;
    remove_render_task_mesh(engine, automatic, a);
    CopyTaskOptions copy; copy.target = {0};
    remove_render_task_mesh(engine, create_copy_to_texture_task(engine, scene, copy), a);
    assert(engine.draw_list_epoch == untouched && engine.frame_tasks[automatic.value].render.auto_mirror);
}
`,
        {
            flags: ["/DBBLITE_WORKERS=1", `/I${join(directory, "include")}`],
            timeoutMs: 10000,
        },
    );
});

test("mesh GPU disposal releases each claim once and refuses a mesh a scene or task still draws", async (t) => {
    interface Resource {
        destroy(): void;
    }
    interface Geometry {
        _refCount?: number;
        positionBuffer: Resource;
        normalBuffer: Resource;
        uvBuffer: Resource;
        indexBuffer: Resource;
    }
    interface Pool {
        _gpuBuffer?: Resource;
    }
    interface DisposableMesh {
        _disposed?: boolean;
        _gpu: Geometry;
        thinInstances?: Pool;
    }
    const { disposeMeshGpu } = await importPinnedModule<{
        disposeMeshGpu(this: void, mesh: DisposableMesh): void;
    }>("mesh/mesh-dispose.js");
    const { retain } = await importPinnedModule<{
        retain(this: void, resource: object): void;
    }>("resource/ref-count.js");
    const destroyed: string[] = [];
    const buffer = (name: string): Resource => ({
        destroy: () => destroyed.push(name),
    });
    const geometry: Geometry = {
        positionBuffer: buffer("position"),
        normalBuffer: buffer("normal"),
        uvBuffer: buffer("uv"),
        indexBuffer: buffer("index"),
    };
    const pool: Pool = { _gpuBuffer: buffer("matrices") };
    retain(geometry);
    retain(pool);
    const first: DisposableMesh = { _gpu: geometry, thinInstances: pool },
        second: DisposableMesh = { _gpu: geometry, thinInstances: pool };
    disposeMeshGpu(first);
    disposeMeshGpu(first);
    assert.deepEqual(destroyed, []);
    disposeMeshGpu(second);
    assert.deepEqual(destroyed, [
        "position",
        "normal",
        "uv",
        "index",
        "matrices",
    ]);
    assert.ok(first._disposed && second._disposed);

    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const context = new LoweringContext();
    runGeneratedProgram(
        tools,
        "engine-resource-lifetimes/mesh",
        `
#include <bblite/runtime.hpp>
#include <bblite/thin_instance.hpp>
#include <algorithm>
#include <cassert>
#include <string>
#include <vector>
namespace bbl {
${lowerThinInstanceOwnership(context)}
${lowerThinInstanceDisposal(context)}
${lowerMeshGpuDisposal(context, true)}
}
struct Buffer final : bbl::GpuObject {
    std::vector<std::string>& destroyed;
    std::string name;
    Buffer(std::vector<std::string>& log, std::string label) : destroyed(log), name(std::move(label)) {}
    void destroy() override { destroyed.push_back(name); }
};
template <class F> bool rejects(F function) {
    try { function(); } catch (const std::runtime_error& error) {
        return std::string(error.what()).find("still listed by a scene or render task") != std::string::npos;
    }
    return false;
}
int main() {
    using namespace bbl;
    std::vector<std::string> destroyed;
    Engine engine;
    engine.geometries.emplace_back().owners = 2;
    engine.geometries[0].vertices.resize(3);
    engine.meshes.resize(4);
    auto pool = std::make_shared<ThinInstancePoolData>();
    pool->gpu_buffer = std::make_shared<Buffer>(destroyed, "matrices");
    retain_thin_instance_pool(pool);
    for (std::uint32_t index = 0; index < 2; ++index) {
        engine.meshes[index].geometry = 0;
        engine.meshes[index].thin_instances = pool;
    }
    dispose_mesh_gpu(engine, {0});
    dispose_mesh_gpu(engine, {0});
    assert(engine.meshes[0].retired && engine.geometries[0].owners == 1 && destroyed.empty());
    assert(engine.free_geometry_slots.empty() && engine.geometries[0].vertices.size() == 3);
    dispose_mesh_gpu(engine, {1});
    assert(engine.meshes[1].retired && engine.free_geometry_slots == std::vector<std::uint32_t>{0});
    assert(engine.geometries[0].vertices.empty() && destroyed == std::vector<std::string>{"matrices"});
    // A mesh a scene still lists keeps its claims.
    auto state = std::make_shared<SceneState>();
    engine.mesh_material_scenes.insert_or_assign(
        2u, std::make_shared<MeshMaterialSceneOwners>(MeshMaterialSceneOwners{state}));
    engine.meshes[2].geometry = invalid_handle;
    assert(rejects([&] { dispose_mesh_gpu(engine, {2}); }) && !engine.meshes[2].retired);
    // A render task of a live scene still draws it; a disposed scene's task does not.
    engine.mesh_material_scenes.erase(2u);
    FrameTaskRecord& task = engine.frame_tasks.emplace_back();
    task.render_meshes.push_back(RenderTaskMesh{MeshHandle{2}, MaterialHandle{}});
    task.source_scene = state;
    assert(rejects([&] { dispose_mesh_gpu(engine, {2}); }) && !engine.meshes[2].retired);
    state->disposed = true;
    dispose_mesh_gpu(engine, {2});
    assert(engine.meshes[2].retired);
    // A handle whose slot a later mesh took names a disposed mesh.
    const MeshHandle stale{3, 0};
    engine.meshes[3].retired = true;
    engine.meshes[3].generation = 1;
    dispose_mesh_gpu(engine, stale);
}
`,
        { timeoutMs: 10000 },
    );
});

test("effect wrapper disposal empties the pin's slots and the next bind-group build refuses them", async (t) => {
    type Binding = {
        binding: number;
        kind: "uniform" | "texture" | "sampler";
        name?: string;
        uniformByteLength?: number;
        textureBinding?: number;
    };
    interface Task {
        record(): void;
        execute(): number;
    }
    const pin = await importPinnedModule<{
        createEffectWrapper(
            this: void,
            engine: object,
            options: object,
        ): object;
        setEffectUniforms(this: void, wrapper: object, data: object): void;
        setEffectTexture(
            this: void,
            wrapper: object,
            binding: number,
            texture: object,
        ): void;
        disposeEffectWrapper(this: void, wrapper: object): void;
        createEffectRenderTask(
            this: void,
            config: object,
            engine: object,
        ): Task;
        createEffectRenderer(
            this: void,
            surface: object,
            wrapper: object,
        ): object;
        registerEffectRenderer(this: void, renderer: object): void;
    }>("effect/effect-renderer.js");
    const destroyed: string[] = [];
    const pass = {
        setPipeline() {},
        setBindGroup() {},
        draw() {},
        end() {},
    };
    const engine = {
        _device: {
            createBuffer: (descriptor: { label: string }) => ({
                destroy: () => destroyed.push(descriptor.label),
            }),
            createShaderModule: () => ({}),
            createPipelineLayout: () => ({}),
            createBindGroupLayout: () => ({}),
            createRenderPipeline: () => ({}),
            createBindGroup: () => ({}),
            queue: { writeBuffer() {} },
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
    const texture = { view: {}, sampler: {} };
    const wrappers: Record<string, Binding[]> = {
        uniformFirst: [
            { binding: 2, kind: "sampler", textureBinding: 1 },
            { binding: 0, kind: "uniform", uniformByteLength: 16 },
            { binding: 1, kind: "texture", name: "t" },
        ],
        textureFirst: [
            { binding: 0, kind: "texture", name: "a" },
            { binding: 1, kind: "sampler" },
        ],
        samplerFirst: [
            { binding: 0, kind: "sampler", textureBinding: 1 },
            { binding: 1, kind: "texture", name: "b" },
        ],
        unbound: [],
    };
    const codes: Record<string, string> = {};
    for (const [name, bindings] of Object.entries(wrappers)) {
        const wrapper = pin.createEffectWrapper(engine, {
            name,
            fragmentWGSL: "",
            bindings,
        });
        const task = pin.createEffectRenderTask(
            { name, effect: wrapper, target },
            engine,
        );
        for (const binding of bindings)
            if (binding.kind === "texture")
                pin.setEffectTexture(wrapper, binding.binding, texture);
        if (bindings.some((binding) => binding.kind === "uniform"))
            pin.setEffectUniforms(wrapper, new Float32Array(4));
        task.record();
        assert.equal(task.execute(), 1);
        pin.disposeEffectWrapper(wrapper);
        assert.throws(
            () => pin.setEffectUniforms(wrapper, new Float32Array(4)),
            /#34/,
        );
        assert.throws(() => pin.setEffectTexture(wrapper, 0, texture), /#36/);
        try {
            codes[name] = String(task.execute());
        } catch (error) {
            codes[name] = (error as Error).message;
        }
        const renderer = pin.createEffectRenderer(
            {
                engine,
                msaaSamples: 1,
                format: "rgba8unorm",
                scRT: target,
                _renderingContexts: [],
            },
            wrapper,
        );
        if (bindings.length > 0)
            assert.throws(
                () => pin.registerEffectRenderer(renderer),
                (error: unknown) => (error as Error).message === codes[name],
            );
    }
    assert.deepEqual(codes, {
        uniformFirst: "#40",
        textureFirst: "#41",
        samplerFirst: "#42",
        unbound: "1",
    });
    assert.deepEqual(destroyed, ["uniformFirst-0-ubo"]);

    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const manifests = Object.entries(wrappers).map(([name, bindings]) => ({
        family: "effect" as const,
        name,
        fragment: "",
        bindings: [...bindings]
            .sort((left, right) => left.binding - right.binding)
            .map((binding) => ({
                name: binding.name ?? "",
                binding: binding.binding,
                kind: binding.kind,
                uniformBytes: binding.uniformByteLength ?? 0,
                texture: binding.kind === "sampler" ? 0 : -1,
            })),
    }));
    const variants = pinnedEffectVariantsHeader("fixture", manifests);
    const directory = resolve("artifacts/engine-resource-lifetimes/effect");
    mkdirSync(join(directory, "include/bblite/upstream"), { recursive: true });
    writeFileSync(
        join(directory, "include/bblite/upstream/effect_variants.hpp"),
        variants.header,
    );
    runGeneratedProgram(
        tools,
        "engine-resource-lifetimes/effect",
        `#include <bblite/upstream/effect_variants.hpp>
${variants.definitions}
${new EffectLowerer(new LoweringContext()).lowerFactory({ disposal: true }).source}
#include <cassert>
using namespace bbl;
template <class F> std::string refusal(F function) {
    try { function(); } catch (const std::runtime_error& error) { return error.what(); }
    return "1";
}
int main() {
    Engine engine;
    const char* names[] = {"t", "a", "b"};
    std::string codes;
    for (std::uint32_t variant = 0; variant < 4; ++variant) {
        const auto wrapper = create_effect_wrapper(engine, variant);
        for (const char* name : names)
            for (const auto& slot : engine.effect_wrappers[wrapper.value].textures)
                if (slot.name == name) set_effect_texture(engine, wrapper, name, SolidTexture{});
        if (variant == 0) set_effect_uniforms(engine, wrapper, {1, 2, 3, 4});
        require_effect_bind_group(engine, wrapper);
        require_effect_renderer_storage(engine, wrapper);
        dispose_effect_wrapper(engine, wrapper);
        assert(refusal([&] { set_effect_uniforms(engine, wrapper, {1}); }) ==
               "setEffectUniforms: wrapper has no uniform binding.");
        assert(refusal([&] { set_effect_texture(engine, wrapper, "t", SolidTexture{}); })
                   .starts_with("setEffectTexture: unknown texture binding"));
        const std::string code = refusal([&] { require_effect_bind_group(engine, wrapper); });
        codes += code + ",";
        const auto renderer = create_effect_renderer(engine, wrapper, EffectRendererOptions{});
        if (variant < 3) assert(refusal([&] { register_effect_renderer(engine, renderer); }) == code);
        // A kept renderer group binds destroyed uniform storage; texture slots keep their images.
        assert((refusal([&] { require_effect_renderer_storage(engine, wrapper); }) != "1") == (variant == 0));
    }
    assert(codes == "#40,#41,#42,1,");
}
`,
        {
            flags: [`/I${join(directory, "include")}`],
            timeoutMs: 10000,
        },
    );
});

interface MockTexture {
    sampleCount: number;
    createView(): object;
    destroy(): void;
}
interface MockEngine {
    canvas: { width: number; height: number };
    _device: {
        createTexture(descriptor: { sampleCount: number }): MockTexture;
        createSampler(): object;
        queue: { onSubmittedWorkDone(): Promise<void> };
    };
}
interface PinTarget {
    rt: { _syncEager(engine: MockEngine): void };
}

test("render-target texture disposal releases the attachments once and later builds refuse", async (t) => {
    const rtt = await importPinnedModule<{
        createRenderTargetTexture(
            this: void,
            engine: MockEngine,
            descriptor: object,
        ): PinTarget;
        disposeRenderTargetTexture(this: void, target: PinTarget): void;
    }>("texture/rtt.js");
    const surfaces = await importPinnedModule<{
        createSurfaceRenderTargetTexture(
            this: void,
            engine: MockEngine,
            descriptor: object,
        ): PinTarget;
        onRenderTargetTextureResize(
            this: void,
            target: PinTarget,
            callback: () => void,
        ): () => void;
    }>("texture/rtt-surface.js");
    const { waitForGpuResourceRetirements } = await importPinnedModule<{
        waitForGpuResourceRetirements(
            this: void,
            engine: MockEngine,
        ): Promise<void>;
    }>("engine/gpu-resource-retirement.js");
    const events: string[] = [];
    let serial = 0;
    const engine: MockEngine = {
        canvas: { width: 64, height: 64 },
        _device: {
            createTexture(descriptor) {
                const id = ++serial;
                return {
                    sampleCount: descriptor.sampleCount,
                    createView: () => ({}),
                    destroy: () => events.push(`release${id}`),
                };
            },
            createSampler: () => ({}),
            queue: { onSubmittedWorkDone: () => Promise.resolve() },
        },
    };
    const fixed = rtt.createRenderTargetTexture(engine, {
        format: "rgba8unorm",
        samples: 1,
        size: { width: 4, height: 4 },
    });
    surfaces.onRenderTargetTextureResize(fixed, () => events.push("fixed"));
    rtt.disposeRenderTargetTexture(fixed);
    rtt.disposeRenderTargetTexture(fixed);
    assert.deepEqual(events, ["release1"]);
    assert.throws(
        () => surfaces.onRenderTargetTextureResize(fixed, () => {}),
        /#841/,
    );
    assert.throws(() => fixed.rt._syncEager(engine), /#842/);
    // A surface target whose replacement still awaits delivery.
    const surface = surfaces.createSurfaceRenderTargetTexture(engine, {
        format: "rgba8unorm",
        samples: 1,
        size: engine,
    });
    surfaces.onRenderTargetTextureResize(surface, () => {
        events.push("a");
        throw new Error("retry");
    });
    engine.canvas.width = 65;
    assert.throws(() => surface.rt._syncEager(engine), /retry/);
    rtt.disposeRenderTargetTexture(surface);
    assert.deepEqual(events, ["release1", "a", "release3"]);
    await waitForGpuResourceRetirements(engine);
    assert.deepEqual(events, ["release1", "a", "release3", "release2"]);
    assert.throws(
        () => surfaces.onRenderTargetTextureResize(surface, () => {}),
        /#841/,
    );
    assert.throws(() => surface.rt._syncEager(engine), /#838/);

    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const context = new LoweringContext();
    runGeneratedProgram(
        tools,
        "engine-resource-lifetimes/target",
        lowerGpuRetirement(context).source +
            new RenderTargetLowerer(context, {
                surface: true,
                disposal: true,
            }).lower().source +
            `
#include <bblite/js_realm_state.hpp>
#include <cassert>
#include <iostream>
using namespace bbl;
template <class F> std::string refusal(F function) {
    try { function(); } catch (const std::runtime_error& error) { return error.what(); }
    return "";
}
static pal::GpuCompletion check(pal::EventLoop& loop, std::string& events) {
    auto add = [&events](const std::string& value) { if (!events.empty()) events += ","; events += value; };
    auto gpu = std::make_shared<pal::GpuRetirementState>();
    gpu->submitted_work_done = [] { return pal::GpuCompletion::resolved({}); };
    Engine engine; engine.gpu_retirements = gpu;
    RenderTargetOptions fixed_options; fixed_options.width = 4; fixed_options.height = 4;
    const auto fixed = create_render_target_texture(engine, fixed_options);
    (void)on_render_target_texture_resize(engine, fixed, [&] { add("fixed"); });
    const auto version = engine.render_targets_version;
    dispose_render_target_texture(engine, fixed);
    dispose_render_target_texture(engine, fixed);
    // The backend releases the attachments at its next target build.
    if (engine.render_targets[fixed.rt.value].retired && engine.render_targets_version == version + 1) add("release1");
    assert(refusal([&] { (void)on_render_target_texture_resize(engine, fixed, [] {}); }) == "#841");
    const auto surface = create_render_target_texture(engine, {}, true);
    const auto life = engine.render_targets[surface.rt.value].lifecycle;
    (void)on_render_target_texture_resize(engine, surface, [&] { add("a"); throw std::runtime_error("retry"); });
    life->prepare_resize();
    assert(refusal([&] { life->replaced([&] { add("release2"); }); }) == "retry");
    dispose_render_target_texture(engine, surface);
    if (engine.render_targets[surface.rt.value].retired && engine.render_targets_version == version + 2) add("release3");
    co_await wait_for_gpu_resource_retirements(gpu);
    assert(refusal([&] { (void)on_render_target_texture_resize(engine, surface, [] {}); }) == "#841");
    assert(refusal([&] { life->synchronize(); }) == "#838");
    assert(refusal([&] { life->prepare_resize(); }) == "#838");
    loop.close(); co_return js::PromiseVoid{};
}
int main() { const js::RealmScope realm; pal::EventLoop loop; std::string events; loop.run([&] { check(loop, events); }); std::cout << events; }
`,
        {
            flags: ["/DBBLITE_WORKERS=1"],
            timeoutMs: 10000,
            expectedOutput: events.join(","),
        },
    );
});

test("both backends' shared target code skips disposed targets and refuses scheduled uses of them", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    runGeneratedProgram(
        tools,
        "engine-resource-lifetimes/shared-targets",
        `
#include <cassert>
#include <string>
#include "pal_gpu_target_lifetimes.hpp"
namespace bbl {
${lowerTaskExecutionCheck(new LoweringContext(), { disposal: true, pendingBuild: true })}
}
using namespace bbl;
struct CountingLifecycle final : RenderTargetLifecycle {
    int synchronized = 0;
    void prepare_resize() override {}
    void replaced(std::function<void()>) override {}
    void synchronize() override { ++synchronized; }
    void dispose(std::function<void()>) override {}
    js::Callback<void()> subscribe(std::function<void()>) override { return {}; }
};
template <class F> std::string refusal(F function) {
    try { function(); } catch (const std::runtime_error& error) { return error.what(); }
    return "";
}
int main() {
    Engine engine;
    engine.render_targets.resize(3);
    const auto live = std::make_shared<CountingLifecycle>(), disposed = std::make_shared<CountingLifecycle>();
    engine.render_targets[0].lifecycle = live;
    engine.render_targets[1].lifecycle = disposed;
    engine.render_targets[1].retired = true;
    pal::synchronize_render_target_lifecycles(engine);
    assert(live->synchronized == 1 && disposed->synchronized == 0);
    const auto require = [&] { return refusal([&] { pal::require_executable_frame_tasks(engine); }); };
    // A disposed target nothing schedules is no frame's concern.
    Scene scene;
    scene.engine = &engine;
    engine.rendering_contexts.push_back("scene", std::make_shared<Scene>(scene));
    FrameTaskRecord render;
    render.render.name = "pass";
    render.render.target = {0};
    engine.frame_tasks.push_back(render);
    FrameTaskRecord effect;
    effect.kind = FrameTaskKind::effect;
    effect.effect.name = "outline";
    effect.effect.target = {1};
    effect.execution_enabled = false;
    engine.frame_tasks.push_back(effect);
    FrameTaskRecord post;
    post.kind = FrameTaskKind::post_process;
    post.post_process.name = "blur";
    post.post_process.passes.emplace_back().source.target = {1};
    engine.frame_tasks.push_back(post);
    scene.tasks = {{0}, {1}};
    assert(require().empty());
    // An executed task naming it refuses, whether it renders into or samples it.
    engine.frame_tasks[1].execution_enabled = true;
    assert(require() ==
           "Effect task 'outline' uses a render-target texture that disposeRenderTargetTexture released.");
    engine.frame_tasks[1].execution_enabled = false;
    scene.tasks.push_back({2});
    assert(require().starts_with("Post-process task 'blur'"));
    scene.tasks.pop_back();
    FrameGraphContext graph;
    graph.engine = &engine;
    graph.tasks = {{2}};
    engine.rendering_contexts.push_back("frame-graph", &graph);
    assert(require().starts_with("Post-process task 'blur'"));
    graph.tasks.clear();
    // The pin's execute failures, before any target: an effect task without
    // its pipeline, a disposed render task, any other task waiting for its build.
    engine.render_targets[1].retired = false;
    engine.frame_tasks[1].execution_enabled = true;
    engine.frame_tasks[1].disposed = true;
    assert(require() == "#37");
    engine.frame_tasks[1].disposed = false;
    engine.frame_tasks[1].record_state = FrameTaskRecordState::pending_build;
    assert(require() == "#37");
    engine.frame_tasks[1].execution_enabled = false;
    engine.frame_tasks[0].record_state = FrameTaskRecordState::pending_build;
    assert(require() == "A task added to a live scene executes before buildFrameGraphTask recorded it.");
    engine.frame_tasks[0].record_state = FrameTaskRecordState::recorded;
    engine.frame_tasks[0].disposed = true;
    assert(require() == "Render task 'pass' executes after dispose() destroyed its scene uniform buffer.");
    engine.frame_tasks[0].execution_enabled = false;
    assert(require().empty());
}
`,
        {
            flags: [
                "/DBBLITE_RENDER_TARGET_DISPOSAL=1",
                "/DBBLITE_TASK_DISPOSAL=1",
                "/DBBLITE_LIVE_TASK_ADD=1",
                "/I",
                resolve("native/src"),
            ],
            timeoutMs: 10000,
        },
    );
});

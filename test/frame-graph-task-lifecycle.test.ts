import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerFrameGraphTaskBuild } from "../src/lowering/frame-graph-task-build.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";

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
catch(err) { disposeMeshGpu(sentinel); disposeEffectWrapper(outlineEffect); }
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
    assert.ok(result.manifest.features.includes("frame-graph:task-build"));
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
    assert.throws(
        () =>
            compileSource(
                `${prefix}buildFrameGraphTask(getFrameGraph(engine as never),createRenderTask({name:"x",rt:createRenderTargetTexture(engine,{lbl:"x",format:"rgba8unorm",samples:1,size:{width:1,height:1}}).rt,autoMirror:false},engine,scene));`,
            ),
        /scene/i,
    );
});

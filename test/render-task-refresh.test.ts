import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { GeometryOutputLowerer } from "../src/lowering/geometry-output-lowerer.js";
import { pinnedDepthStateHeader } from "../src/lowering/pinned-depth-state.js";
import { composeComposite } from "../src/pinned-post-process.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("render-task shared depth policy and mesh refresh preserve source guards and current material", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const directory = resolve("artifacts/render-task-refresh-check"),
        include = join(directory, "include/bblite/upstream");
    mkdirSync(include, { recursive: true });
    const lowered = new GeometryOutputLowerer(
        new LoweringContext(),
    ).lowerTaskRecords();
    writeFileSync(join(include, "frame_graph_geometry.hpp"), lowered.header);
    writeFileSync(
        join(include, "pinned_depth_state.hpp"),
        pinnedDepthStateHeader(new LoweringContext()),
    );
    const source = join(directory, "check.cpp"),
        exe = join(directory, "check.exe");
    writeFileSync(
        source,
        lowered.source +
            `
#include <cassert>
#include <bblite/upstream/pinned_depth_state.hpp>
template<class F> void rejects(F fn,const char* text){try{fn();assert(false);}catch(const std::runtime_error& error){assert(std::string(error.what()).find(text)!=std::string::npos);}}
int main(){
 using namespace bbl; Engine engine; Scene scene;scene.engine=&engine;
 engine.render_targets.emplace_back();engine.materials.resize(2);engine.meshes.resize(2);
 engine.meshes[0].material={0};engine.meshes[1].material={1};
 RenderTaskOptions options;options.target={0};options.auto_mirror=false;
 auto task=create_render_task(engine,scene,options);enable_render_task_mesh_refresh(engine,task);
 add_render_task_mesh(engine,task,{0},{0},false);add_render_task_mesh(engine,task,{0},{0},false);
 auto& record=engine.frame_tasks[task.value];assert(record.render_meshes.size()==1);
 record.render_recorded=true;enable_render_task_mesh_refresh(engine,task);
 engine.meshes[0].material={1};assert(render_task_mesh_material(engine,record.render_meshes[0]).value==1);
 const auto version=engine.draw_list_epoch;add_render_task_mesh(engine,task,{1},{1},false);assert(engine.draw_list_epoch==version+1);
 rejects([&]{add_render_task_mesh(engine,task,{1},{0},true);},"per-task material overrides");
 auto late=create_render_task(engine,scene,options);engine.frame_tasks[late.value].render_recorded=true;
 rejects([&]{enable_render_task_mesh_refresh(engine,late);},"#122");
 options.auto_mirror=true;auto automatic=create_render_task(engine,scene,options);
 rejects([&]{enable_render_task_mesh_refresh(engine,automatic);},"#123");
 scene.disposed=true;rejects([&]{add_render_task_mesh(engine,task,{0},{1},false);},"#124");
 assert(!upstream::render_task_loads_depth(false,false,true));assert(upstream::render_task_loads_depth(false,false,false));
 assert(upstream::render_task_loads_depth(true,true,true));assert(!upstream::render_task_loads_depth(true,false,false));
}
`,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/DBBLITE_WORKERS=1",
        `/I${resolve("native/include")}`,
        `/I${join(directory, "include")}`,
        source,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});

test("Ocean render options and explicit null bloom output use pinned composition", async () => {
    const result =
        compileSource(`import {createEngine,createSceneContext,createRenderTarget,createRenderTask,enableRenderTaskMeshRefresh,createBloomPostProcessTask} from 'babylon-lite';
 const engine=await createEngine({});const scene=createSceneContext(engine,{defaultRenderTask:false});
 const rt=createRenderTarget({format:engine.format,dFormat:'depth24plus-stencil8',samples:1,size:engine});
 const task=createRenderTask({name:'ocean-scene',rt,clr:false,depthClear:false,sharedRt:true,autoMirror:false},engine,scene);
 enableRenderTaskMeshRefresh(task);
 const bloom=createBloomPostProcessTask({sourceTexture:rt,targetTexture:null,threshold:0.78,exposure:1,weight:0,kernel:48,bloomScale:0.5},engine,scene);
 const output=bloom.outputTexture;`);
    assert.match(result.cpp, /options\.depth_clear = false/);
    assert.match(result.cpp, /options\.shared_target = true/);
    assert.match(result.cpp, /enable_render_task_mesh_refresh/);
    const manifest = result.manifest.postProcessComposites[0]!;
    assert.equal(manifest.hasTarget, false);
    const composite = await composeComposite(manifest);
    assert.equal(composite.passes.length, 4);
    assert.equal(composite.intermediates.length, 3);
    assert.equal(composite.outputPass, 3);
    assert.equal(composite.passes[3]?.target.kind, "internal");
});

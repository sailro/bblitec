import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerComputeOneShot } from "../src/lowering/compute-one-shot-lowerer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";
import { compileSource } from "../src/compiler.js";

test("one-shot source preserves armed identity, submission generations, GPU completion and disposal", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/compute-one-shot-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        `${lowerComputeOneShot(new LoweringContext()).source}
#include <cassert>
struct Device final:bbl::pal::OffscreenDevice {
 std::vector<std::function<void(std::exception_ptr)>> pending;
 std::unique_ptr<bbl::pal::OffscreenCompletion> on_submitted_work_done(std::function<void(std::exception_ptr)> callback)override {pending.push_back(std::move(callback));return std::make_unique<bbl::pal::OffscreenCompletion>();}
 void finish(std::exception_ptr error={}){auto callbacks=std::move(pending);pending.clear();for(auto& callback:callbacks)callback(error);}
};
template<class F> void rejects(F callback,const std::string& expected){bool failed=false;try{callback();}catch(const std::exception& error){failed=error.what()==expected;}assert(failed);}
bbl::js::Promise<bbl::js::PromiseVoid> checks(bbl::pal::EventLoop& loop,bool& done){
 auto engine=std::make_shared<bbl::Engine>();auto device=std::make_shared<Device>();engine->offscreen_run=std::make_shared<bbl::pal::OffscreenRun>(std::make_shared<bbl::pal::OffscreenSurface>(1,1),device);
 {
  int ran=0,cancelled=0;
  rejects([&]{(void)bbl::add_frame_post_submit_hook(engine,"frame",[&](auto){++ran;});},"#50");
  const auto first_encoder=std::make_shared<bbl::pal::ComputeCommandEncoder>(device);
  const auto second_encoder=std::make_shared<bbl::pal::ComputeCommandEncoder>(device);
  engine->current_compute_encoder=first_encoder;
  auto persistent=bbl::add_frame_post_submit_hook(engine,"persistent",[&](auto){++ran;});
  auto frame=bbl::add_frame_post_submit_hook(engine,"frame",[&](auto){ran+=10;},[&]{++cancelled;});
  auto dispatch=engine->gpu_task_timer_resolve;
  assert(dispatch==engine->gpu_timer_resolve);
  dispatch(first_encoder,true);dispatch(first_encoder,true);
  assert(ran==11&&cancelled==0);
  frame();frame();
  auto abandoned=bbl::add_frame_post_submit_hook(engine,"frame",[&](auto){ran+=100;},[&]{++cancelled;});
  dispatch(second_encoder,true);
  assert(ran==12&&cancelled==1);
  abandoned();persistent();
  assert(!engine->gpu_task_timer_resolve&&!engine->gpu_timer_resolve&&!bbl::find_frame_post_submit_state(engine));
  engine->current_compute_encoder=first_encoder;
  auto cancelled_frame=bbl::add_frame_post_submit_hook(engine,"frame",[&](auto){++ran;},[&]{++cancelled;});
  engine->gpu_task_timer_resolve(first_encoder,false);
  assert(ran==12&&cancelled==2&&!engine->gpu_task_timer_resolve);
  cancelled_frame();
  auto expired=bbl::add_frame_post_submit_hook(engine,"frame",[&](auto){++ran;},[&]{++cancelled;});
  engine->current_compute_encoder.reset();
  bbl::js::Promise<bbl::js::PromiseVoid> checkpoint;
  loop.queue_microtask([checkpoint]{checkpoint.resolve(bbl::js::PromiseVoid{});});
  (void)co_await checkpoint;
  assert(ran==12&&cancelled==3&&!engine->gpu_task_timer_resolve&&!engine->gpu_timer_resolve);
  expired();
 }
 const auto makeTask=[&]{auto task=bbl::js::make_gc_shared<bbl::ComputeTask>();task->engine=engine;task->name="spectrum";return task;};
 auto task=makeTask(),other=makeTask();auto shot=bbl::create_compute_one_shot(task),second=bbl::create_compute_one_shot(other);
 auto first=shot->completion;assert(shot->generation==1&&shot->armed&&task->execution_enabled&&bbl::arm_compute_one_shot(shot)==first);
 rejects([&]{(void)bbl::create_compute_one_shot(task);},"#806");
 auto oldRecord=task->one_shot_recorded;
 auto encoder=std::make_shared<bbl::pal::ComputeCommandEncoder>(device);task->one_shot_recorded(encoder);task->one_shot_recorded(encoder);other->one_shot_recorded(encoder);
 engine->gpu_task_timer_resolve(encoder,true);assert(!shot->armed&&!task->execution_enabled&&!second->armed&&first.pending()&&device->pending.size()==1);
 auto next=bbl::arm_compute_one_shot(shot);assert(next!=first&&shot->generation==2&&shot->armed);
 auto stale=std::make_shared<bbl::pal::ComputeCommandEncoder>(device);oldRecord(stale);engine->gpu_task_timer_resolve(stale,true);assert(shot->armed&&device->pending.size()==1);
 device->finish();(void)co_await first;(void)co_await second->completion;assert(next.pending());
 encoder=std::make_shared<bbl::pal::ComputeCommandEncoder>(device);task->one_shot_recorded(encoder);engine->current_compute_encoder=encoder;engine->gpu_timer_resolve(encoder,true);engine->current_compute_encoder.reset();assert(!shot->armed&&device->pending.size()==1);
 auto failure=bbl::js::make_error("Error","GPU failure");device->finish(failure);bool rejected=false;try{(void)co_await next;}catch(const std::exception& error){rejected=std::string(error.what())=="GPU failure";}assert(rejected);
 auto pending=bbl::arm_compute_one_shot(shot);bbl::dispose_compute_one_shot(shot);assert(!task->one_shot_recorded&&!task->one_shot_dispose&&!task->execution_enabled);
 rejected=false;try{(void)co_await pending;}catch(const std::exception& error){rejected=std::string(error.what())=="ComputeOneShot was disposed before submission.";}assert(rejected);
 rejected=false;try{(void)co_await bbl::arm_compute_one_shot(shot);}catch(const std::exception& error){rejected=std::string(error.what())=="ComputeOneShot has been disposed.";}assert(rejected);
 bbl::dispose_compute_one_shot(shot);bbl::dispose_compute_one_shot(second);assert(!engine->gpu_task_timer_resolve&&!engine->gpu_timer_resolve&&!bbl::find_compute_one_shot_state(engine));
 auto dead=makeTask();dead->disposed=true;rejects([&]{(void)bbl::create_compute_one_shot(dead);},"#805");
 auto detached=makeTask();auto detachedShot=bbl::create_compute_one_shot(detached);detached->disposed=true;
 rejected=false;try{(void)co_await bbl::arm_compute_one_shot(detachedShot);}catch(const std::exception& error){rejected=std::string(error.what())=="ComputeTask \\"spectrum\\" has been disposed.";}assert(rejected);
 detached->one_shot_dispose();
 done=true;loop.close();co_return bbl::js::PromiseVoid{};
}
int main(){bbl::js::RealmScope realm;bbl::pal::EventLoop loop;bool done=false;loop.run([&]{checks(loop,done);});assert(done);}
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
        "/DBBLITE_OFFSCREEN_SURFACES=1",
        `/I${resolve("native/include")}`,
        cpp,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});

test("one-shot completion remains a real promise through typed source records", () => {
    const result = compileSource(
        `import {createComputeTask,createComputeOneShot,armComputeOneShot,disposeComputeOneShot,type ComputeOneShot} from '@babylonjs/lite';
import {createEngine} from '@babylonjs/lite';
async function main(){const canvas=document.createElement('canvas');const engine=await createEngine(canvas);const task=createComputeTask(engine);const shot:ComputeOneShot=createComputeOneShot(task);const state={shot};await state.shot.completion;await armComputeOneShot(state.shot);disposeComputeOneShot(state.shot);}void main();`,
        { fileName: "one-shot.ts" },
    );
    assert.ok(result.manifest.features.includes("compute:one-shot"));
    assert.match(result.cpp, /compute_one_shot_completion/);
});

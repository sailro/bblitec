import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerComputeTask } from "../src/lowering/compute-task-lowerer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("compute task methods retain aliases and can replace the source disposer", () => {
    const result = compileSource(`
import {createEngine,createComputeTask} from "@babylonjs/lite";
async function main() {
 const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
 const task=createComputeTask(engine,"owned");
 const alias=task;
 const dispose=task.dispose.bind(task);
 let calls=0;
 task.dispose=()=>{calls++;dispose();};
 task.executionEnabled=false;
 alias.dispose();
 if(calls!==1||task!==alias||!task._disposed||task.executionEnabled)throw new Error("task state");
}
void main();`);
    assert.ok(result.manifest.features.includes("compute:task"));
    assert.match(result.cpp, /bind_callback/);
    assert.match(result.cpp, /compute_task_dispose/);
});

test("source compute task disposal retains bound identity and releases unreachable cycles", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/compute-task-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        `${lowerComputeTask(new LoweringContext()).source}
#include <cassert>
int main(){
 const auto initial=bbl::js::managed_node_count();
 for(int iteration=0;iteration<20;++iteration){
  std::weak_ptr<bbl::ComputeTask> observed;
  {
   auto engine=std::make_shared<bbl::Engine>();
   auto task=bbl::create_compute_task(engine);
   observed=task;
   assert(task->name=="compute"&&task->execution_enabled&&!task->disposed&&task->engine==engine);
   auto original=task->dispose;
   auto bound=bbl::js::bind_callback(original,task);
   auto second=bbl::js::bind_callback(original,task);
   assert(bound!=original&&bound!=second);
   int calls=0;
   task->dispose=bbl::js::make_closure(std::tuple{bound,&calls},[](auto& captures){++*std::get<1>(captures);std::get<0>(captures)();});
   auto alias=task;
   task.reset();
   bbl::js::collect_cycles();assert(!observed.expired());
   alias->dispose();assert(calls==1&&alias->disposed);
   bound();assert(calls==1);
  }
  bbl::js::collect_cycles();assert(observed.expired());
  assert(bbl::js::managed_node_count()==initial);
 }
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
        `/I${resolve("native/include")}`,
        cpp,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});

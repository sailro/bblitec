import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { computeTaskLifecycleCpp } from "../src/lowering/compute-task-lifecycle.js";
import { computeTaskExecutionGateCpp } from "../src/lowering/compute-task-recording.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("compute task membership and cleanup retain identity, order and retry state", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/compute-task-lifecycle-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        `#include <bblite/js_data.hpp>
#include <cassert>
#include <functional>
namespace bbl {${computeTaskLifecycleCpp(new LoweringContext())}${computeTaskExecutionGateCpp(new LoweringContext())}}
struct Engine{int current_compute_encoder=31;};
struct Shader{std::shared_ptr<Engine> engine;};
struct Dispatch{bool enabled=true;std::shared_ptr<Shader> shader=std::make_shared<Shader>();};
struct Pass{std::function<void()> dispose;};
struct Task{
    bool disposed=false,execution_enabled=true;std::string name="test";std::shared_ptr<Engine> engine=std::make_shared<Engine>();
    bbl::js::Array<std::shared_ptr<Dispatch>> dispatches;
    bbl::js::Array<int> passes;
    std::shared_ptr<Pass> pass;
    std::shared_ptr<int> uniform_arenas;
    std::function<void()> one_shot_dispose,dispose_owned,flush_owned;
    std::function<void(int)> one_shot_recorded;
};
int main(){
    Task task;const auto first=std::make_shared<Dispatch>(),second=std::make_shared<Dispatch>();
    first->shader->engine=task.engine;second->shader->engine=task.engine;
    int recorded=0;
    task.one_shot_recorded=[&](int encoder){assert(encoder==31);++recorded;};
    task.execution_enabled=false;
    assert(!bbl::compute_task_execute_enabled(task)&&recorded==0);
    task.execution_enabled=true;
    assert(!bbl::compute_task_execute_enabled(task)&&recorded==1);
    bbl::add_compute_dispatch(task,first);bbl::add_compute_dispatch(task,first);bbl::add_compute_dispatch(task,second);
    assert(task.dispatches.size()==2&&task.dispatches[0]==first&&task.dispatches[1]==second);
    first->enabled=false;second->enabled=false;
    assert(!bbl::compute_task_execute_enabled(task)&&recorded==2);
    second->enabled=true;
    assert(bbl::compute_task_execute_enabled(task)&&recorded==2);
    bbl::remove_compute_dispatch(task,first);bbl::remove_compute_dispatch(task,first);
    assert(task.dispatches.size()==1&&task.dispatches[0]==second);
    auto foreign=std::make_shared<Dispatch>();foreign->shader->engine=std::make_shared<Engine>();
    bool failed=false;try{bbl::add_compute_dispatch(task,foreign);}catch(const std::exception& error){failed=std::string(error.what())=="#838";}assert(failed);
    std::vector<int> released;
    task.one_shot_dispose=[&]{released.push_back(1);};
    task.pass=std::make_shared<Pass>([&]{released.push_back(2);});task.passes.push_back(1);
    task.uniform_arenas=std::make_shared<int>(1);task.flush_owned=[]{};
    bool fail=true;
    task.dispose_owned=[&]{released.push_back(3);if(fail)throw std::runtime_error("owned");};
    failed=false;try{bbl::dispose_compute_task(task);}catch(const std::exception& error){failed=std::string(error.what())=="owned";}assert(failed);
    assert(!task.disposed&&!task.pass&&task.passes.empty()&&task.dispatches.empty()&&task.uniform_arenas&&task.dispose_owned);
    assert(released==std::vector<int>({1,2,3}));
    fail=false;bbl::dispose_compute_task(task);bbl::dispose_compute_task(task);
    assert(task.disposed&&!task.uniform_arenas&&!task.one_shot_dispose&&!task.flush_owned&&!task.dispose_owned&&!task.one_shot_recorded);
    assert(released==std::vector<int>({1,2,3,1,3}));
    failed=false;try{bbl::add_compute_dispatch(task,first);}catch(const std::exception& error){failed=std::string(error.what())=="#837";}assert(failed);
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

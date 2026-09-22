import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerGpuRetirement } from "../src/lowering/gpu-retirement-lowerer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("pinned retirement waits, claims each batch once, and drains nested releases", async (t) => {
    const context = new LoweringContext();
    const source = context.sourceFile(
        "src/engine/gpu-resource-retirement.ts",
    ).text;
    const errors: string[] = [];
    const oracle: unknown = await runInNewContext(
        ts.transpile(
            source +
                `
    (async()=>{
        const events:string[]=[];
        let rejectFence=false;
        const engine:any={_device:{queue:{onSubmittedWorkDone(){events.push("fence");return rejectFence?Promise.reject(new Error("lost")):Promise.resolve();}}}};
        retireGpuResources(engine,()=>{events.push("first");retireGpuResources(engine,()=>events.push("nested"));throw new Error("cleanup");});
        retireGpuResources(engine,()=>events.push("second"));
        const wait=waitForGpuResourceRetirements(engine);events.push("frame submitted");await wait;
        events.push("drained");
        rejectFence=true;retireGpuResources(engine,()=>events.push("lost release"));
        try{await waitForGpuResourceRetirements(engine);}catch{events.push("rejected");}
        disposeGpuResourceRetirements(engine);disposeGpuResourceRetirements(engine);
        await Promise.resolve();await Promise.resolve();
        rejectFence=false;retireGpuResources(engine,()=>events.push("claimed"));
        flushGpuResourceRetirements(engine);disposeGpuResourceRetirements(engine);
        await waitForGpuResourceRetirements(engine);
        return events.join(",");
    })();`,
            { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
        ),
        {
            exports: {},
            queueMicrotask,
            console: {
                error: (...args: unknown[]) => errors.push(String(args[0])),
            },
        },
    );
    assert.equal(errors.length, 1);
    const directory = resolve("artifacts/gpu-retirement-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        lowerGpuRetirement(context).source +
            `
#include <bblite/js_realm_state.hpp>
using namespace bbl;
static pal::GpuCompletion check(pal::EventLoop& loop, std::string& events) {
    auto add = [&events](const std::string& item) { if (!events.empty()) events += ","; events += item; };
    auto engine = std::make_shared<pal::GpuRetirementState>();
    bool reject_fence = false;
    engine->submitted_work_done = [&] {
        add("fence"); pal::GpuCompletion result;
        if (reject_fence) result.reject(std::make_exception_ptr(std::runtime_error("lost")));
        else result.resolve(js::PromiseVoid{});
        return result;
    };
    retire_gpu_resources(engine, [&, engine] {
        add("first"); retire_gpu_resources(engine, [&] { add("nested"); }); throw std::runtime_error("cleanup");
    });
    retire_gpu_resources(engine, [&] { add("second"); });
    auto wait = wait_for_gpu_resource_retirements(engine); add("frame submitted"); co_await wait;
    add("drained");
    reject_fence = true; retire_gpu_resources(engine, [&] { add("lost release"); });
    try { co_await wait_for_gpu_resource_retirements(engine); } catch (...) { add("rejected"); }
    dispose_gpu_resource_retirements(engine); dispose_gpu_resource_retirements(engine);
    co_await pal::GpuCompletion::resolved({}); co_await pal::GpuCompletion::resolved({});
    reject_fence = false; retire_gpu_resources(engine, [&] { add("claimed"); });
    flush_gpu_resource_retirements(engine); dispose_gpu_resource_retirements(engine);
    co_await wait_for_gpu_resource_retirements(engine);
    loop.close(); co_return js::PromiseVoid{};
}
int main() {
    const js::RealmScope realm;
    pal::EventLoop loop;
    std::string events;
    loop.run([&] { check(loop, events); });
    std::cout << events;
}
`,
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/DBBLITE_WORKERS=1",
        `/I${resolve("native/include")}`,
        cpp,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(
        execFileSync(exe, {
            encoding: "utf8",
            timeout: 10000,
            stdio: ["ignore", "pipe", "pipe"],
        }),
        oracle,
    );
});

test("GPU fences settle on the realm without blocking its tasks", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/gpu-completion-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp");
    const exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        `
#include <bblite/pal_async_engine.hpp>
#include <bblite/js_realm_state.hpp>
#include <cassert>
#include <condition_variable>
#include <thread>
struct Gate {
    std::mutex mutex;
    std::condition_variable_any wake;
    bool ready = false;
    bool fail = false;
    bool destroyed = false;
    void release() { {std::lock_guard lock(mutex); ready = true;} wake.notify_all(); }
};
struct Pending final : bbl::pal::OffscreenCompletion {
    std::shared_ptr<Gate> gate;
    std::jthread worker;
    Pending(std::shared_ptr<Gate> state, std::function<void(std::exception_ptr)> done)
        : gate(state), worker([state, done=std::move(done)](std::stop_token stop) {
            std::unique_lock lock(state->mutex);
            if (!state->wake.wait(lock, stop, [&] {return state->ready;})) return;
            lock.unlock();
            done(state->fail ? std::make_exception_ptr(std::runtime_error("lost")) : std::exception_ptr{});
        }) {}
    ~Pending() override {worker.request_stop(); worker.join(); gate->destroyed=true;}
};
struct Device final : bbl::pal::OffscreenDevice {
    std::shared_ptr<Gate> gate = std::make_shared<Gate>();
    std::thread::id owner = std::this_thread::get_id();
    int calls = 0;
    std::unique_ptr<bbl::pal::OffscreenCompletion>
    on_submitted_work_done(std::function<void(std::exception_ptr)> done) override {
        assert(std::this_thread::get_id()==owner); ++calls;
        return std::make_unique<Pending>(gate, std::move(done));
    }
};
int main() {
    const bbl::js::RealmScope realm;
    for (int mode=0;mode<3;++mode) {
        auto device=std::make_shared<Device>();
        device->gate->fail=mode==1;
        auto run=std::make_shared<bbl::pal::OffscreenRun>(std::make_shared<bbl::pal::OffscreenSurface>(1,1), device);
        bool task_ran=false, settled=false;
        {
            bbl::pal::EventLoop loop;
            loop.run([&] {
                auto pending=bbl::pal::submitted_gpu_work(run);
                assert(device->calls==1);
                pending.then([&](const bbl::js::PromiseVoid&) {
                    assert(std::this_thread::get_id()==device->owner && task_ran && mode==0);
                    settled=true; loop.close();
                }, [&](std::exception_ptr error) {
                    assert(std::this_thread::get_id()==device->owner && task_ran && mode==1);
                    assert(bbl::js::promise_error_message(error)=="lost");
                    settled=true; loop.close();
                });
                loop.post([&] {
                    task_ran=true;
                    if(mode==2) loop.close();
                    else device->gate->release();
                });
            });
        }
        assert(task_ran && settled==(mode!=2) && device->gate->destroyed);
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
        "/DBBLITE_OFFSCREEN_SURFACES=1",
        "/DBBLITE_WORKERS=1",
        `/I${resolve("native/include")}`,
        cpp,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});

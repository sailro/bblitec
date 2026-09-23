import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerGpuRetirement } from "../src/lowering/gpu-retirement-lowerer.js";
import { RenderTargetLowerer } from "../src/lowering/render-target-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

interface TextureDescriptor {
    size: { width: number; height: number };
    sampleCount: number;
}
interface MockEngine {
    canvas: { width: number; height: number };
    _device: {
        createTexture(desc: TextureDescriptor): {
            sampleCount: number;
            createView(): object;
            destroy(): void;
        };
        createSampler(): object;
        queue: { onSubmittedWorkDone(): Promise<void> };
    };
}
interface SurfaceTarget {
    texture: { width: number; height: number };
    rt: { _syncEager(engine: MockEngine): void };
}

test("surface resize observers match pinned retries, cancellation, reentry and retirement", async (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const pin = await importPinnedModule<{
        createSurfaceRenderTargetTexture(
            this: void,
            engine: MockEngine,
            desc: { format: string; samples: number; size: MockEngine },
        ): SurfaceTarget;
        onRenderTargetTextureResize(
            this: void,
            target: SurfaceTarget,
            callback: () => void,
        ): () => void;
    }>("texture/rtt-surface.js");
    const { disposeRenderTargetTexture } = await importPinnedModule<{
        disposeRenderTargetTexture(this: void, target: SurfaceTarget): void;
    }>("texture/rtt.js");
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
            createTexture(desc) {
                const id = ++serial;
                return {
                    sampleCount: desc.sampleCount,
                    createView: () => ({}),
                    destroy: () => events.push(`release${id}`),
                };
            },
            createSampler: () => ({}),
            queue: { onSubmittedWorkDone: () => Promise.resolve() },
        },
    };
    const target = pin.createSurfaceRenderTargetTexture(engine, {
        format: "rgba8unorm",
        samples: 1,
        size: engine,
    });
    let fail = true;
    pin.onRenderTargetTextureResize(target, () => events.push("a"));
    pin.onRenderTargetTextureResize(target, () => {
        events.push("b");
        if (fail) throw new Error("retry");
    });
    engine.canvas.width = 65;
    assert.throws(() => target.rt._syncEager(engine), /retry/);
    assert.equal(target.texture.width, 65);
    assert.deepEqual(events, ["a", "b"]);
    fail = false;
    target.rt._syncEager(engine);
    await waitForGpuResourceRetirements(engine);
    assert.deepEqual(events, ["a", "b", "b", "release1"]);
    const cancelC = pin.onRenderTargetTextureResize(target, () => {
        events.push("c");
        throw new Error("c");
    });
    const cancelD = pin.onRenderTargetTextureResize(target, () => {
        events.push("d");
        throw new Error("d");
    });
    engine.canvas.width = 66;
    assert.throws(
        () => target.rt._syncEager(engine),
        (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.equal(error.errors.length, 2);
            return true;
        },
    );
    cancelC();
    await Promise.resolve();
    assert.ok(!events.includes("release2"));
    cancelD();
    cancelD();
    await waitForGpuResourceRetirements(engine);
    let cancelSelf = () => {};
    cancelSelf = pin.onRenderTargetTextureResize(target, () => {
        events.push("r");
        engine.canvas.width++;
        assert.throws(() => target.rt._syncEager(engine));
        events.push("reentry refused");
        engine.canvas.width--;
        cancelSelf();
        pin.onRenderTargetTextureResize(target, () => events.push("late"));
    });
    engine.canvas.width = 67;
    target.rt._syncEager(engine);
    await waitForGpuResourceRetirements(engine);
    engine.canvas.width = 68;
    target.rt._syncEager(engine);
    await waitForGpuResourceRetirements(engine);
    fail = true;
    engine.canvas.width = 69;
    assert.throws(() => target.rt._syncEager(engine), /retry/);
    disposeRenderTargetTexture(target);
    await waitForGpuResourceRetirements(engine);
    assert.throws(() => pin.onRenderTargetTextureResize(target, () => {}));
    assert.throws(() => target.rt._syncEager(engine));

    const context = new LoweringContext();
    const directory = resolve("artifacts/render-target-lifecycle-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        lowerGpuRetirement(context).source +
            new RenderTargetLowerer(context, true).lower().source +
            `
#include <bblite/js_realm_state.hpp>
#include <cassert>
#include <iostream>
using namespace bbl;
static pal::GpuCompletion check(pal::EventLoop& loop, std::string& events) {
    auto add = [&events](const std::string& value) { if (!events.empty()) events += ","; events += value; };
    auto gpu = std::make_shared<pal::GpuRetirementState>();
    gpu->submitted_work_done = [] { return pal::GpuCompletion::resolved({}); };
    Engine engine; engine.gpu_retirements = gpu;
    const auto target = create_render_target_texture(engine, {}, true);
    const auto life = engine.render_targets[target.rt.value].lifecycle;
    bool fail = true;
    (void)on_render_target_texture_resize(engine, target, [&] { add("a"); });
    (void)on_render_target_texture_resize(engine, target, [&] { add("b"); if (fail) throw std::runtime_error("retry"); });
    int generation = 1;
    auto resize = [&] { life->prepare_resize(); const int old = generation++; life->replaced([&, old] { add("release" + std::to_string(old)); }); };
    bool failed = false;
    try { resize(); } catch (const std::runtime_error&) { failed = true; }
    assert(failed && events == "a,b");
    fail = false; life->synchronize(); co_await wait_for_gpu_resource_retirements(gpu);
    assert(events == "a,b,b,release1");
    const auto cancel_c = on_render_target_texture_resize(engine, target, [&] { add("c"); throw std::runtime_error("c"); });
    const auto cancel_d = on_render_target_texture_resize(engine, target, [&] { add("d"); throw std::runtime_error("d"); });
    failed = false;
    try { resize(); } catch (const js::AggregateError& error) { assert(error.errors.size() == 2); failed = true; }
    assert(failed);
    cancel_c(); co_await pal::GpuCompletion::resolved({}); assert(events.find("release2") == std::string::npos);
    cancel_d(); cancel_d(); co_await wait_for_gpu_resource_retirements(gpu);
    js::Callback<void()> cancel_self;
    cancel_self = on_render_target_texture_resize(engine, target, [&] {
        add("r"); bool refused = false;
        try { life->prepare_resize(); } catch (const std::runtime_error&) { refused = true; }
        assert(refused); add("reentry refused"); cancel_self();
        (void)on_render_target_texture_resize(engine, target, [&] { add("late"); });
    });
    resize(); co_await wait_for_gpu_resource_retirements(gpu);
    resize(); co_await wait_for_gpu_resource_retirements(gpu);
    fail = true; failed = false;
    try { resize(); } catch (const std::runtime_error&) { failed = true; }
    assert(failed);
    life->dispose([&] { add("release" + std::to_string(generation)); });
    co_await wait_for_gpu_resource_retirements(gpu);
    failed = false;
    try { (void)life->subscribe([] {}); } catch (const std::runtime_error&) { failed = true; }
    assert(failed); failed = false;
    try { life->prepare_resize(); } catch (const std::runtime_error&) { failed = true; }
    assert(failed);
    loop.close(); co_return js::PromiseVoid{};
}
int main() {const js::RealmScope realm; pal::EventLoop loop; std::string events; loop.run([&] {check(loop, events);}); std::cout << events;}
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
        cpp,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(
        execFileSync(exe, { encoding: "utf8", timeout: 10000 }),
        events.join(","),
    );
});

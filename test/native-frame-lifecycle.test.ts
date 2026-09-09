import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { cppFunction, cppRecord, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("native frame clocks, continuation drains and capture budgets preserve frame boundaries", t => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const directory = resolve("artifacts/test-native-frame-lifecycle");
    mkdirSync(directory, { recursive: true });
    const shared = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
    const pal = readFileSync("native/src/pal.cpp", "utf8");
    writeFileSync(join(directory, "frame-lifecycle.hpp"), [
        cppFunction(shared, "inline long benchmark_warmup_frames("),
        ...["struct FrameOptions {", "class FrameClock {", "class CaptureGate {"].map(signature => cppRecord(shared, signature)),
        cppFunction(shared, "inline void run_animation_frame_callbacks("),
        cppFunction(shared, "[[nodiscard]] inline double advance_frame(\n    Engine& engine,\n    FrameClock&"),
        cppFunction(shared, "[[nodiscard]] inline double advance_frame(\n    Engine& engine,\n    FrameGraphContext&"),
        cppFunction(shared, "inline void finish_frame("),
    ].join("\n"));
    writeFileSync(join(directory, "frame-continuations.hpp"), [
        "static void poll_start_continuation(Engine&, std::function<bool()>, std::function<void()>);",
        cppFunction(pal, "void defer_callback("),
        cppFunction(pal, "void defer_start_continuation("),
        cppFunction(pal, "static void queue_start_continuation_poll("),
        // Skip the forward declaration when selecting the implementation.
        cppFunction(pal.slice(pal.indexOf("static void queue_start_continuation_poll(")), "static void poll_start_continuation("),
        cppFunction(pal, "void defer_start_continuation_until("),
        cppFunction(pal, "void run_deferred_callbacks("),
    ].join("\n"));
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        "/I", "native/include", "/I", directory, `/Fo:${directory}/`, `/Fe:${executable}`,
        "test/fixtures/native-frame-lifecycle-check.cpp"]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});

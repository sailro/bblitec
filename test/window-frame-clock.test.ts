import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("Window compositor heartbeats survive absent frame statistics and coalesce busy consumers", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/window-frame-clock-check");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "clock-wait-loop.hpp"),
        cppFunction(
            readFileSync("native/src/pal_window_frame_clock.hpp", "utf8"),
            "void run() noexcept",
        ),
    );
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        `/I${resolve("native/src")}`,
        `/I${directory}`,
        `/Fo${directory}/`,
        `/Fe${executable}`,
        "test/fixtures/window-frame-clock-check.cpp",
    ]);
    const checked = spawnSync(executable, {
        timeout: 10000,
        windowsHide: true,
        encoding: "utf8",
    });
    assert.equal(checked.status, 0, checked.stderr || checked.error?.message);
    assert.equal(
        checked.stderr.trim(),
        "[window-clock] heartbeats=2 elapsed_ms=1000.000 hz=2.000 max_gap_ms=500.000 coalesced=2",
    );
});

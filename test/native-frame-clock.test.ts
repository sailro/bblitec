import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    cppRecord,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("Window scene clocks use supplied RAF time across delayed and coalesced frames", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/native-frame-clock-check");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "frame-clock.hpp"),
        cppRecord(
            readFileSync("native/src/pal_gpu_shared.hpp", "utf8"),
            "class FrameClock {",
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
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_OFFSCREEN_SURFACES=1",
        `/I${resolve("native/include")}`,
        `/I${directory}`,
        `/Fo${directory}/`,
        `/Fe${executable}`,
        "test/fixtures/native-frame-clock-check.cpp",
    ]);
    execFileSync(executable, {
        stdio: "pipe",
        timeout: 10000,
        windowsHide: true,
    });
});

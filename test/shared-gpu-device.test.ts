import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("shared GPU device preserves source views, texture layout, ownership and write failures", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/shared-gpu-device");
    mkdirSync(directory, { recursive: true });
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        `/I${resolve("native/include")}`,
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        resolve("test/fixtures/shared-gpu-device-check.cpp"),
    ]);
    execFileSync(executable, { stdio: "pipe" });
});

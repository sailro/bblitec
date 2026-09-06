import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("realm event loops run computation and ordered messages without rendering", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Requires the Windows native fixture compiler.");
        return;
    }
    const directory = resolve("artifacts/worker-event-loop-check");
    mkdirSync(directory, { recursive: true });
    const executable = resolve(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo", "/std:c++20", "/EHsc", "/W4", "/WX", "/MD",
        `/I${resolve("native/include")}`,
        resolve("test/fixtures/worker-event-loop-check.cpp"),
        `/Fo${directory}/`, `/Fe${executable}`,
    ]);
    execFileSync(executable, { stdio: "pipe", timeout: 15000 });
});

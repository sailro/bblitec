import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("structured worker messages preserve isolated graphs and exclusive transfer", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Requires the Windows native fixture compiler.");
        return;
    }
    const directory = resolve("artifacts/worker-clone-check");
    mkdirSync(directory, { recursive: true });
    const executable = resolve(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo", "/std:c++20", "/EHsc", "/W4", "/WX", "/MD",
        `/I${resolve("native/include")}`,
        resolve("test/fixtures/worker-clone-check.cpp"),
        `/Fo${directory}/`, `/Fe${executable}`,
    ]);
    execFileSync(executable, { stdio: "pipe", timeout: 15000 });
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

test("GPU record ownership cleans failed uploads and transfers exactly once", {
    skip: !tools,
}, () => {
    const output = resolve("artifacts/owned-gpu-record-check");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "owned-gpu-record-check.exe");
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/src",
        "test/fixtures/owned-gpu-record-check.cpp",
    ]);
    assert.match(execFileSync(executable, { encoding: "utf8" }), /owned-gpu-record-check: ok/);
});

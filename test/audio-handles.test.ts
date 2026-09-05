import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

test("audio handles reject exhaustion without aliasing a live node or context", {
    skip: !tools,
}, () => {
    const output = resolve("artifacts/audio-handles-check");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "audio-handles-check.exe");
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/src",
        "test/fixtures/audio-handles-check.cpp",
    ]);
    assert.match(execFileSync(executable, { encoding: "utf8" }), /audio-handles-check: ok/);
});

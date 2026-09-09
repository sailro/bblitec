import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("renderer phases preserve update timing and stop after unavailable surfaces or failed stages", t => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const directory = resolve("artifacts/test-frame-conductor");
    mkdirSync(directory, { recursive: true });
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/I", "native/src",
        `/Fo:${directory}/`, `/Fe:${executable}`, "test/fixtures/frame-conductor-check.cpp"]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("native runtime preserves vector conversions, scene identity, callback tracing and shared payloads", (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) { t.skip("A native compiler and fixture dependencies are required."); return; }
    const output = resolve("artifacts/test-runtime-value-contracts");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/EHsc", "/W4", "/WX",
        `/I${resolve("native/include")}`, `/I${join(nativeFixtureVcpkgRoot, "include")}`,
        resolve("test/fixtures/runtime-value-contracts-check.cpp"),
        `/Fe:${executable}`, `/Fo:${join(output, "check.obj")}`]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "runtime-value-contracts: ok\r\n");
});

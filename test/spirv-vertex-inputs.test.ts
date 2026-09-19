import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("SPIR-V vertex inputs compact independently of stage outputs and builtins", (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip("Native compiler is required.");
        return;
    }
    const output = resolve("artifacts/spirv-vertex-inputs");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/O2",
        `/Fo:${output}/`,
        `/Fe:${executable}`,
        "/I",
        "native/src",
        "test/fixtures/spirv-vertex-inputs-check.cpp",
    ]);
    assert.equal(
        execFileSync(executable, { encoding: "utf8", env: tools.environment }),
        "",
    );
});

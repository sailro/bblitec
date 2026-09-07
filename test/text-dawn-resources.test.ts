import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("Dawn text bindings retain their captured resources and retire before the device", (t) => {
    const tools = optionalNativeFixtureTools(false);
    const dawnInclude = resolve("artifacts/tools/dawn/include");
    if (!tools || !existsSync(join(dawnInclude, "webgpu/webgpu.h"))) {
        t.skip("A native fixture compiler and the pinned Dawn headers are required.");
        return;
    }
    const output = resolve("artifacts/test-text-dawn-resources");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/EHsc", "/W4", "/WX",
        `/I${resolve("native/include")}`, `/I${resolve("native/src")}`, `/I${dawnInclude}`,
        resolve("test/fixtures/text-dawn-resources-check.cpp"), `/Fe:${executable}`, `/Fo:${join(output, "check.obj")}`]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("SDL material and geometry owners unwind partial uploads and cache publication", (t) => {
    const tools = optionalNativeFixtureTools(false);
    const sdlInclude = resolve("artifacts/tools/sdl-min/include");
    if (!tools || !existsSync(join(sdlInclude, "SDL3/SDL_gpu.h"))) {
        t.skip("A native fixture compiler and the pinned SDL headers are required.");
        return;
    }
    const output = resolve("artifacts/test-sdl-ownership");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/EHsc", "/W4", "/WX",
        `/I${resolve("native/src")}`, `/I${sdlInclude}`,
        resolve("test/fixtures/sdl-ownership-check.cpp"), `/Fe:${executable}`, `/Fo:${join(output, "check.obj")}`]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});

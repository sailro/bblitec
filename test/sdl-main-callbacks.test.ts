import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("SDL callbacks drive suspended frames, retain event data and retire owners before shutdown", (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip("Native compiler and SDL headers required.");
        return;
    }
    const output = resolve("artifacts/sdl-main-callbacks");
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
        `/I${resolve("native/src")}`,
        `/I${resolve("native/include")}`,
        `/I${join(nativeFixtureVcpkgRoot, "include")}`,
        "test/fixtures/sdl-main-callbacks-check.cpp",
    ]);
    assert.equal(
        execFileSync(executable, {
            encoding: "utf8",
            windowsHide: true,
            env: tools.environment,
        }),
        "",
    );
});

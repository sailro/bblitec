import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("the CSS length parser converts decimals exactly as MSVC's std::from_chars, without it", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/ui-length-math-check");
    mkdirSync(directory, { recursive: true });
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        `/I${resolve("native/src")}`,
        `/Fo${directory}/`,
        `/Fe${executable}`,
        "test/fixtures/ui-length-math-check.cpp",
    ]);
    const checked = spawnSync(executable, {
        timeout: 60000,
        windowsHide: true,
        encoding: "utf8",
    });
    assert.equal(checked.status, 0, checked.stderr || checked.error?.message);
    assert.match(checked.stdout, /^\d{6} decimals identical/);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("native threads join, cancel, and transfer ownership through moves", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/joining-thread-check");
    mkdirSync(directory, { recursive: true });
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        `/Fo${directory}/`,
        `/Fe${executable}`,
        "test/fixtures/joining-thread-check.cpp",
    ]);
    assert.equal(
        execFileSync(executable, { encoding: "utf8", timeout: 10000 }),
        "",
    );
});

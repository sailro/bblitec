import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("realm event loops run computation and ordered messages without rendering", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Requires the Windows native fixture compiler.");
        return;
    }
    const directory = resolve("artifacts/worker-event-loop-check");
    mkdirSync(directory, { recursive: true });
    const executable = resolve(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        resolve("test/fixtures/worker-event-loop-check.cpp"),
        `/Fo${directory}/`,
        `/Fe${executable}`,
    ]);
    execFileSync(executable, { stdio: "pipe", timeout: 15000 });
    // A worker that would wait on native work it owns ends the process.
    const refused = spawnSync(executable, ["owner-on-worker"], {
        encoding: "utf8",
        timeout: 15000,
    });
    assert.equal(refused.status, 0, refused.stderr);
    assert.match(refused.stdout, /native work owner refused on a worker/);
    assert.match(
        refused.stderr,
        /NativeWork owner: Native work cannot wait on other native work\./,
    );
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const nativeTools = optionalNativeFixtureTools();
test("native dispatch snapshots share storage and preserve mutation boundaries", { skip: !nativeTools }, () => {
    const output = resolve("artifacts/snapshot-list-check");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "snapshot-list-check.exe");
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include",
        "test/fixtures/js-callback/snapshot-list-check.cpp",
    ]);
    assert.match(execFileSync(executable, [], { encoding: "utf8" }), /snapshot-list-check: ok/);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const nativeTools = optionalNativeFixtureTools(false);
test(
    "UI GPU texture caches follow source and recorded-frame lifetime through hidden frames",
    { skip: !nativeTools },
    () => {
        const output = resolve("artifacts/ui-texture-cache-check");
        mkdirSync(output, { recursive: true });
        const executable = join(output, "ui-texture-cache-check.exe");
        runNativeFixtureCompiler(nativeTools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/permissive-",
            "/EHsc",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/src",
            "test/fixtures/ui-texture-cache-check.cpp",
        ]);
        assert.match(
            execFileSync(executable, [], { encoding: "utf8" }),
            /ui-texture-cache-check: ok/,
        );
    },
);

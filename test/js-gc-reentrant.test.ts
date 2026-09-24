import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);

for (const [name, fixture, expected] of [
    [
        "GC publishes complete owners and unlinks payloads before reentrant destruction",
        "js-gc-reentrant-check",
        "gc-reentrant-lifetime: ok",
    ],
    [
        "GC reclaims realm storage before late static owner destruction",
        "js-gc-shutdown-check",
        "gc-shutdown-lifetime: ok",
    ],
    [
        "GC preserves exact ownership and unwinds failed registry growth",
        "ref-gc-ownership-check",
        "ref-gc-ownership-check: ok (Ref=1 allocation, weak token=1, shared=1; untraced payloads unregistered; cycle edges=2/2, collected=2; registry and allocations restored)",
    ],
] as const)
    test(name, (t) => {
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        const directory = resolve("artifacts", fixture);
        mkdirSync(directory, { recursive: true });
        const executable = join(directory, "check.exe");
        runNativeFixtureCompiler(tools, [
            "/nologo",
            "/std:c++20",
            "/EHsc",
            "/MD",
            "/W4",
            "/WX",
            "/permissive-",
            "/I",
            resolve("native", "include"),
            `/Fo${directory}\\`,
            `/Fe${executable}`,
            resolve("test", "fixtures", `${fixture}.cpp`),
        ]);
        assert.equal(
            execFileSync(executable, {
                encoding: "utf8",
                windowsHide: true,
                timeout: 10000,
            }).trim(),
            expected,
        );
    });

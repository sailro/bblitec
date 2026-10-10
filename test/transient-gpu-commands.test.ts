import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

test(
    "SDL command ownership consumes once and ends passes before failure cleanup",
    { skip: !tools },
    () => {
        const output = resolve("artifacts/transient-gpu-commands-check");
        mkdirSync(output, { recursive: true });
        const executable = join(output, "check.exe");
        runNativeFixtureCompiler(tools!, [
            "/DSDL_STATIC_LIB",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/src",
            `/I${output}`,
            "test/fixtures/transient-gpu-commands-check.cpp",
        ]);
        assert.equal(
            execFileSync(executable, { encoding: "utf8" }).trim(),
            "transient-gpu-commands-check: ok",
        );
    },
);

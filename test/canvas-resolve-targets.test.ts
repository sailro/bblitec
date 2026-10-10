import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const native = optionalNativeFixtureTools();

test(
    "canvas resolve allocation follows default pass handles and retains other targets and platforms",
    { skip: !native },
    () => {
        const directory = resolve("artifacts/canvas-resolve-targets");
        mkdirSync(directory, { recursive: true });
        const executable = resolve(directory, "check.exe");
        runNativeFixtureCompiler(native!, [
            "/Inative/src",
            "test/fixtures/canvas-resolve-targets-check.cpp",
            `/Fo:${directory}/`,
            `/Fe:${executable}`,
        ]);
        assert.equal(
            execFileSync(executable, { encoding: "utf8", windowsHide: true }),
            "",
        );
    },
);

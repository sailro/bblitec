import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const nativeTools = optionalNativeFixtureTools();
test("device owners release partial construction once and preserve borrowed devices and windows", { skip: !nativeTools }, () => {
    const output = resolve("artifacts/device-owner-check");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "device-owner-check.exe");
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", "/I", "native/src",
        "/I", "artifacts/tools/dawn/include", "/I", join(nativeFixtureVcpkgRoot, "include"),
        "test/fixtures/js-callback/device-owner-check.cpp", join(nativeFixtureVcpkgRoot, "lib/SDL3.lib"),
    ]);
    assert.match(execFileSync(executable, [], {
        encoding: "utf8",
        env: { ...process.env, SDL_VIDEODRIVER: "dummy", PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${process.env.PATH ?? ""}` },
    }), /device-owner-check: ok/);
});

test("window identity and geometry survive rebuilds; final exit and exceptions clean up", { skip: !nativeTools }, () => {
    const output = resolve("artifacts/window-run-check");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "window-run-check.exe");
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", "/I", "native/src",
        "/I", join(nativeFixtureVcpkgRoot, "include"),
        "test/fixtures/js-callback/window-run-check.cpp", join(nativeFixtureVcpkgRoot, "lib/SDL3.lib"),
    ]);
    assert.match(execFileSync(executable, [], {
        encoding: "utf8",
        // No OS window or GPU work is needed for this lifetime unit test.
        env: { ...process.env, SDL_VIDEODRIVER: "dummy", PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${process.env.PATH ?? ""}` },
    }), /window-run-check: ok/);
});

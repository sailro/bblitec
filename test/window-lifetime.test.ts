import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("all backend window lifetimes use the engine-run owner", () => {
    for (const stem of ["pal_sdl_gpu", "pal_dawn"]) {
        for (const suffix of ["", "_sprite", "_effect", "_frame_graph"]) {
            const file = `native/src/${stem}${suffix}.cpp`;
            const text = readFileSync(file, "utf8");
            assert.doesNotMatch(text, /SDL_DestroyWindow\(|SDL_Quit\(/, file);
            assert.match(text, /release_run_window\(/, file);
        }
    }
    const dispatch = readFileSync("native/src/pal_sdl.cpp", "utf8");
    assert.match(dispatch, /SdlWindowRun window_run;[\s\S]*?for \(;;\)/);
});

const nativeTools = optionalNativeFixtureTools();
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

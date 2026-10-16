import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
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

test("SDL command buffers are submitted only through SdlGpuCommand", () => {
    // Its submissions are the ones that submit a thread's staged writes first.
    const owner = join("native", "src", "pal_sdl_gpu_commands.hpp");
    const submitters = ["native/src", "native/include"].flatMap((root) =>
        readdirSync(root, { recursive: true, encoding: "utf8" })
            .map((path) => join(root, path))
            .filter(
                (path) =>
                    /\.(?:cpp|hpp|mm)$/.test(path) &&
                    path !== owner &&
                    /\bSDL_SubmitGPUCommandBuffer\w*\s*\(/.test(
                        readFileSync(path, "utf8"),
                    ),
            ),
    );
    assert.deepEqual(submitters, []);
});

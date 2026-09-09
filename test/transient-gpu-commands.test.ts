import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { cppFunction, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

test("SDL command ownership consumes once and ends passes before failure cleanup", { skip: !tools }, () => {
    const output = resolve("artifacts/transient-gpu-commands-check");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "upload-buffer.hpp"), cppFunction(
        readFileSync("native/src/pal_sdl_gpu_shared.hpp", "utf8"), "inline SDL_GPUBuffer* upload_buffer(",
    ));
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/DSDL_STATIC_LIB",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/src",
        `/I${output}`,
        `/external:I${join(nativeFixtureVcpkgRoot, "include")}`, "/external:W0",
        "test/fixtures/transient-gpu-commands-check.cpp",
    ]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }).trim(), "transient-gpu-commands-check: ok");
});

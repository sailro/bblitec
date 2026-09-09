import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { cppFunction, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("every native driver routes DOM input, replay, UI consumption and window events", t => {
    const tools = optionalNativeFixtureTools();
    if (!tools) { t.skip("Native compiler and SDL are required."); return; }
    const output = resolve("artifacts/platform-input-contracts");
    mkdirSync(output, { recursive: true });
    const drivers = ["sdl_gpu", "dawn", "sdl_gpu_sprite", "dawn_sprite", "sdl_gpu_effect", "dawn_effect",
        "sdl_gpu_frame_graph", "dawn_frame_graph"];
    writeFileSync(join(output, "drivers.hpp"), drivers.map((name, index) =>
        `struct Driver${index} : ${index < 2 ? "SceneInputDriver" : "InputDriver"} { using ${index < 2 ? "SceneInputDriver" : "InputDriver"}::${index < 2 ? "SceneInputDriver" : "InputDriver"};\n` +
        cppFunction(readFileSync(`native/src/pal_${name}.cpp`, "utf8"), "FramePreparation prepare(") + "\n};").join("\n"));
    writeFileSync(join(output, "exercise.hpp"), drivers.map((_, index) => `exercise<Driver${index}>(${index});`).join("\n"));
    for (const ui of [0, 1]) {
        const executable = join(output, `check-${ui}.exe`);
        runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2",
            `/DBBLITE_HAS_UI=${ui}`, `/Fo:${output}/`, `/Fe:${executable}`, "/I", "native/include", "/I", "native/src", "/I", output,
            `/external:I${join(nativeFixtureVcpkgRoot, "include")}`, "/external:W0",
            "test/fixtures/platform-input-contracts-check.cpp", join(nativeFixtureVcpkgRoot, "lib/SDL3.lib")]);
        assert.equal(execFileSync(executable, { encoding: "utf8",
            env: { ...tools.environment, PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools.environment.PATH ?? ""}` },
        }), "");
    }
});

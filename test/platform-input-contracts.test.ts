import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    cppFunction,
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("every native driver routes DOM input, replay, UI consumption and window events", (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip("Native compiler and SDL are required.");
        return;
    }
    const output = resolve("artifacts/platform-input-contracts");
    mkdirSync(output, { recursive: true });
    const drivers = [
        "sdl_gpu",
        "dawn",
        "sdl_gpu_sprite",
        "dawn_sprite",
        "sdl_gpu_effect",
        "dawn_effect",
        "sdl_gpu_frame_graph",
        "dawn_frame_graph",
    ];
    // The standalone hosts share RendererRun's prepare phase and supply
    // only their window, event and surface hooks.
    const session = readFileSync("native/src/pal_frame_session.hpp", "utf8");
    writeFileSync(
        join(output, "renderer-run.hpp"),
        ["void poll_events()", "FramePreparation prepare_surface()"]
            .map((signature) => cppFunction(session, signature))
            .join("\n"),
    );
    const hooks = [
        "SDL_Window* sdl_window() const",
        "void poll_events()",
        "FramePreparation prepare_surface()",
    ];
    writeFileSync(
        join(output, "drivers.hpp"),
        drivers
            .map((name, index) => {
                const source = readFileSync(
                    `native/src/pal_${name}.cpp`,
                    "utf8",
                );
                if (index < 2)
                    return (
                        `struct Driver${index} : SceneInputDriver { using SceneInputDriver::SceneInputDriver;\n` +
                        cppFunction(source, "FramePreparation prepare(") +
                        "\n};"
                    );
                return (
                    `struct Driver${index} : InputDriver { using InputDriver::InputDriver; using RendererRun = InputDriver;\n` +
                    `Driver${index}& derived() { return *this; }\n` +
                    hooks
                        .filter((hook) => source.includes(hook))
                        .map((hook) => cppFunction(source, hook))
                        .join("\n") +
                    "\n" +
                    cppFunction(session, "FramePreparation prepare(") +
                    "\n};"
                );
            })
            .join("\n"),
    );
    writeFileSync(
        join(output, "exercise.hpp"),
        drivers
            .map((_, index) => `exercise<Driver${index}>(${index});`)
            .join("\n"),
    );
    for (const ui of [0, 1]) {
        const executable = join(output, `check-${ui}.exe`);
        runNativeFixtureCompiler(tools, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            "/MD",
            "/O2",
            `/DBBLITE_HAS_UI=${ui}`,
            `/Fo:${output}/`,
            `/Fe:${executable}`,
            "/I",
            "native/include",
            "/I",
            "native/src",
            "/I",
            output,
            `/external:I${join(nativeFixtureVcpkgRoot, "include")}`,
            "/external:W0",
            "test/fixtures/platform-input-contracts-check.cpp",
            join(nativeFixtureVcpkgRoot, "lib/SDL3.lib"),
        ]);
        assert.equal(
            execFileSync(executable, {
                encoding: "utf8",
                env: {
                    ...tools.environment,
                    PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools.environment.PATH ?? ""}`,
                },
            }),
            "",
        );
    }
});

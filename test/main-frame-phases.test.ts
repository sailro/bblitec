import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    cppFunction,
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    sceneBackendSource,
    sharedGpuSource,
} from "./native-fixture.js";

test("main renderers acquire surfaces, restart changed scenes and grow task resources", (t) => {
    const tools = optionalNativeFixtureTools();
    const dawnInclude = resolve("artifacts/tools/dawn/include");
    if (!tools || !existsSync(join(dawnInclude, "webgpu/webgpu.h"))) {
        t.skip(
            "A native fixture compiler and the pinned GPU headers are required.",
        );
        return;
    }
    const directory = resolve("artifacts/test-main-frame-phases");
    mkdirSync(directory, { recursive: true });
    const shared = sharedGpuSource();
    writeFileSync(
        join(directory, "scene-restart.hpp"),
        [
            "bool registered_scene_set_changed(",
            "bool request_renderer_restart_if_scene_set_changed(",
        ]
            .map((signature) => cppFunction(shared, signature))
            .join("\n"),
    );
    writeFileSync(
        join(directory, "dawn-acquire.hpp"),
        cppFunction(
            readFileSync("native/src/pal_dawn_shared.hpp", "utf8"),
            "inline bool acquire_dawn_surface_texture",
        ).replace("DawnDevice& state", "DawnState& state"),
    );
    for (const [backend, name] of [
        ["Sdl", "sdl"],
        ["Dawn", "dawn"],
    ] as const) {
        const source = sceneBackendSource(name);
        writeFileSync(
            join(directory, `${backend}Scene.hpp`),
            [
                "Frame& current_frame()",
                "void rebuild_task_draw_lists()",
                "bool acquire()",
                "FramePreparation update()",
            ]
                .map((signature) => cppFunction(source, signature))
                .join("\n"),
        );
    }
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/DBBLITE_HAS_UI=0",
        "/DBBLITE_DEVICE_RECOVERY=0",
        "/DBBLITE_OFFSCREEN_SURFACES=1",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/DSDL_STATIC_LIB",
        "/I",
        "native/include",
        "/I",
        "native/src",
        "/I",
        directory,
        "/I",
        dawnInclude,
        `/external:I${join(nativeFixtureVcpkgRoot, "include")}`,
        "/external:W0",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        "test/fixtures/main-frame-phases-check.cpp",
    ]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});

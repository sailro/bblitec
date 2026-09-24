import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    cppFunction,
    cppRecord,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    sharedGpuSource,
} from "./native-fixture.js";

const shared = (): string => sharedGpuSource();

test("a geometry task's Standard renderables keep the pin's previous world and start velocity disabled", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("A native fixture compiler is required.");
        return;
    }
    const output = resolve("artifacts/pinned-velocity-history");
    mkdirSync(output, { recursive: true });
    const source = shared();
    writeFileSync(
        join(output, "velocity.hpp"),
        [
            cppRecord(source, "struct PinnedVelocityHistory {"),
            cppFunction(source, "void begin_pinned_velocity_frame("),
            cppFunction(
                source,
                "const PinnedVelocityHistory::Renderable& update_pinned_velocity(",
            ),
            cppFunction(source, "void write_pinned_velocity_tail("),
        ].join("\n\n"),
    );
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/O2",
        `/Fo:${output}/`,
        `/Fe:${executable}`,
        "/I",
        output,
        "test/fixtures/pinned-velocity-history-check.cpp",
    ]);
    assert.match(
        execFileSync(executable, { encoding: "utf8" }),
        /pinned-velocity-history-check: ok/,
    );
});

test("only the geometry task's Standard draws write the velocity tail", () => {
    const source = shared();
    // The colour passes' block carries the world and the light selection
    // alone; the tail is the task's renderable state.
    const block = cppFunction(
        source,
        "upstream::MeshUniforms pinned_mesh_block(",
    );
    assert.doesNotMatch(block, /previousWorld|velocityEnabled/);
    const sdl = readFileSync("native/src/pal_sdl_gpu.cpp", "utf8");
    const dawn = readFileSync("native/src/pal_dawn.cpp", "utf8");
    for (const [backend, text] of [
        ["SDL", sdl],
        ["Dawn", dawn],
    ] as const) {
        assert.equal(
            text.match(/update_pinned_velocity_frame\(/g)?.length,
            1,
            `${backend} updates each geometry task's renderables once a frame`,
        );
        assert.equal(
            text.match(/write_pinned_velocity_tail\(/g)?.length,
            1,
            `${backend} writes the tail at one Standard draw site`,
        );
    }
    assert.match(
        sdl,
        /geometry\.params, &geometry\.velocity\);/,
        "the SDL geometry task hands its history to its draws",
    );
    assert.match(
        dawn,
        /colour_state\.uv_transform_uniforms, &geometry\.velocity\);/,
        "the Dawn geometry task hands its history to its draws",
    );
});

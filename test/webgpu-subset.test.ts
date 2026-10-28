import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import { SPLAT_STREAM_SHADER_MODULES } from "../src/lowering/splat-stream-library.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { optionalNativeFixtureTools } from "./native-fixture.js";
import {
    compileLibraryShaders,
    runWebGpuFixture,
} from "./webgpu-subset-fixture.js";

/**
 * The lowered splat-stream library (upstream_splat_stream.hpp) and the
 * generated headers it includes, emitted once for both backends' fixtures.
 */
let generatedInclude: string | undefined;
function streamLibraryInclude(): string {
    if (generatedInclude) return generatedInclude;
    const output = resolve("artifacts/test-webgpu-subset/generated");
    rmSync(output, { recursive: true, force: true });
    emitUpstreamGenerated(output, [
        "core",
        "renderer:scene",
        "camera:view-projection",
        "renderer:external-renderables",
        "engine:webgpu-device",
        "loader:splat-stream",
    ]);
    generatedInclude = join(output, "upstream/include");
    return generatedInclude;
}

let dawnResult: Map<string, string> | undefined;
function runDawnStream(): Map<string, string> | undefined {
    dawnResult ??= runWebGpuFixture("dawn", {
        output: resolve("artifacts/test-webgpu-subset/dawn"),
        sources: [resolve("test/fixtures/webgpu-subset/dawn-check.cpp")],
        includes: [streamLibraryInclude()],
    });
    return dawnResult;
}

let sdlResult: Map<string, string> | undefined;
async function runSdlStream(): Promise<Map<string, string> | undefined> {
    if (sdlResult) return sdlResult;
    const shaderTools = discoverDevelopmentTools();
    if (
        !optionalNativeFixtureTools() ||
        !shaderTools.bbliteTint ||
        !shaderTools.dxc
    )
        return undefined;
    const output = resolve("artifacts/test-webgpu-subset/sdl");
    sdlResult = runWebGpuFixture("sdl", {
        output,
        sources: [resolve("test/fixtures/webgpu-subset/sdl-check.cpp")],
        includes: [streamLibraryInclude()],
        shaders: await compileLibraryShaders(
            join(output, "root"),
            SPLAT_STREAM_SHADER_MODULES,
        ),
    });
    return sdlResult;
}

/**
 * The checks each backend's fixture ran through the lowered library, against
 * CPU evaluations of the pinned WGSL.
 */
function assertStreamChecks(lines: Map<string, string>, backend: string): void {
    assert.equal(lines.get(backend), "ok");
    assert.equal(lines.get("mapping"), "ok");
    assert.equal(lines.get("limits"), "268435456 256640000 65535");
    assert.match(
        lines.get("sort") ?? "",
        /^capacity=70000 count=69123 visible=\d+ levels=2 /,
    );
    assert.match(lines.get("projection") ?? "", /^visible=36 /);
    // The library's renderable drawn through the scene pass protocol, twice.
    assert.match(lines.get("render") ?? "", /^covered=\d+ covered4=\d+$/);
}

test("Dawn runs the lowered splat-stream library's GPU work through the WebGPU subset device", (t) => {
    const lines = runDawnStream();
    if (!lines) {
        t.skip(
            "A native fixture compiler and the pinned Dawn build are required.",
        );
        return;
    }
    assertStreamChecks(lines, "dawn");
});

test("SDL_GPU runs the lowered splat-stream library's GPU work through the WebGPU subset device", async (t) => {
    const lines = await runSdlStream();
    if (!lines) {
        t.skip(
            "A native fixture compiler, SDL, bblite-tint and DXC are required.",
        );
        return;
    }
    assertStreamChecks(lines, "sdl");
});

/** Words of a float result line, as numbers. */
function floats(line: string | undefined): number[] {
    const words = (line ?? "").match(/[0-9a-f]{8}/g) ?? [];
    const view = new DataView(new ArrayBuffer(4));
    return words.map((word) => {
        view.setUint32(0, Number.parseInt(word, 16));
        return view.getFloat32(0);
    });
}

test("Dawn and SDL_GPU agree: integer results exactly, float results within 1e-5", async (t) => {
    const dawn = runDawnStream();
    const sdl = await runSdlStream();
    if (!dawn || !sdl) {
        t.skip("Both backends' fixtures are required.");
        return;
    }
    // The projection line's sort order is integer; its measured float error is not.
    const integers = (line: string | undefined): string =>
        (line ?? "").replace(/ worst=.*$/, "");
    for (const key of ["limits", "sort", "projection"])
        assert.equal(integers(sdl.get(key)), integers(dawn.get(key)), key);
    for (const key of ["projected", "canonical"]) {
        const left = floats(dawn.get(key)),
            right = floats(sdl.get(key));
        assert.equal(left.length, right.length, key);
        left.forEach((value, index) => {
            const scale = Math.max(Math.abs(value), 1);
            assert.ok(
                Math.abs(value - right[index]!) <= 1e-5 * scale,
                `${key}[${index}]: ${value} vs ${right[index]}`,
            );
        });
    }
    const channels = (line: string | undefined): number[] =>
        Array.from(Buffer.from(line ?? "", "hex"));
    // The splats drawn through the scene pass protocol, single- and four-sampled.
    for (const key of ["image", "image4"]) {
        const left = channels(dawn.get(key)),
            right = channels(sdl.get(key));
        assert.equal(left.length, 96 * 64 * 4, key);
        assert.equal(right.length, left.length, key);
        left.forEach((value, index) =>
            assert.ok(
                Math.abs(value - right[index]!) <= 1,
                `${key} byte ${index}: ${value} vs ${right[index]}`,
            ),
        );
    }
    assert.equal(sdl.get("render"), dawn.get("render"));
});

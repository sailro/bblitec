import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { compileOfflineShaders } from "../src/compile-shaders.js";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import { sharedPinnedContext } from "../src/lowering/context.js";
import {
    pinnedRawShaderImports,
    runtimeWgslModules,
    SPLAT_STREAM_SHADER_MODULES,
} from "../src/lowering/splat-stream-shaders.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

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

/**
 * The library's run-time WGSL as SDL_GPU deploys it (`runtimeWgslModules`):
 * each module's every stage, compiled under the name its text and entry
 * point give it (`wgslStageStem`).
 */
async function compileStreamShaders(root: string): Promise<string> {
    const directory = join(root, "generated/stream/upstream/shaders");
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    mkdirSync(join(root, "upstream"), { recursive: true });
    copyFileSync("upstream/tint.json", join(root, "upstream/tint.json"));
    const modules = runtimeWgslModules(
        pinnedRawShaderImports(
            sharedPinnedContext(),
            SPLAT_STREAM_SHADER_MODULES,
        ),
    ).map(({ output, data, entryPoint, alsoStages }) => {
        writeFileSync(join(directory, basename(output)), data);
        return {
            output: basename(output),
            entryPoint,
            pinnedBindings: true,
            alsoStages,
        };
    });
    writeFileSync(
        join(directory, "composition.json"),
        JSON.stringify({ modules }),
    );
    await compileOfflineShaders({
        directories: [directory],
        repositoryRoot: root,
        target: "d3d12",
        tools: discoverDevelopmentTools(),
    });
    return directory;
}

const dawnRoot = resolve("artifacts/tools/dawn");

/** The fixture's result lines, keyed by their first word. */
function resultLines(output: string): Map<string, string> {
    const lines = new Map<string, string>();
    for (const line of output.split(/\r?\n/)) {
        const space = line.indexOf(" ");
        if (space > 0) lines.set(line.slice(0, space), line.slice(space + 1));
    }
    return lines;
}

let dawnResult: Map<string, string> | undefined;
function runDawnStream(): Map<string, string> | undefined {
    if (dawnResult) return dawnResult;
    const tools = optionalNativeFixtureTools(false);
    if (!tools || !existsSync(join(dawnRoot, "lib/webgpu_dawn.lib")))
        return undefined;
    const output = resolve("artifacts/test-webgpu-subset/dawn");
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, [
        `/I${resolve("native/src")}`,
        `/I${resolve("test/fixtures/webgpu-subset")}`,
        `/I${streamLibraryInclude()}`,
        `/external:I${join(dawnRoot, "include")}`,
        `/Fo:${output}/`,
        `/Fe:${executable}`,
        resolve("test/fixtures/webgpu-subset/dawn-check.cpp"),
        "/link",
        join(dawnRoot, "lib/webgpu_dawn.lib"),
    ]);
    dawnResult = resultLines(
        execFileSync(executable, {
            encoding: "utf8",
            timeout: 120000,
            windowsHide: true,
            env: {
                ...process.env,
                PATH: `${join(dawnRoot, "bin")};${process.env.PATH ?? ""}`,
            },
        }),
    );
    return dawnResult;
}

let sdlResult: Map<string, string> | undefined;
async function runSdlStream(): Promise<Map<string, string> | undefined> {
    if (sdlResult) return sdlResult;
    const tools = optionalNativeFixtureTools();
    const shaderTools = discoverDevelopmentTools();
    if (!tools || !shaderTools.bbliteTint || !shaderTools.dxc) return undefined;
    const output = resolve("artifacts/test-webgpu-subset/sdl");
    const shaders = await compileStreamShaders(join(output, "root"));
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/DBBLITE_VISUAL_CAPTURE=0",
        `/I${resolve("native/src")}`,
        `/I${resolve("test/fixtures/webgpu-subset")}`,
        `/I${streamLibraryInclude()}`,
        `/Fo:${output}/`,
        `/Fe:${executable}`,
        resolve("test/fixtures/webgpu-subset/sdl-check.cpp"),
        "/link",
        `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
        "SDL3.lib",
    ]);
    sdlResult = resultLines(
        execFileSync(executable, {
            encoding: "utf8",
            timeout: 120000,
            windowsHide: true,
            env: {
                ...process.env,
                BBLITE_GPU_SHADER_DIR: shaders,
                PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${process.env.PATH ?? ""}`,
            },
        }),
    );
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

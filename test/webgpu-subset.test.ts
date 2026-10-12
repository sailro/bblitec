import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { readPinnedRawShader } from "../src/pinned-shader-composer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

/** The pinned splat-stream WGSL, by module, as the packaged chunks ship it. */
const streamShaders = [
    ["compact", "loader-splat-stream/splat-stream-gpu.js"],
    ["gather", "loader-splat-stream/splat-stream-gpu.js"],
    ["project", "loader-splat-stream/splat-stream-gpu.js"],
    ["radix", "loader-splat-stream/splat-stream-gpu.js"],
    ["render", "loader-splat-stream/splat-stream-material.js"],
] as const;

function writeStreamShaders(directory: string): Map<string, string> {
    mkdirSync(directory, { recursive: true });
    const sources = new Map<string, string>();
    for (const [name, module] of streamShaders) {
        const source = readPinnedRawShader(
            module,
            `src/loader-splat-stream/splat-stream-${name}.wgsl`,
        );
        writeFileSync(join(directory, `splat-stream-${name}.wgsl`), source);
        sources.set(name, source);
    }
    return sources;
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

function runDawnStream(): Map<string, string> | undefined {
    const tools = optionalNativeFixtureTools(false);
    if (!tools || !existsSync(join(dawnRoot, "lib/webgpu_dawn.lib")))
        return undefined;
    const output = resolve("artifacts/test-webgpu-subset/dawn");
    const shaders = join(output, "wgsl");
    writeStreamShaders(shaders);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, [
        `/I${resolve("native/src")}`,
        `/I${resolve("test/fixtures/webgpu-subset")}`,
        `/external:I${join(dawnRoot, "include")}`,
        `/Fo:${output}/`,
        `/Fe:${executable}`,
        resolve("test/fixtures/webgpu-subset/dawn-check.cpp"),
        "/link",
        join(dawnRoot, "lib/webgpu_dawn.lib"),
    ]);
    return resultLines(
        execFileSync(executable, [shaders], {
            encoding: "utf8",
            timeout: 120000,
            windowsHide: true,
            env: {
                ...process.env,
                PATH: `${join(dawnRoot, "bin")};${process.env.PATH ?? ""}`,
            },
        }),
    );
}

test("Dawn runs the pinned splat-stream compute through the WebGPU subset device", (t) => {
    const lines = runDawnStream();
    if (!lines) {
        t.skip(
            "A native fixture compiler and the pinned Dawn build are required.",
        );
        return;
    }
    // The fixture compares each result with a CPU evaluation of the pinned WGSL.
    assert.equal(lines.get("dawn"), "ok");
    assert.equal(lines.get("mapping"), "ok");
    assert.equal(lines.get("limits"), "268435456 256640000 65535");
    assert.match(
        lines.get("sort") ?? "",
        /^capacity=70000 count=69123 visible=\d+ levels=2 /,
    );
    assert.match(lines.get("projection") ?? "", /^visible=36 /);
});

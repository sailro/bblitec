import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("backdrop blur survives CSS lowering and vendor spelling", () => {
    const cpp = compileSource(`
        import { createEngine } from "babylon-lite";
        const engine = await createEngine({});
        const panel = document.createElement("div");
        panel.style.cssText = "-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(18px);";
        document.body.appendChild(panel);
    `).cpp;
    assert.match(cpp, /backdrop-filter:blur\(8px\);backdrop-filter:blur\(18px\)/);
    assert.doesNotMatch(cpp, /brightness|webkit-backdrop/);
});

test("all UI GPU consumers preserve backdrop ordering", () => {
    for (const [backend, files] of [
        ["sdl", ["pal_sdl_gpu.cpp", "pal_sprite_ui_sdl.hpp"]],
        ["dawn", ["pal_dawn.cpp", "pal_sprite_ui_dawn.hpp"]],
    ] as const) {
        for (const file of files) {
            const source = readFileSync(`native/src/${file}`, "utf8");
            assert.match(source, /frame\.backdrops\[segment\]\.before_draw/);
            assert.ok(source.includes(`render_ui_backdrop_${backend}(`));
        }
    }
});

const nativeTools = optionalNativeFixtureTools();
test("backdrop masks intersect exactly and blur kernels preserve constant colors", { skip: !nativeTools }, () => {
    const output = resolve("artifacts/ui-backdrop-check");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "ui-backdrop-check.exe");
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/DBBLITE_HAS_UI=1",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", "/I", "native/src",
        "test/fixtures/ui-backdrop-check.cpp",
    ]);
    assert.match(execFileSync(executable, [], { encoding: "utf8" }), /ui-backdrop-check: ok/);
});

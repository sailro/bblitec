import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    sceneBackendSource,
} from "./native-fixture.js";

test("backdrop blur survives CSS lowering and vendor spelling", () => {
    const cpp = compileSource(`
        import { createEngine } from "babylon-lite";
        const engine = await createEngine({});
        const panel = document.createElement("div");
        panel.style.cssText = "-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(18px);";
        document.body.appendChild(panel);
    `).cpp;
    assert.match(
        cpp,
        /backdrop-filter:blur\(8px\);backdrop-filter:blur\(18px\)/,
    );
    assert.doesNotMatch(cpp, /brightness|webkit-backdrop/);
});

test("each backend's one UI compositor preserves backdrop ordering", () => {
    for (const backend of ["sdl", "dawn"] as const) {
        const nativeBackend = backend === "sdl" ? "sdl_gpu" : "dawn";
        const compositor = readFileSync(
            `native/src/pal_${nativeBackend}_sprite_ui.hpp`,
            "utf8",
        );
        assert.match(compositor, /for_each_ui_segment\(\s*frame,/);
        assert.ok(compositor.includes(`render_ui_backdrop_${nativeBackend}(`));
        const renderer = sceneBackendSource(backend);
        assert.ok(
            renderer.includes(`render_sprite_ui_${nativeBackend}_frame(`),
        );
        assert.doesNotMatch(renderer, /for_each_ui_segment\(/);
    }
});

const nativeTools = optionalNativeFixtureTools();
test(
    "backdrop masks intersect exactly and blur kernels preserve constant colors",
    { skip: !nativeTools },
    () => {
        const output = resolve("artifacts/ui-backdrop-check");
        mkdirSync(output, { recursive: true });
        const executable = join(output, "ui-backdrop-check.exe");
        runNativeFixtureCompiler(nativeTools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/permissive-",
            "/EHsc",
            "/DBBLITE_HAS_UI=1",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/include",
            "/I",
            "native/src",
            "test/fixtures/ui-backdrop-check.cpp",
        ]);
        assert.match(
            execFileSync(executable, [], { encoding: "utf8" }),
            /ui-backdrop-check: ok/,
        );
    },
);

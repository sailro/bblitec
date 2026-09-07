import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("compiler retains dynamic Canvas2D rectangles between path operations", () => {
    const result = compileSource(`
        import { createEngine } from "babylon-lite";
        const engine = await createEngine({});
        const canvas = document.createElement("canvas");
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        const context = canvas.getContext("2d")!;
        context.beginPath();
        context.moveTo(1, 2);
        context.lineTo(30, 40);
        context.fillStyle = "rgba(255,96,32,0.5)";
        context.fillRect(canvas.width * 0.3, 4.25, -6.5, canvas.height * 0.1);
        context.stroke();
        document.body.appendChild(canvas);
    `);
    assert.match(result.cpp, /ui_canvas_fill_rect\([^;]*ui_canvas_width[^;]*ui_canvas_height/);
    assert.ok(result.cpp.indexOf("ui_canvas_line_to") < result.cpp.indexOf("ui_canvas_fill_rect"));
    assert.ok(result.cpp.indexOf("ui_canvas_fill_rect") < result.cpp.indexOf("ui_canvas_stroke("));
});

const nativeTools = optionalNativeFixtureTools(false);
test("compiler supplies a Canvas2D presentation host without a source engine", () => {
    const result = compileSource(`
        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#102030";
        const width = canvas.width;
        const height = canvas.height;
        context.fillRect(0, 0, width, height);
        canvas.dataset.ready = "true";
    `);
    assert.ok(result.manifest.features.includes("renderer:canvas"));
    assert.ok(result.manifest.features.includes("ui:rml"));
    assert.ok(!result.manifest.features.includes("renderer:sprite"));
    assert.ok(!result.manifest.features.includes("renderer:scene"));
    assert.match(result.cpp, /ui_canvas_fill_rect/);
    assert.match(result.cpp, /ui_primary_canvas/);
    assert.match(result.cpp, /start_engine\(v_bblite_presentation_host_/);
});

test("primary Canvas2D ownership refuses a second GPU engine in both source orders", () => {
    const gpu = "const engine = await createEngine({});";
    const canvas = `
        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
        const context = canvas.getContext("2d")!;
        context.fillRect(0, 0, 20, 20);
    `;
    for (const body of [gpu + canvas, canvas + gpu]) {
        assert.throws(() => compileSource(`
            import { createEngine } from "@babylonjs/lite";
            ${body}
        `), /primary canvas already belongs to a Babylon engine|supports one engine per entry point/);
    }
});

test("Canvas2D rectangles preserve paths and have exact backing-pixel coverage", { skip: !nativeTools }, () => {
    const output = resolve("artifacts/ui-canvas-rectangle-check");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "ui-canvas-rectangle-check.exe");
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/DBBLITE_HAS_UI=1",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", "/I", "native/src",
        "test/fixtures/ui-canvas-rectangle-check.cpp",
    ]);
    assert.match(execFileSync(executable, [], { encoding: "utf8" }), /ui-canvas-rectangle-check: ok/);
});

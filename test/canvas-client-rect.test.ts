import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("canvas rectangle reads use CSS extents while sprite coordinates use backing pixels", () => {
    const result = compileSource(`
        import {createEngine} from "@babylonjs/lite";
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const output = document.createElement("div");
            document.body.appendChild(output);
            canvas.addEventListener("pointermove", event => {
                const rect = canvas.getBoundingClientRect();
                output.textContent = String((event.clientX - rect.left) * canvas.width / rect.width) + "," +
                    String((event.clientY - rect.top) * canvas.height / rect.height);
            });
        }
        void main();
    `);
    assert.match(result.cpp, /canvas_client_width/);
    assert.match(result.cpp, /canvas_client_height/);
    assert.match(result.cpp, /options\.width/);
    assert.match(result.cpp, /options\.height/);
});

test("primary canvas rectangle edges and coordinates use native CSS extents", (t) => {
    const result = compileSource(`
        import {createEngine} from "@babylonjs/lite";
        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
        const engine = await createEngine(canvas);
        const rect = canvas.getBoundingClientRect();
        if (rect.x !== 0 || rect.y !== 0 || rect.left !== 0 || rect.top !== 0 ||
            rect.right !== 640 || rect.bottom !== 360 || rect.width !== 640 || rect.height !== 360 ||
            canvas.width !== 1280 || canvas.height !== 720)
            throw new Error("primary canvas rectangle");
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const output = resolve("artifacts/canvas-client-rect");
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp");
    const executable = join(output, "check.exe");
    writeFileSync(
        source,
        `${result.cpp}
        namespace bbl {
        Engine create_engine(EngineOptions options) {
            Engine engine;
            engine.options = options;
            engine.canvas_client_width = options.width / 2.0;
            engine.canvas_client_height = options.height / 2.0;
            return engine;
        }
        }
        `,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/I",
        "native/include",
        `/Fo:${output}/`,
        `/Fe:${executable}`,
        source,
    ]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});

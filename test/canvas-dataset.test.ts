import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

function compileDataset(body: string) {
    return compileSource(`
        import { createEngine, startEngine } from "@babylonjs/lite";
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine({ canvas });
            ${body}
            await startEngine(engine);
        }
        void main();
    `);
}

test("primary canvas readback retains its handshake without enabling device recovery", () => {
    const result = compileDataset(`
        canvas.dataset.ready = "false";
        const phase = canvas.dataset.phase;
        canvas.dataset.ready = String(phase === "complete");
    `);
    assert.ok(!result.manifest.features.includes("engine:device-recovery"));
    assert.match(result.cpp, /set_canvas_dataset\([^\n]+"ready", "false"/);
    assert.match(result.cpp, /canvas_dataset\([^\n]+"phase"/);
    assert.match(result.cpp, /defer_capture_until\([^\n]+canvas_dataset\([^\n]+"ready"/);
});

test("write-only dataset instrumentation retains the browser erasure boundary", () => {
    const result = compileDataset('canvas.dataset.label = "diagnostic";');
    assert.doesNotMatch(result.cpp, /(?:set_canvas_dataset|defer_capture_until)/);
});

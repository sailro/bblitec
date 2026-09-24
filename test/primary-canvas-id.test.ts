/**
 * The native primary canvas is the element a program hands `createEngine`,
 * found by whatever id the program looks that element up by -- here through
 * a helper's parameter, as an application wraps engine creation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

const program = (engineId: string, drawnId: string): string => `
    import { createEngine } from "@babylonjs/lite";
    async function boot(surface: HTMLCanvasElement) {
        return createEngine(surface);
    }
    const canvas = document.getElementById(${JSON.stringify(engineId)}) as HTMLCanvasElement;
    const engine = await boot(canvas);
    const drawn = document.getElementById(${JSON.stringify(drawnId)}) as HTMLCanvasElement;
    const context = drawn.getContext("2d")!;
    context.fillRect(0, 0, 20, 20);
    console.log(engine !== undefined);
`;

const owned = /primary canvas already belongs to a Babylon engine/;

test("the engine canvas is the primary canvas under the program's own id", () => {
    assert.throws(
        () => compileSource(program("app", "app"), { fileName: "app.ts" }),
        owned,
    );
});

test("the host document's id names the primary canvas by default", () => {
    assert.throws(
        () =>
            compileSource(program("renderCanvas", "renderCanvas"), {
                fileName: "render-canvas.ts",
            }),
        owned,
    );
});

test("another id is not the primary canvas once the program names its own", () => {
    const result = compileSource(program("app", "renderCanvas"), {
        fileName: "other-canvas.ts",
    });
    assert.doesNotMatch(result.cpp, /ui_primary_canvas/);
});

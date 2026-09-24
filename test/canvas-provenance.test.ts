/**
 * A canvas is the DOM library's `HTMLCanvasElement` or `OffscreenCanvas`,
 * decided by where the type is declared: a program's own type that shares
 * one of those names is ordinary data.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

test("a program type named like a canvas is not the engine canvas", () => {
    const { cpp } = compileSource(
        `
        interface OffscreenCanvas { width: number; height: number; }
        const surfaces: OffscreenCanvas[] = [{ width: 4, height: 2 }];
        if (Math.random() > 2) surfaces.push({ width: 1, height: 1 });
        const surface = surfaces[0]!;
        const area = surface.width * surface.height;
        if (area !== 8) throw new Error("user canvas");
        `,
        { fileName: "user-canvas.ts" },
    );
    assert.match(cpp, /\(v_surface->width \* v_surface->height\)/);
});

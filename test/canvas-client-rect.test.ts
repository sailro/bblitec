import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

/** An engine whose canvas CSS extent is half its backing resolution. */
const halfExtentEngine = `
namespace bbl {
Engine create_engine(EngineOptions options) {
    Engine engine;
    engine.options = options;
    engine.canvas_client_width = options.width / 2.0;
    engine.canvas_client_height = options.height / 2.0;
    return engine;
}
}
`;

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
    runGeneratedProgram(
        tools,
        "canvas-client-rect",
        result.cpp + halfExtentEngine,
        { expectedOutput: "" },
    );
});

test("a record field holding the primary canvas measures it where a later callback reads it", (t) => {
    const result = compileSource(`
        import {createEngine} from "@babylonjs/lite";
        interface Deps { canvas: HTMLCanvasElement; scale: number; nested: { canvas: HTMLCanvasElement } }
        function photographer(deps: Deps) {
            return {
                view(): number | null {
                    if (!deps.canvas) return null;
                    const rect = deps.canvas.getBoundingClientRect();
                    if (rect.width < 1 || rect.height < 1) return null;
                    return (rect.width / rect.height) * deps.scale;
                },
                sight(u: number, v: number): number {
                    const rect = deps.nested.canvas.getBoundingClientRect();
                    return (rect.left + u * rect.width) * 1000 + rect.top + v * rect.height;
                },
            };
        }
        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
        await createEngine(canvas);
        const shots = photographer({ canvas, scale: 2, nested: { canvas } });
        if (shots.view() !== (640 / 360) * 2 || shots.sight(0.5, 0.25) !== 320 * 1000 + 90)
            throw new Error("record canvas rectangle");
    `);
    assert.match(result.cpp, /canvas_client_width/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "canvas-client-rect-record-field",
        result.cpp + halfExtentEngine,
        { expectedOutput: "" },
    );
});

test("a field typed as members picked from the canvas measures the canvas it holds", (t) => {
    const result = compileSource(`
        import {createEngine} from "@babylonjs/lite";
        interface Deps { canvas: Pick<HTMLCanvasElement, "getBoundingClientRect">; project(x: number): number | null }
        function command(deps: Deps) {
            return (x: number): string => {
                const pixel = deps.project(x);
                if (pixel === null) return "behind";
                const rect = deps.canvas.getBoundingClientRect();
                return pixel < rect.left || pixel >= rect.right ? "off" : "on " + rect.width + "x" + rect.height;
            };
        }
        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
        await createEngine(canvas);
        const at = command({ canvas, project: (x) => (x > 0 ? x : null) });
        const answers = [at(-1), at(10), at(700)];
        if (answers.join() !== "behind,on 640x360,off") throw new Error(answers.join());
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "canvas-client-rect-picked-members",
        result.cpp + halfExtentEngine,
        { expectedOutput: "" },
    );
});

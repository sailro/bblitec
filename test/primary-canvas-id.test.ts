/**
 * The native primary canvas is the element a program hands `createEngine`,
 * found by whatever id the program looks that element up by -- here through
 * a helper's parameter, as an application wraps engine creation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import type { CompileOptions } from "../src/compiler/types.js";

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

test("the native primary canvas is created under the id the program finds it by", () => {
    const result = compileSource(
        `
        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
        const context = canvas.getContext("2d")!;
        context.fillRect(0, 0, 20, 20);
    `,
        { fileName: "primary-canvas.ts" },
    );
    assert.match(
        result.cpp,
        /bbl::ui_primary_canvas\([^()]+, "renderCanvas"\)/,
    );
});

/** A program finding its engine canvas, and a host button before and after the engine, by `find`. */
const compileFound = (
    find: (id: string) => string,
    nativeHostUi?: CompileOptions["nativeHostUi"],
) =>
    compileSource(
        `
        import { createEngine, createSceneContext, registerScene, startEngine } from "@babylonjs/lite";
        const canvas = ${find("app")} as HTMLCanvasElement | null;
        if (!canvas) throw new Error("canvas is missing");
        ${nativeHostUi ? `const before = ${find("go")} as HTMLButtonElement;` : ""}
        const engine = await createEngine(canvas);
        ${
            nativeHostUi
                ? `registerScene(createSceneContext(engine));
                   const after = ${find("go")} as HTMLButtonElement;
                   before.addEventListener("click", () => { after.textContent = "Clicked"; });
                   await startEngine(engine);`
                : "console.log(engine !== undefined);"
        }
    `,
        { fileName: "found.ts", ...(nativeHostUi ? { nativeHostUi } : {}) },
    );
const byId = (id: string) => `document.getElementById(${JSON.stringify(id)})`;
const bySelector = (selector: string) =>
    `document.querySelector(${JSON.stringify(selector)})`;

test("an ID-selector query finds the primary canvas as its id lookup does", () => {
    assert.equal(
        compileFound((id) => bySelector(`#${id}`)).cpp,
        compileFound(byId).cpp,
    );
});

test("an ID-selector query finds a host companion element as its id lookup does", () => {
    const companion = {
        sourcePath: "test/primary-canvas-id.test.ts",
        elements: [
            {
                tag: "button",
                text: "Go",
                attributes: { id: "go", type: "button" },
            },
        ],
    };
    assert.equal(
        compileFound((id) => bySelector(`#${id}`), companion).cpp,
        compileFound(byId, companion).cpp,
    );
});

test("a selector that is not one ID selector does not name the primary canvas", () => {
    for (const selector of ["canvas#app", "#app canvas"]) {
        const result = compileFound(() => bySelector(selector));
        assert.match(result.cpp, /ui_query_element/);
        assert.doesNotMatch(result.cpp, /ui_primary_canvas/);
        assert.ok(result.manifest.features.includes("platform:window"));
    }
    assert.throws(
        () => compileFound(() => bySelector("#\\61pp")),
        /Retained DOM query selector .* is not lowered/,
    );
});

test("another id is not the primary canvas once the program names its own", () => {
    const result = compileSource(program("app", "renderCanvas"), {
        fileName: "other-canvas.ts",
    });
    assert.doesNotMatch(result.cpp, /ui_primary_canvas/);
    assert.match(result.cpp, /ui_find_element_by_id[^\n]+"renderCanvas"/);
    assert.match(result.cpp, /ui_canvas_fill_rect/);
});

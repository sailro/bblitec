/**
 * The native primary canvas is the element a program hands `createEngine`,
 * found by whatever id the program looks that element up by -- here through
 * a helper's parameter, as an application wraps engine creation.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import type { CompileOptions } from "../src/compiler/types.js";
import { runRmlUiFixture } from "./native-fixture.js";
import { hostPageCompileOptions, readHostPage } from "../src/host-page.js";

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

test("a bare engine canvas query keeps its primary owner through aliases and helper parameters", () => {
    const result = compileSource(`
        import {createEngine, startEngine} from "@babylonjs/lite";
        async function boot(surface: HTMLCanvasElement) {
            const engine = await createEngine(surface);
            await startEngine(engine);
        }
        async function main() {
            const selector = "canvas";
            const canvas = document.querySelector(selector) as HTMLCanvasElement | null;
            if (!canvas) throw new Error("missing primary canvas");
            const alias = canvas;
            await boot(alias);
            canvas.dataset.ready = "true";
        }
        void main().catch(console.error);
    `);
    assert.ok(!result.manifest.features.includes("platform:window"));
    assert.match(result.cpp, /bbl::create_engine\(/);
    assert.doesNotMatch(result.cpp, /run_window_application|ui_query_element/);
});

test("bare selectors with authored canvases or stored Documents retain ordinary lookup semantics", () => {
    const source = (lookup: string) => `
        import {createEngine} from "@babylonjs/lite";
        document.body.dataset.started = "true";
        const docs: Document[] = [document];
        const canvas = ${lookup} as HTMLCanvasElement | null;
        if (canvas) await createEngine(canvas);
    `;
    const explicit = compileSource(source('document.querySelector("canvas")'), {
        nativeHostUi: {
            sourcePath: "test/primary-canvas-id.test.ts",
            elements: [{ tag: "section", children: [{ tag: "canvas" }] }],
        },
    });
    const stored = compileSource(source('docs[0]!.querySelector("canvas")'));
    for (const result of [explicit, stored]) {
        assert.ok(result.manifest.features.includes("platform:window"));
        assert.match(result.cpp, /ui_query_element/);
        assert.doesNotMatch(result.cpp, /ui_primary_canvas/);
    }
});

test("an authored page without a canvas preserves a nullable engine query", () => {
    const directory = resolve("artifacts/implicit-engine-canvas-page");
    mkdirSync(directory, { recursive: true });
    const source = `
        import {createEngine} from "@babylonjs/lite";
        const canvas = document.querySelector("canvas");
        if (canvas) await createEngine(canvas);
    `;
    writeFileSync(join(directory, "entry.ts"), source);
    const path = join(directory, "index.html");
    writeFileSync(
        path,
        '<!doctype html><html><head></head><body><script type="module" src="./entry.ts"></script></body></html>',
    );
    const result = compileSource(
        source,
        hostPageCompileOptions(readHostPage({ path })),
    );
    assert.ok(result.manifest.features.includes("platform:window"));
    assert.match(result.cpp, /ui_query_element/);
    assert.doesNotMatch(result.cpp, /ui_primary_canvas/);
});

test("Window startup preserves the host canvas, readiness and caught failures", (t) => {
    const directory = resolve("artifacts/implicit-engine-canvas");
    mkdirSync(directory, { recursive: true });
    const result = compileSource(`
        import {createEngine} from "@babylonjs/lite";
        async function boot(surface: HTMLCanvasElement) {
            return createEngine(surface);
        }
        async function expectedFailure() { throw new Error("expected startup failure"); }
        void expectedFailure().catch(error => { document.body.dataset.caught = error.message; });
        async function main() {
            document.body.dataset.started = "true";
            const before = document.createElement("canvas");
            before.id = "before";
            document.body.appendChild(before);
            const detached = document.createElement("canvas");
            detached.id = "detached";
            document.body.addEventListener("click", () => {
                const callbackCanvas = document.createElement("canvas");
                document.body.appendChild(callbackCanvas);
            });
            if (performance.now() < 0) document.body.appendChild(document.createElement("canvas"));
            const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
            if (!canvas) throw new Error("missing implicit canvas");
            if (canvas.id !== "renderCanvas" || canvas === before || canvas === detached) throw new Error("host canvas identity");
            const engine = await boot(canvas);
            const after = document.createElement("canvas");
            document.body.appendChild(after);
            if (document.querySelector("canvas") !== canvas) throw new Error("later canvas identity");
            canvas.dataset.draws = String(engine.drawCallCount);
            canvas.dataset.ready = "true";
            globalThis.close();
        }
        void main().catch(error => {
            document.body.dataset.failure = error.message;
            globalThis.close();
        });
    `);
    assert.ok(result.manifest.features.includes("platform:window"));
    assert.equal(result.manifest.canvasReadyGate, true);
    assert.match(result.cpp, /ui_primary_canvas/);
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "implicit-engine-canvas", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
            BBLITE_HAS_PBR_RENDERER: 0,
        },
    });
});

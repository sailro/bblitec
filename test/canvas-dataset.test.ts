import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import { writesUnobservedCanvasMetadata } from "../src/compiler/canvas-instrumentation.js";
import { hostUiOptions } from "./host-page-fixture.js";

const nativeHostUi = {
    elements: [{ tag: "canvas", attributes: { id: "renderCanvas" } }],
};
const hostPage = { path: "test/canvas-dataset.test.ts" };

function instrumentationSource(captures: string, effects: string, size = "1") {
    return `
        import { createEngine, createBox, createSceneContext, addToScene, startEngine } from "@babylonjs/lite";
        ${captures}
        function install(canvas: HTMLElement) {
            canvas.dataset.loadingSize = "instrumentation";
            ${effects}
            return { done(): void { globalThis.fetch; } };
        }
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const progress = install(canvas);
            const engine = await createEngine({ canvas });
            const mesh = createBox(engine, { size: ${size} });
            const scene = createSceneContext(engine);
            addToScene(scene, mesh);
            progress.done();
            await startEngine(engine);
        }
        void main();
    `;
}

function admitsInstrumentation(source: string, withHost = true): boolean {
    const { checker, program, sourceFile } = createCompilerProgram(
        source,
        "input.ts",
    );
    let result = false;
    const visit = (node: ts.Node): void => {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "install"
        ) {
            result = writesUnobservedCanvasMetadata(
                checker,
                program.getSourceFiles(),
                node,
                0,
                withHost ? nativeHostUi : undefined,
            );
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return result;
}

function compileDataset(body: string) {
    return compileSource(`
        import { createEngine as makeEngine, startEngine as runEngine } from "@babylonjs/lite";
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await makeEngine({ canvas });
            ${body}
            await runEngine(engine);
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
    assert.equal(result.manifest.canvasReadyGate, true);
    assert.match(result.cpp, /set_canvas_dataset\([^\n]+"ready", "false"/);
    assert.match(result.cpp, /canvas_dataset_value\([^\n]+"phase"/);
    assert.match(
        result.cpp,
        /defer_capture_until\([^\n]+canvas_dataset\([^\n]+"ready"/,
    );
});

test("write-only dataset instrumentation retains the browser erasure boundary", () => {
    const result = compileDataset('canvas.dataset.label = "diagnostic";');
    assert.equal(result.manifest.canvasReadyGate, undefined);
    assert.doesNotMatch(
        result.cpp,
        /(?:set_canvas_dataset|defer_capture_until)/,
    );
});

test("record receiver retention leaves browser instrumentation dispatch unchanged", () => {
    const result = compileDataset(`
        let calls = 0;
        function label(): string { calls++; return "diagnostic"; }
        canvas.dataset.label = label();
    `);
    assert.equal(result.manifest.canvasReadyGate, undefined);
    assert.doesNotMatch(
        result.cpp,
        /(?:set_canvas_dataset|defer_capture_until)/,
    );
});

test("retained host canvas keeps unobserved asset instrumentation outside native UI lowering", () => {
    const program = (size: string): string => `
        import { createEngine } from "@babylonjs/lite";
        function installProgress(canvas: HTMLElement) {
            const size = Math.max(0, ${size});
            const original = globalThis.fetch.bind(globalThis);
            if (size > 0) canvas.dataset.loadingSize = String(size);
            return { done(): void { globalThis.fetch = original; } };
        }
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const progress = installProgress(canvas);
            await createEngine({ canvas });
            progress.done();
        }
        void main();
    `;
    const canvas = { tag: "canvas", attributes: { id: "renderCanvas" } };
    const compile = (source: string, observed: boolean) =>
        compileSource(
            source,
            hostUiOptions(
                {
                    elements: [
                        observed
                            ? {
                                  ...canvas,
                                  attributes: {
                                      ...canvas.attributes,
                                      "data-loading-size": "pending",
                                  },
                              }
                            : canvas,
                    ],
                },
                hostPage,
            ),
        );
    // A size a host page installs: no native host does, so it reads absent.
    const installed = program(
        "(globalThis as { engineSize?: number }).engineSize ?? 0",
    );
    const result = compile(installed, false);
    assert.match(result.cpp, /ui_create_element\([^\n]+"canvas"/);
    assert.doesNotMatch(result.cpp, /engineSize|loadingSize|original/);
    // Observed metadata the program never writes natively leaves the helper
    // nothing to keep: it is erased with its fetch patch.
    assert.doesNotMatch(
        compile(installed, true).cpp,
        /engineSize|loadingSize|original/,
    );
    // A size known only at run time keeps the observed write, so the helper
    // stays, and the program refuses what it cannot run natively.
    assert.throws(
        () => compile(program("Date.now() % 7"), true),
        /The realm engine requires a native canvas context/,
        "Observed metadata must retain its helper and refuse what it cannot run",
    );
});

test("metadata helpers retain captured scalar and object mutations used by native geometry", () => {
    const scalar = instrumentationSource(
        "let counter = 0;",
        "counter++;",
        "counter",
    );
    assert.equal(admitsInstrumentation(scalar), false);
    const scalarResult = compileSource(
        scalar,
        hostUiOptions(nativeHostUi, hostPage),
    );
    assert.match(scalarResult.cpp, /v_counter\+\+/);
    assert.match(scalarResult.cpp, /create_box\([^\n]+v_counter/);

    const object = instrumentationSource(
        "const state = { size: 0 };",
        "state.size++;",
        "state.size",
    );
    assert.equal(admitsInstrumentation(object), false);
    const objectResult = compileSource(
        object,
        hostUiOptions(nativeHostUi, hostPage),
    );
    assert.match(objectResult.cpp, /(?:v_state|v_alias)[^\n]*size[^\n]*\+\+/);
    assert.match(objectResult.cpp, /create_box\([^\n]+v_state/);
});

test("metadata helper admission retains indirect and unknown effects", () => {
    for (const [captures, effects] of [
        ["let counter = 0; function update() { counter++; }", "update();"],
        ["const state = { values: [1] };", "state.values.push(2);"],
        ["declare const update: () => void;", "update();"],
        [
            "let counter = 0;",
            "const callback = () => { counter++; }; requestAnimationFrame(callback);",
        ],
        [
            "const state = { size: 0 };",
            "const local = { state }; local.state.size++;",
        ],
        ["const state = { size: 0 };", "const alias = state; alias.size++;"],
        [
            "let counter = 0; const state = { get size() { return ++counter; } };",
            "const size = state.size;",
        ],
    ]) {
        assert.equal(
            admitsInstrumentation(instrumentationSource(captures!, effects!)),
            false,
            effects,
        );
    }
});

test("metadata erasure retains template selectors and computed or extracted DOM readers", () => {
    const source = (observer: string) => `
        function install(canvas: HTMLCanvasElement) {
            canvas.dataset.loadingSize = "ready";
            return { stop(): void {} };
        }
        const canvas = document.createElement("canvas");
        const controller = install(canvas);
        ${observer}
    `;
    for (const withHost of [false, true]) {
        for (const observer of [
            "const css = `canvas[data-loading-size] {opacity:${performance.now()}}`;",
            "const css = `${1}canvas[data-loading-size]${2}`;",
            "const css = `${1}canvas[data-loading-size]`;",
            'canvas.getAttribute(`data-${"loading-size"}`);',
            'canvas.hasAttribute("data-" + "loading-size");',
            'canvas.getAttribute("DATA-LOADING-SIZE");',
            "canvas.getAttribute(String(performance.now()));",
            'canvas["hasAttribute"](String(performance.now()));',
            "canvas.getAttributeNS(null, String(performance.now()));",
            "canvas.getAttributeNames();",
            ...["querySelector", "querySelectorAll", "matches", "closest"].map(
                (method) => `canvas.${method}(String(performance.now()));`,
            ),
            "const reader = canvas.getAttribute;",
            'const field="loading-size"; const style=document.createElement("style"); style.textContent="canvas[data-"+field+"]{opacity:0}";',
            'const field="loading-size"; const style=document.createElement("style"); style.textContent=`canvas[data-${field}]{opacity:0}`;',
            'const style=document.createElement("style"); style.textContent="canvas[data-"; style.textContent+="loading-size]{opacity:0}";',
            ...["insertRule", "replace", "replaceSync", "addRule"].map(
                (method) =>
                    `const sheet=new CSSStyleSheet(); sheet.${method}(String(performance.now()));`,
            ),
            "const sheet=new CSSStyleSheet(); const change=sheet.replaceSync;",
        ])
            assert.equal(
                admitsInstrumentation(source(observer), withHost),
                false,
                observer,
            );
        for (const observer of [
            "",
            'canvas.getAttribute("title");',
            'canvas.hasAttribute("data-other");',
            'canvas.matches(".other");',
            'canvas.querySelector("[data-other]");',
            'const style=document.createElement("style"); style.textContent="canvas[data-other]{opacity:0}";',
            'const div=document.createElement("div"); div.textContent=String(performance.now());',
            ...["insertRule", "replace", "replaceSync", "addRule"].map(
                (method) =>
                    `const sheet=new CSSStyleSheet(); sheet.${method}("canvas[data-other]{opacity:0}");`,
            ),
        ])
            assert.equal(
                admitsInstrumentation(source(observer), withHost),
                true,
                observer,
            );
    }
});

test("the pinned fetch-progress helper proves its local and browser effects before worker discovery", () => {
    const helper = readFileSync(
        "corpus/babylon-lite/lab/lite/src/demos/loading-progress.ts",
        "utf8",
    );
    const source = `
        import { createEngine } from "@babylonjs/lite";
        ${helper}
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const progress = installFetchProgress(canvas, { estimatedBytes: 1024 });
            await createEngine({ canvas });
            progress.done();
        }
        void main();
    `;
    const result = compileSource(source, hostUiOptions(nativeHostUi, hostPage));
    assert.match(result.cpp, /ui_create_element\([^\n]+"canvas"/);
    assert.doesNotMatch(
        result.cpp,
        /loadingSize|loadingDetail|shownPct|ReadableStream/,
    );
});

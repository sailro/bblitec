import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import { writesUnobservedCanvasMetadata } from "../src/compiler/canvas-instrumentation.js";

const nativeHostUi = {
    sourcePath: "test/canvas-dataset.test.ts",
    elements: [{ tag: "canvas", attributes: { id: "renderCanvas" } }],
};

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

function admitsInstrumentation(source: string): boolean {
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
                nativeHostUi,
            );
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return result;
}

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
    assert.match(result.cpp, /canvas_dataset_value\([^\n]+"phase"/);
    assert.match(
        result.cpp,
        /defer_capture_until\([^\n]+canvas_dataset\([^\n]+"ready"/,
    );
});

test("write-only dataset instrumentation retains the browser erasure boundary", () => {
    const result = compileDataset('canvas.dataset.label = "diagnostic";');
    assert.doesNotMatch(
        result.cpp,
        /(?:set_canvas_dataset|defer_capture_until)/,
    );
});

test("retained host canvas keeps unobserved asset instrumentation outside native UI lowering", () => {
    const source = `
        import { createEngine } from "@babylonjs/lite";
        function installProgress(canvas: HTMLElement) {
            const size = Math.max(0, (globalThis as { engineSize?: number }).engineSize ?? 0);
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
    const result = compileSource(source, {
        nativeHostUi: {
            sourcePath: "test/canvas-dataset.test.ts",
            elements: [canvas],
        },
    });
    assert.match(result.cpp, /ui_create_element\([^\n]+"canvas"/);
    assert.doesNotMatch(result.cpp, /engineSize|loadingSize|original/);
    assert.throws(
        () =>
            compileSource(source, {
                nativeHostUi: {
                    sourcePath: "test/canvas-dataset.test.ts",
                    elements: [
                        {
                            ...canvas,
                            attributes: {
                                ...canvas.attributes,
                                "data-loading-size": "pending",
                            },
                        },
                    ],
                },
            }),
        /Browser-dependent condition cannot be determined/,
        "Observed metadata must retain its helper and refuse an unanswered browser value",
    );
});

test("metadata helpers retain captured scalar and object mutations used by native geometry", () => {
    const scalar = instrumentationSource(
        "let counter = 0;",
        "counter++;",
        "counter",
    );
    assert.equal(admitsInstrumentation(scalar), false);
    const scalarResult = compileSource(scalar, { nativeHostUi });
    assert.match(scalarResult.cpp, /v_counter\+\+/);
    assert.match(scalarResult.cpp, /create_box\([^\n]+v_counter/);

    const object = instrumentationSource(
        "const state = { size: 0 };",
        "state.size++;",
        "state.size",
    );
    assert.equal(admitsInstrumentation(object), false);
    const objectResult = compileSource(object, { nativeHostUi });
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
    const result = compileSource(source, { nativeHostUi });
    assert.match(result.cpp, /ui_create_element\([^\n]+"canvas"/);
    assert.doesNotMatch(
        result.cpp,
        /loadingSize|loadingDetail|shownPct|ReadableStream/,
    );
});

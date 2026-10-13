import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const directory = resolve("artifacts/ui-easing");

// Easing functions inside multi-item transition and animation lists, the
// initial `ease`, and a keyframe blink with steps().
const program = `
    const sheet = document.createElement("style");
    sheet.textContent = \`
        .curve { width: 10px; height: 4px; transition: opacity 100ms ease, width 100ms cubic-bezier(.2, .9, .3, 1.5); opacity: 0; }
        .curve.on { width: 110px; opacity: 1; }
        .stepped { width: 10px; height: 4px; transition: width 100ms steps(4, jump-end), opacity 100ms step-start; opacity: 0; }
        .stepped.on { width: 110px; opacity: 1; }
        .initial { opacity: 0; transition: opacity 100ms; }
        .initial.on { opacity: 1; }
        .blink { width: 4px; height: 4px; animation: blink 1s steps(1, end) infinite; }
        @keyframes blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
    \`;
    document.head.appendChild(sheet);
    for (const id of ["curve", "stepped", "initial", "blink"]) {
        const element = document.createElement("div");
        element.id = id;
        element.className = id;
        document.body.appendChild(element);
    }
    globalThis.close();
`;

test("easing functions run natively with their CSS curves", (t) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        ${program}`,
        { fileName: join(directory, "entry.ts") },
    );
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "ui-easing", {
        macros: { BBLITE_WORKERS: 1, BBLITE_OFFSCREEN_SURFACES: 1 },
    });
});

// RmlUi's parser is the easing grammar: these compile, and the native fixture
// above checks that it refuses them when applied.
test("easing functions outside the native grammar compile and refuse natively", () => {
    const prefix = `const panel = document.createElement("div");`;
    for (const write of [
        `panel.style.transition = "opacity 1s linear(0, 0.5, 1)";`,
        `panel.style.cssText = "transition: opacity 1s cubic-bezier(2, 0, 0, 1)";`,
        `panel.style.animation = "spin 1s steps(1, jump-none) infinite";`,
        `panel.style.animation = "spin 1s steps(2.5)";`,
        `panel.style.transition = "opacity 1s steps(3, jump-none), width 1s cubic-bezier(0, -1, 1, 2)";`,
    ])
        assert.doesNotThrow(() => compileSource(prefix + write));
});

import assert from "node:assert/strict";
import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {runRmlUiFixture} from "./native-fixture.js";

const source = `
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
    worker.terminate();
    const sheet = document.createElement("style");
    sheet.textContent = ".tiles{display:grid;grid-template-columns:repeat(2,24px);gap:3px}.cell{width:24px;height:24px;padding:0;border:none}";
    document.head.appendChild(sheet);
    const root = document.createElement("div");
    root.id = "tiles";
    root.className = "tiles";
    const first = document.createElement("button");
    first.id = "first";
    first.className = "cell";
    const second = document.createElement("button");
    second.id = "second";
    second.className = "cell";
    root.append(first, second);
    document.body.appendChild(root);
    first.addEventListener("click", () => { sheet.remove(); });
    globalThis.close();
`;

test("known stylesheet removal validates each cascade and updates fixed grids", t => {
    const directory = resolve("artifacts/ui-grid-sheet-removal");
    mkdirSync(directory, {recursive:true});
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(source, {fileName:join(directory, "entry.ts")});
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "ui-grid-sheet-removal");
});

test("removing a geometry override refuses an invalid remaining fixed grid", () => {
    const unsafe = source.replace(
        'first.addEventListener("click", () => { sheet.remove(); });',
        `const correction = document.createElement("style");
         correction.textContent = ".cell{width:24px}";
         document.head.appendChild(correction);
         first.addEventListener("click", () => { correction.remove(); });`,
    ).replace('.cell{width:24px;height:24px', '.cell{width:32px;height:24px');
    assert.throws(() => compileSource(unsafe, {
        fileName:resolve("artifacts/ui-grid-sheet-removal/entry.ts"),
    }), /fixed-grid.*width|width.*fixed/i);
});

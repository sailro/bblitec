import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const directory = resolve("artifacts/ui-idl-attributes");

function compileEntry(body: string): string {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    return compileSource(
        `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        ${body}`,
        { fileName: join(directory, "entry.ts") },
    ).cpp;
}

test("element IDL attributes reflect with HTML semantics and reach native controls", (t) => {
    const cpp = compileEntry(`
        const log = document.createElement("div");
        log.id = "log";
        document.body.append(log);
        let order = "";
        function record(value: string): void { order += value; log.textContent = order; }
        const sheet = document.createElement("style");
        sheet.textContent = ".box{width:100px;height:100px;overflow:auto}.tall{width:300px;height:400px}";
        document.head.appendChild(sheet);
        // draggable: images (and links with an href) drag by default.
        const img = document.createElement("img");
        record(img.draggable ? "1" : "x");
        img.alt = "";
        img.draggable = false;
        record(img.draggable || img.alt !== "" ? "x" : "2");
        const link = document.createElement("a");
        const plain = document.createElement("div");
        record(!link.draggable && !plain.draggable ? "3" : "x");
        // maxLength: -1 when absent; a negative write throws IndexSizeError.
        const name = document.createElement("input");
        name.id = "name";
        record(String(name.maxLength));
        name.maxLength = 5;
        try { name.maxLength = -1; } catch { record("M"); }
        record(String(name.maxLength));
        name.placeholder = "Name";
        name.autocomplete = "off";
        name.pattern = "[a-z]+";
        record(name.placeholder + name.pattern + (name.getAttribute("autocomplete") ?? ""));
        // inputMode is limited to its keywords.
        record(name.inputMode === "" ? "i" : "x");
        name.inputMode = "NUMERIC";
        record(name.inputMode);
        name.setAttribute("inputmode", "bogus");
        record(name.inputMode === "" ? "b" : "x");
        name.inputMode = "numeric";
        // spellcheck inherits; the document default checks.
        const field = document.createElement("div");
        record(field.spellcheck ? "d" : "x");
        field.spellcheck = false;
        field.append(name);
        record(name.spellcheck ? "x" : "c");
        name.spellcheck = true;
        record(name.spellcheck ? "C" : "x");
        name.spellcheck = false;
        const check = document.createElement("input");
        check.type = "checkbox";
        check.id = "check";
        const label = document.createElement("label");
        label.id = "label";
        label.htmlFor = "check";
        label.textContent = "Toggle";
        record(label.htmlFor);
        const box = document.createElement("div");
        box.id = "box";
        box.className = "box";
        const tall = document.createElement("div");
        tall.className = "tall";
        box.append(tall);
        box.scrollTop = 50;
        box.scrollLeft = 1000;
        document.body.append(img, link, plain, field, check, label, box);
        globalThis.close();
    `);
    writeFileSync(join(directory, "program.hpp"), cpp);
    for (const lowered of [
        /bbl::ui_set_attribute\([^;]+"alt", ""\)/,
        /bbl::ui_set_attribute\([^;]+"draggable", "false"\)/,
        /bbl::ui_set_max_length\(/,
        /bbl::ui_get_enumerated_attribute\([^;]+"inputmode", \{"none", "text", "tel", "url", "email", "numeric", "decimal", "search"\}\)/,
        /bbl::ui_set_attribute\([^;]+"for", "check"\)/,
        /bbl::ui_set_scroll_offset\([^;]+, false, 50.0\)/,
    ])
        assert.match(cpp, lowered);
    runRmlUiFixture(t, "ui-idl-attributes", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
        },
    });
});

test("unrepresented IDL attribute forms refuse", () => {
    for (const [body, pattern] of [
        [
            `const img = document.createElement("img"); img.draggable = true;`,
            /Element drag-and-drop is not lowered natively: only draggable = false is/,
        ],
        [
            `const input = document.createElement("input"); input.textContent = input.autocomplete;`,
            /Reading autocomplete \(the IDL-exposed autofill value\) is not lowered natively/,
        ],
    ] as const)
        assert.throws(() => compileEntry(body), pattern, body);
});

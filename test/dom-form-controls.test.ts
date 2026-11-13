import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const realm = `
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
    worker.terminate();
`;

function compileEntry(directory: string, body: string): string {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    return compileSource(`${realm}${body}`, {
        fileName: join(directory, "entry.ts"),
    }).cpp;
}

test("authored form markup, its controls collection, entry list and links run natively", (t) => {
    const output = resolve("artifacts/dom-form-controls");
    const cpp = compileEntry(
        output,
        `
        const panel = document.createElement("div");
        panel.id = "panel";
        function install(name: string): void {
            panel.innerHTML = \`<h1>\${name}</h1><nav><a data-link="" href="/lite/page.html">Page</a></nav>
<form><label>View <select name="view"><option value="front">Front</option><option value="oblique" selected>Oblique</option></select></label>
<label>Depth <input name="depth" type="range" min="0" max="1" step="0.25" value="0.5"><output name="depthValue"></output></label>
<label>Flag <input name="flag" type="checkbox"></label>
<select name="off" disabled><option value="x">X</option></select></form><p class="status"></p>\`;
        }
        install(Math.random() > 2 ? "Alpha" : "Beta");
        document.body.appendChild(panel);
        const form = panel.querySelector("form")!;
        const status = panel.querySelector(".status") as HTMLElement;
        let steps = "";
        const record = (value: string): void => { steps += value; status.textContent = steps; };
        // A native form never submits; its submit listener is kept.
        form.addEventListener("submit", (event) => event.preventDefault());
        const view = form.elements.namedItem("view") as HTMLSelectElement;
        const depth = form.elements.namedItem("depth") as HTMLInputElement;
        const output = form.elements.namedItem("depthValue") as HTMLOutputElement;
        record(view.value === "oblique" && depth.value === "0.5" && form.elements.namedItem("missing") === null ? "N" : "n");
        output.value = depth.value;
        const data = new FormData(form);
        record(data.get("view") === "oblique" ? "V" : "v");
        record(data.get("depth") === "0.5" ? "D" : "d");
        // An output is no entry, nor an unchecked box or a disabled select.
        record(data.get("depthValue") === null && !data.has("flag") && !data.has("off") ? "E" : "e");
        for (const link of panel.querySelectorAll<HTMLAnchorElement>("[data-link]")) {
            const url = new URL(link.href);
            url.search = "view=front";
            link.href = url.href;
            record("|" + link.href);
        }
        globalThis.close();
    `,
    );
    for (const call of [
        "ui_form_named_item",
        "ui_form_entries",
        "hyperlink_href",
        "ui_set_link_navigation",
    ])
        assert.ok(
            cpp.includes(
                `bbl::${call.startsWith("hyper") ? "js::" : ""}${call}(`,
            ),
            call,
        );
    assert.match(cpp, /on_dom_pointer\([^;]*"submit"/);
    writeFileSync(join(output, "program.hpp"), cpp);
    runRmlUiFixture(t, "dom-form-controls", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
        },
    });
});

test("form markup, links and FormData refuse what a native form cannot hold", () => {
    const output = resolve("artifacts/dom-form-controls-refusals");
    const refusal = (body: string, pattern: RegExp): void =>
        assert.throws(() => compileEntry(output, body), pattern, body);
    refusal(
        `const host = document.createElement("div"); host.innerHTML = '<form><input name="q" type="text"></form>';`,
        /native forms never submit/,
    );
    refusal(
        `const host = document.createElement("div"); host.innerHTML = '<form><input name="q"></form>';`,
        /native forms never submit/,
    );
    refusal(
        `const host = document.createElement("div"); host.innerHTML = '<a href="/x.html" target="_blank">x</a><select><option>a</option></select>';`,
        /opens another browsing context/,
    );
    refusal(
        `const host = document.createElement("div"); host.innerHTML = '<form><select name="a"><option>a</option></select></form>';
         const form = host.querySelector("form")!; const data = new FormData(form, null);`,
        /FormData with a submitter/,
    );
    refusal(
        `const host = document.createElement("div");
         (host as unknown as HTMLFormElement).elements.namedItem("a");`,
        /not declared a <form>/,
    );
});

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const directory = resolve("artifacts/dom-transition-events");

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

test("transitionend dispatches from the UI projection with target, propertyName and removal", (t) => {
    const cpp = compileEntry(`
        const log = document.createElement("div");
        log.id = "log";
        document.body.appendChild(log);
        let order = "";
        function record(value: string): void { order += value; log.textContent = order; }
        const sheet = document.createElement("style");
        sheet.textContent = ".fade{opacity:1;transition:opacity 0.2s}.fade.is-hidden{opacity:0}.quick{transition:opacity 0.05s}";
        document.head.appendChild(sheet);
        const root = document.createElement("div");
        root.id = "root";
        root.className = "fade";
        const child = document.createElement("div");
        child.id = "child";
        child.className = "fade quick";
        root.appendChild(child);
        document.body.appendChild(root);
        const hide = (e?: TransitionEvent): void => {
            // A descendant's transition bubbles here too.
            if (e && (e.target !== root || e.propertyName !== "opacity")) {
                record("c");
                return;
            }
            root.removeEventListener("transitionend", hide);
            record(e ? "T" : "t");
        };
        root.addEventListener("transitionend", hide);
        document.addEventListener("transitionend", (event) => {
            if (event.target === child) record("D");
        }, { capture: true });
        globalThis.close();
    `);
    writeFileSync(join(directory, "program.hpp"), cpp);
    assert.match(cpp, /bbl::on_dom_transition\([^;]+"transitionend"/);
    assert.match(cpp, /bbl::off_dom_transition\([^;]+"transitionend"/);
    assert.match(cpp, /\.as<bbl::PlatformTransitionEvent>\(\)\.property_name/);
    runRmlUiFixture(t, "dom-transition-events", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
        },
    });
});

test("transition event handler properties and unrepresented fields refuse", () => {
    assert.throws(
        () =>
            compileEntry(`
        const panel = document.createElement("div");
        panel.ontransitionend = () => {};
    `),
        /'transitionend' has no native element listener/,
    );
    assert.throws(
        () =>
            compileEntry(`
        const panel = document.createElement("div");
        document.body.appendChild(panel);
        panel.addEventListener("transitionend", (event) => { panel.textContent = String(event.elapsedTime); });
    `),
        /do not expose 'elapsedTime'/,
    );
});

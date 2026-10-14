import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const directory = resolve("artifacts/dom-event-target-writes");

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

test("an event target narrowed to an element writes like the retained element it is", (t) => {
    const cpp = compileEntry(`
        const sheet = document.createElement("style");
        sheet.textContent = ".swatch{opacity:1;transition:opacity 0.1s}.open .swatch{opacity:0}.origin{opacity:1;transition:opacity 0.05s}.origin.open{opacity:0.5}";
        document.head.appendChild(sheet);
        const origin = document.createElement("div");
        origin.id = "origin";
        origin.className = "origin";
        function swatch(id: string, delay: string): void {
            const element = document.createElement("div");
            element.id = id;
            element.className = "swatch";
            element.style.transitionDelay = delay;
            origin.appendChild(element);
        }
        swatch("a", "20ms");
        swatch("b", "40ms");
        const button = document.createElement("button");
        button.id = "button";
        origin.appendChild(button);
        document.body.appendChild(origin);
        // One bubbling listener settles every control whose transition ends;
        // the origin's own transition is told apart by identity.
        origin.addEventListener("transitionend", (e) => {
            if (e.propertyName === "opacity" && e.target instanceof HTMLElement && e.target !== origin) {
                e.target.style.transitionDelay = "0ms";
                e.target.classList.add("settled");
                e.target.dataset.settled = e.propertyName;
            }
        });
        origin.addEventListener("click", (e) => {
            if (e.target instanceof Element && e.target !== e.currentTarget)
                e.target.setAttribute("aria-pressed", "true");
            if (e.currentTarget instanceof HTMLElement)
                e.currentTarget.dataset.last = e.target === e.currentTarget ? "self" : "bubbled";
        });
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        origin.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        globalThis.close();
    `);
    writeFileSync(join(directory, "program.hpp"), cpp);
    for (const write of [
        /bbl::ui_set_style_property\(bbl::dom_target_owner\([^;]+"transition-delay", "0ms"\)/,
        /bbl::ui_toggle_class\(bbl::dom_target_owner\([^;]+"settled", true\)/,
        /bbl::ui_set_attribute\(bbl::dom_target_owner\([^;]+"data-settled"/,
        /bbl::ui_set_attribute\(bbl::dom_target_owner\([^;]+"aria-pressed", "true"\)/,
        /bbl::ui_set_attribute\(bbl::dom_target_owner\([^;]+"data-last"/,
    ])
        assert.match(cpp, write);
    runRmlUiFixture(t, "dom-event-target-writes", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
        },
    });
});

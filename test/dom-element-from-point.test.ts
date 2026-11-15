import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("document.elementFromPoint answers what the display lays out at a point", (t) => {
    const directory = resolve("artifacts/dom-element-from-point");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        const panel = document.createElement("div");
        panel.id = "panel";
        panel.style.cssText = "position:absolute;left:20px;top:20px;width:200px;height:80px";
        const button = document.createElement("button");
        button.id = "button";
        button.style.cssText = "position:absolute;left:0;top:0;width:80px;height:40px";
        const ghost = document.createElement("div");
        ghost.id = "ghost";
        ghost.style.cssText = "position:absolute;left:0;top:0;width:200px;height:80px;pointer-events:none";
        button.addEventListener("click", () => { button.setAttribute("data-clicked", "yes"); });
        panel.appendChild(button);
        panel.appendChild(ghost);
        document.body.appendChild(panel);
        const log = document.createElement("div");
        log.id = "log";
        document.body.appendChild(log);
        function describe(target: Element | null): string {
            return target === null ? "null" : target === button ? "button" : target instanceof HTMLCanvasElement ? "canvas" : target.id || "?";
        }
        window.addEventListener("pointerdown", (event) => {
            const hit = document.elementFromPoint(event.clientX, event.clientY);
            // The listener runs after the realm's loop ended: it builds its report as text.
            let chain = "";
            for (let node: Element | null = hit; node; node = node.parentElement)
                chain += (chain === "" ? "" : ">") + describe(node);
            log.textContent = describe(hit) + "|" + describe(document.elementFromPoint(150, 60)) +
                "|" + describe(document.elementFromPoint(-1, 5)) +
                "|" + describe(document.elementFromPoint(300, 300)) +
                "|" + chain + "|" + String(hit === event.target);
        });
        globalThis.close();
    `,
        { fileName: join(directory, "entry.ts") },
    );
    assert.match(result.cpp, /bbl::ui_element_from_point\(/);
    for (const feature of ["ui:rml", "input:dom"])
        assert.ok(result.manifest.features.includes(feature), feature);
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "dom-element-from-point", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
        },
    });
});

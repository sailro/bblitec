import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {compileSource} from "../src/compiler.js";
import {runRmlUiFixture} from "./native-fixture.js";

test("generated DOM listeners receive retained SDL paths and control native defaults", t => {
    const directory = resolve("artifacts/dom-input");
    mkdirSync(directory, {recursive: true});
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(`
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        const log = document.createElement("div");
        log.id = "log";
        document.body.appendChild(log);
        let order = "";
        function record(value: string): void { order += value; log.textContent = order; }
        function current(event: Event): EventTarget | null { return event.currentTarget; }
        function mark(element: HTMLElement): void { element.setAttribute("data-target", "yes"); }
        const targets: EventTarget[] = [];
        const parent = document.createElement("div");
        parent.style.cssText = "position:absolute;left:20px;top:20px;width:200px;height:80px;pointer-events:auto";
        const button = document.createElement("button");
        button.id = "button";
        button.style.cssText = "position:absolute;left:0;top:0;width:80px;height:40px";
        button.textContent = "Press";
        parent.appendChild(button);
        document.body.appendChild(parent);
        document.addEventListener("pointerdown", event => {
            if (event.target !== button || event.currentTarget !== document) throw new Error("document event targets");
            if (current(event) !== document) throw new Error("base event target");
            if (event.target) targets.push(event.target);
            if (targets[0] !== button) throw new Error("stored target");
            mark(event.target as HTMLElement);
            if (event.type !== "pointerdown" || event.eventPhase !== 1 || event.pointerType !== "mouse" || !event.isPrimary)
                throw new Error("pointer fields");
            record("D");
        }, true);
        const options = {capture: false, once: true, passive: false};
        button.addEventListener("pointerdown", event => {
            if (event.currentTarget !== button) throw new Error("element current target");
            const target = event.currentTarget;
            if (target) target.addEventListener("pointerup", () => { button.setAttribute("data-up", "yes"); }, {once:true});
            record("P");
            event.preventDefault();
            if (!event.defaultPrevented || event.eventPhase !== 2) throw new Error("target cancellation");
        }, options);
        button.addEventListener("mousedown", () => { record("M"); });
        window.addEventListener("pointerdown", event => {
            if (event.currentTarget !== window) throw new Error("window current target");
            record("W");
        });
        const removed = () => { record("X"); };
        button.addEventListener("pointerdown", removed, {capture:true});
        button.removeEventListener("pointerdown", removed, true);
        button.addEventListener("click", () => { record("C"); }, {once:true});
        button.addEventListener("pointerout", event => {
            const related: EventTarget | null = event.relatedTarget;
            button.setAttribute("data-left", String(related === null));
        });
        window.addEventListener("keydown", event => {
            if (event.code === "Escape") { record("K"); event.preventDefault(); }
        });
        globalThis.close();
    `, {fileName:join(directory, "entry.ts")});
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    assert.throws(() => compileSource(`
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        const label = document.createElement("div");
        document.body.appendChild(label);
        label.addEventListener("click", () => { label.textContent += "clicked"; });
    `, {fileName:join(directory, "entry.ts")}), /Compound retained text assignments/);
    runRmlUiFixture(t, "dom-input");
});

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
        const parent = document.createElement("div");
        parent.style.cssText = "position:absolute;left:20px;top:20px;width:200px;height:80px;pointer-events:auto";
        const button = document.createElement("button");
        button.id = "button";
        button.style.cssText = "position:absolute;left:0;top:0;width:80px;height:40px";
        button.textContent = "Press";
        parent.appendChild(button);
        document.body.appendChild(parent);
        document.addEventListener("pointerdown", event => {
            if (event.type !== "pointerdown" || event.eventPhase !== 1 || event.pointerType !== "mouse" || !event.isPrimary)
                throw new Error("pointer fields");
            record("D");
        }, true);
        const options = {capture: false, once: true, passive: false};
        button.addEventListener("pointerdown", event => {
            record("P");
            event.preventDefault();
            if (!event.defaultPrevented || event.eventPhase !== 2) throw new Error("target cancellation");
        }, options);
        button.addEventListener("mousedown", () => { record("M"); });
        window.addEventListener("pointerdown", () => { record("W"); });
        const removed = () => { record("X"); };
        button.addEventListener("pointerdown", removed, {capture:true});
        button.removeEventListener("pointerdown", removed, true);
        button.addEventListener("click", () => { record("C"); }, {once:true});
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

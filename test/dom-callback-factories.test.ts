import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("callbacks passed through helpers keep per-evaluation identity and removal", (t) => {
    const directory = resolve("artifacts/dom-callback-factories");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        const target = document.createElement("button");
        document.body.appendChild(target);
        const log = document.createElement("div");
        log.id = "factory-log";
        document.body.appendChild(log);
        let calls = "";
        function wire(element: HTMLElement, callback: () => void): () => void {
            element.addEventListener("click", callback);
            element.addEventListener("click", callback);
            return () => element.removeEventListener("click", callback);
        }
        function install(element: HTMLElement, value: number): () => void {
            return wire(element, () => {
                calls += String(value);
            });
        }
        const removers: Array<() => void> = [];
        for (const value of [1, 2]) removers.push(install(target, value));
        const first = removers[0]!;
        const second = removers[1]!;
        target.click();
        if (calls !== "12") throw new Error("distinct creation, duplicate registration");
        first();
        target.click();
        if (calls !== "122") throw new Error("remove first identity");
        second();
        target.click();
        if (calls !== "122") throw new Error("remove second identity");
        const note = document.createElement("div");
        note.id = "void-note";
        document.body.appendChild(note);
        let labels = 0;
        function label(): string { labels++; return "label-" + labels; }
        const updates: Array<() => void> = [];
        function observe(callback: () => void): void { updates.push(callback); callback(); }
        observe(() => note.textContent = label());
        updates[0]!();
        if (labels !== 2) throw new Error("discarded assignment must evaluate its right side once per call");
        log.textContent = "complete";
        globalThis.close();
    `,
        { fileName: join(directory, "entry.ts") },
    );
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "dom-callback-factories");
});

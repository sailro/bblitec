import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("callbacks passed through helpers keep per-evaluation identity and removal", (t) => {
    const directory = resolve("artifacts/dom-callback-factories");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    writeFileSync(join(directory, "layout.ts"), `
        const first = [{name: "first"}, {name: "second"}];
        export const layout: readonly {name: string}[] = [...first, ...[3].map(value => ({name: String(value)}))];
    `);
    const result = compileSource(
        `
        import {layout} from "./layout.js";
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        await Promise.resolve();
        if (layout.length !== 3 || layout[2]!.name !== "3") throw new Error("module initialization before host coroutine");
        if (!document.getElementById("prebuilt")) throw new Error("host initialization before entry");
        const originalFetch = globalThis.fetch;
        const wrappedFetch: typeof fetch = async (input, init) => originalFetch.call(globalThis, input, init);
        globalThis.fetch = wrappedFetch;
        if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
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
        target.id = "first-target";
        const other = document.createElement("button");
        other.id = "second-target";
        document.body.appendChild(other);
        let lookups = 0;
        function element<T extends HTMLElement>(id: string): T {
            lookups++;
            const found = document.getElementById(id);
            if (!found) throw new Error("missing element");
            return found as T;
        }
        const bindings: readonly [string, () => void][] = [
            ["first-target", () => { calls += "A"; }],
            ["second-target", () => { calls += "B"; }],
        ];
        for (const [id, callback] of bindings) element(id).addEventListener("click", callback);
        const remove = () => {
            for (const [id, callback] of bindings) element(id).removeEventListener("click", callback);
        };
        target.click(); other.click();
        if (calls !== "122AB" || lookups !== 2) throw new Error("helper-return listeners");
        remove();
        target.click(); other.click();
        if (calls !== "122AB" || lookups !== 4) throw new Error("helper-return cleanup");
        let selectedId = "first-target";
        let receiverCalls = 0;
        let argumentCalls = 0;
        const late = () => { calls += "L"; };
        function receiver(): HTMLElement { receiverCalls++; return element(selectedId); }
        function callbackArgument(): () => void { argumentCalls++; selectedId = "second-target"; return late; }
        receiver().addEventListener("click", callbackArgument(), {once: true});
        other.click();
        target.click(); target.click();
        if (calls !== "122ABL" || receiverCalls !== 1 || argumentCalls !== 1) throw new Error("listener receiver snapshot");
        function optional(present: boolean): HTMLElement | null { receiverCalls++; return present ? target : null; }
        optional(false)?.addEventListener("click", callbackArgument());
        optional(false)?.removeEventListener("click", callbackArgument());
        if (receiverCalls !== 3 || argumentCalls !== 1) throw new Error("absent listener receiver");
        optional(true)?.addEventListener("click", late);
        target.click();
        optional(true)?.removeEventListener("click", late);
        target.click();
        if (calls !== "122ABLL" || receiverCalls !== 5) throw new Error("optional listener cleanup");
        let assignedCalls = 0;
        function assignedText(): string {
            assignedCalls++;
            selectedId = "first-target";
            return "assigned";
        }
        selectedId = "second-target";
        receiver().textContent = assignedText();
        if (assignedCalls !== 1 || receiverCalls !== 6)
            throw new Error("helper receiver assignment order");
        element("second-target").hidden = true;
        if (!other.hidden) throw new Error("helper hidden assignment");
        element("second-target").hidden = false;
        element("second-target").dataset.mode = "active";
        element("second-target").style.opacity = String(0.5);
        if (other.hidden || other.dataset.mode !== "active")
            throw new Error("helper DOM property assignment");
        log.textContent = "complete";
        globalThis.close();
    `,
        {
            fileName: join(directory, "entry.ts"),
            nativeHostUi: {
                sourcePath: "test/dom-callback-factories.test.ts",
                elements: [{tag: "div", attributes: {id: "prebuilt"}}],
            },
        },
    );
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "dom-callback-factories", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
        },
    });
});

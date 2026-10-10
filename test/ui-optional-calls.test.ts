import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("optional DOM calls snapshot the receiver and skip absent-call arguments", (t) => {
    const directory = resolve("artifacts/ui-optional-calls");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        let classSelected: HTMLDivElement | null = null;
        let classEffects = 0;
        function forcedClass(): boolean { classEffects++; classSelected = null; return true; }
        const updateClass = (): void => { classSelected?.classList.toggle("selected", forcedClass()); };
        updateClass();
        if (classEffects !== 0) throw new Error("absent class argument");
        const retained = document.createElement("div");
        classSelected = retained;
        updateClass();
        if (classEffects !== 1 || classSelected !== null || !retained.classList.contains("selected"))
            throw new Error("selected class receiver");
        classSelected?.classList.remove("selected");
        if (!retained.classList.contains("selected")) throw new Error("absent class removal");
        classSelected = retained;
        classSelected.classList.toggle("selected", forcedClass());
        if (classEffects !== 2 || !retained.classList.contains("selected"))
            throw new Error("direct class receiver");
        const classMap = new Map<string, HTMLElement>();
        let classMapKeys = 0;
        let classMapEffects = 0;
        function classMapKey(): string { classMapKeys++; return "selected"; }
        function forcedMapClass(): boolean {
            classMapEffects++;
            classMap.clear();
            return true;
        }
        classMap.get(classMapKey())?.classList.toggle("selected", forcedMapClass());
        if (classMapKeys !== 1 || classMapEffects !== 0)
            throw new Error("absent Map class argument");
        classMap.set("selected", retained);
        retained.classList.remove("selected");
        classMap.get(classMapKey())?.classList.toggle("selected", forcedMapClass());
        if (classMapKeys !== 2 || classMapEffects !== 1 || classMap.size !== 0 ||
            !retained.classList.contains("selected"))
            throw new Error("Map class receiver survives argument clear");
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        document.getElementById("host")?.remove();
        document.getElementById("host")?.remove();
        const parent = document.createElement("div");
        parent.id = "parent";
        document.body.append(parent);
        let calls = 0;
        let lookups = 0;
        interface View { node: HTMLElement | null; }
        const view: View = {node: parent};
        function child(): HTMLElement {
            calls++;
            view.node = null;
            const element = document.createElement("span");
            element.textContent = "child";
            return element;
        }
        function key(): string { lookups++; return "missing"; }
        const missing = document.getElementById(key())?.appendChild(child());
        if (missing !== undefined || calls !== 0 || lookups !== 1) throw new Error("absent receiver");
        const appended = view.node?.appendChild(child());
        if (!appended || calls !== 1 || view.node !== null) throw new Error("retained receiver");
        document.getElementById("missing")?.append(child());
        if (calls !== 1) throw new Error("lazy arguments");
        document.getElementById("parent")?.remove();
        document.getElementById("parent")?.remove();
        if (document.getElementById("parent")) throw new Error("remove");
        class Panel {
            node: HTMLElement | null = null;
            build(): void { this.node = document.createElement("div"); }
            child(): HTMLElement { this.node = null; return document.createElement("span"); }
            add(): void { this.node?.appendChild(this.child()); }
        }
        const panel = new Panel();
        panel.build();
        panel.add();
        let visits = 0;
        function visitor(element: Element, index: number): void {
            visits++;
            element.classList.toggle("active", index === 0);
        }
        class QueryPanel {
            node: HTMLElement | null = null;
            build(): void {
                this.node = document.createElement("div");
                const swatch = document.createElement("button");
                swatch.className = "swatch";
                this.node.appendChild(swatch);
            }
            visit(): void { this.node?.querySelectorAll(".swatch").forEach(visitor); }
        }
        const query = new QueryPanel();
        query.build();
        const selected = query.node?.querySelector(".swatch");
        if (!selected) throw new Error("query lookup lost its result");
        query.visit();
        if (visits !== 1) throw new Error("query continuation");
        query.node = null;
        query.visit();
        if (visits !== 1) throw new Error("absent query continuation");
        globalThis.close();
    `,
        {
            fileName: join(directory, "entry.ts"),
            nativeHostUi: {
                sourcePath: "test/ui-optional-calls.test.ts",
                elements: [{ tag: "div", attributes: { id: "host" } }],
            },
        },
    );
    assert.equal(result.cpp.match(/bbl::ui_query_element\(/g)?.length, 1);
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "ui-optional-calls", {
        macros: { BBLITE_WORKERS: 1, BBLITE_OFFSCREEN_SURFACES: 1 },
    });
});

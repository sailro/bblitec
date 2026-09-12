import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {runRmlUiFixture} from "./native-fixture.js";

test("optional DOM calls snapshot the receiver and skip absent-call arguments", t => {
    const directory = resolve("artifacts/ui-optional-calls");
    mkdirSync(directory, {recursive:true});
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(`
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
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
        query.visit();
        if (visits !== 1) throw new Error("query continuation");
        query.node = null;
        query.visit();
        if (visits !== 1) throw new Error("absent query continuation");
        globalThis.close();
    `, {fileName:join(directory, "entry.ts")});
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "ui-optional-calls");
});

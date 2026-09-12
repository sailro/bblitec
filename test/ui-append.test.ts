import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("DOM append preserves text, element order and argument evaluation", t => {
    const directory = resolve("artifacts/ui-append");
    mkdirSync(directory, {recursive:true});
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const source = `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        const panel = document.createElement("div");
        panel.id = "panel";
        panel.textContent = "prefix";
        const child = document.createElement("span");
        child.textContent = "child";
        let text = "first";
        function last(): string { text = "changed"; return "last"; }
        panel.append(text, child, last());
        document.body.append("root", panel);
        const ordered = document.createElement("div");
        ordered.id = "ordered";
        const other = document.createElement("div");
        other.id = "other";
        const first = document.createElement("span");
        first.textContent = "A";
        const second = document.createElement("span");
        second.textContent = "B";
        let selected = first;
        let destination = ordered;
        function chooseNext(): HTMLElement { selected = second; destination = other; return second; }
        destination.append(selected, chooseNext());
        document.body.append(ordered, other);
        type Direction = "east" | "west";
        const directions: (Direction | null)[] = ["east", null, "west"];
        for (const direction of directions) {
            child.dataset.direction = direction ?? "";
            if (child.dataset.direction !== (direction ?? "")) throw new Error("nullable dataset text");
            if (direction !== null) {
                child.setAttribute("data-label", direction);
                if (child.dataset.label !== direction) throw new Error("stored tag attribute text");
            }
        }
        globalThis.close();
    `;
    const result = compileSource(source, {fileName:join(directory, "entry.ts")});
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    assert.equal((result.cpp.match(/ui_append_text\(/g) ?? []).length, 3);
    runRmlUiFixture(t, "ui-append");
});

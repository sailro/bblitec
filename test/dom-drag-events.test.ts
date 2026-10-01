import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const directory = resolve("artifacts/dom-drag-events");

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

test("SDL file drops dispatch generated DOM listeners and bounded File snapshots", (t) => {
    const cpp = compileEntry(`
        const log = document.createElement("div");
        log.id = "log";
        document.body.appendChild(log);
        let order = "";
        function record(text: string): void { order += text; log.textContent = order; }
        const root = document.createElement("div");
        root.id = "root";
        root.style.cssText = "position:absolute;left:0;top:0;width:200px;height:100px";
        document.body.appendChild(root);
        const other = document.createElement("div");
        other.id = "other";
        other.style.cssText = "position:absolute;left:250px;top:0;width:200px;height:100px";
        document.body.appendChild(other);
        const enter = (raw: Event): void => {
            const event = raw as DragEvent;
            const transfer = event.dataTransfer;
            if (!transfer || transfer.files.length !== 0) throw new Error("protected files");
            if (event.clientY !== 20 || event.clientX < 0) throw new Error("coordinates");
            record(event.target === root ? "E" : "e");
        };
        document.addEventListener("dragenter", enter, {capture:true});
        root.ondragover = (event) => {
            event.preventDefault();
            if (!event.defaultPrevented) throw new Error("cancel");
            record("O");
        };
        other.addEventListener("dragover", (event) => {
            event.preventDefault();
            if (event.defaultPrevented) throw new Error("passive");
        }, {passive:true});
        root.ondragleave = (event) => {
            if (event.cancelable || !event.bubbles) throw new Error("leave flags");
            record("L");
        };
        const removed = (): void => { throw new Error("removed"); };
        window.addEventListener("drop", removed);
        window.removeEventListener("drop", removed);
        document.addEventListener("drop", (event) => {
            const first = event.dataTransfer?.files?.[0];
            if (!first || first.name !== "payload.txt" || first.size !== 5) throw new Error("metadata");
            record("C");
        }, {capture:true, once:true});
        root.ondrop = (event) => {
            const files = event.dataTransfer?.files;
            if (!files || files.length !== 2) throw new Error("count");
            const first = files[0];
            if (!first) throw new Error("first file");
            record(first.name + ":" + first.size);
            const reader = new FileReader();
            reader.onload = () => { record(":" + reader.result); };
            reader.readAsText(first);
            return false;
        };
        window.addEventListener("drop", (event) => {
            if (!event.defaultPrevented) throw new Error("handler cancellation");
            record("W");
        });
        globalThis.close();
    `);
    writeFileSync(join(directory, "program.hpp"), cpp);
    writeFileSync(join(directory, "payload.txt"), "hello");
    assert.match(cpp, /bbl::on_dom_drag/);
    assert.match(cpp, /bbl::off_dom_drag/);
    assert.match(cpp, /bbl::set_dom_drag_handler/);
    assert.match(cpp, /bbl::js::drag_files/);
    runRmlUiFixture(t, "dom-drag-events", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
            BBLITE_HAS_BROWSER_FILE: 1,
        },
    });
});

test("file drags refuse wider DataTransfer and FileList reads", () => {
    for (const [expression, refusal] of [
        ["event.dataTransfer?.items", /Native DataTransfer exposes only files/],
        ["event.dataTransfer?.files[1]", /only the first file at index 0/],
        [
            "event.dataTransfer?.files[0]?.lastModified",
            /Native File exposes name and size/,
        ],
    ] as const) {
        assert.throws(
            () =>
                compileEntry(`
            document.addEventListener("drop", (event) => { const value = ${expression}; });
        `),
            refusal,
        );
    }
});

test("authored drag events refuse instead of registering an inert custom channel", () => {
    for (const type of ["dragstart", "drag", "dragend"]) {
        assert.throws(() =>
            compileEntry(`
            document.addEventListener("${type}", () => {});
        `),
        );
    }
});

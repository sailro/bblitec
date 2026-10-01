import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const realm = `
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
    worker.terminate();
`;

function compileEntry(directory: string, body: string): string {
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    return compileSource(`${realm}${body}`, {
        fileName: join(directory, "entry.ts"),
    }).cpp;
}

test("element event handler properties, containment, connection and layout extents run natively", (t) => {
    const directory = resolve("artifacts/dom-element-surface");
    mkdirSync(directory, { recursive: true });
    const cpp = compileEntry(
        directory,
        `
        const log = document.createElement("div");
        log.id = "log";
        document.body.appendChild(log);
        let order = "";
        function record(value: string): void { order += value; log.textContent = order; }
        let bubble: HTMLDivElement | null = null;
        function hideBubble(): void { if (bubble) bubble.classList.remove("shown"); }
        if (typeof Element === "undefined" || typeof HTMLElement === "undefined") record("X");
        const button = document.createElement("button");
        button.id = "button";
        button.style.cssText = "position:absolute;left:0;top:0;width:80px;height:40px;padding:4px;border:3px solid black;box-sizing:content-box";
        let clicks = 0;
        button.addEventListener("click", () => record("A"));
        button.onclick = () => {
            record("H");
            button.onclick = () => { record("I"); button.onclick = null; };
        };
        button.addEventListener("click", () => {
            record("B");
            clicks++;
            if (clicks === 3) button.onclick = () => record("J");
        });
        button.onmouseenter = (event) => { if (event.target === button) record("M"); };
        const box = document.createElement("input");
        box.type = "checkbox";
        box.style.cssText = "position:absolute;left:200px;top:0;width:30px;height:30px;margin:0";
        box.onchange = () => record(box.checked ? "C" : "c");
        box.onchange = () => record(box.checked ? "D" : "d");
        box.addEventListener("blur", () => record("b"));
        const detached = document.createElement("span");
        document.body.append(button, box);
        record(button.isConnected && !detached.isConnected ? "1" : "0");
        record(document.body.contains(button) && !button.contains(document.body) && !button.contains(null) ? "2" : "0");
        record(button.id === "button" && button.hasAttribute("id") && button.getAttribute("title") === null ? "3" : "0");
        button.classList.add("one");
        record(button.classList.contains("one") && !button.classList.contains("two") ? "4" : "0");
        record(button.classList.toggle("two") && !button.classList.toggle("two") ? "5" : "0");
        box.focus();
        box.blur();
        const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        record(active === null ? "6" : "0");
        bubble = document.createElement("div");
        bubble.classList.add("shown");
        hideBubble();
        record(bubble.classList.contains("shown") ? "0" : "7");
        document.addEventListener("pointerdown", (event) => {
            if (event.target instanceof Element && event.target instanceof HTMLElement && button.contains(event.target as Node))
                record("P");
        }, {once: true});
        globalThis.close();
    `,
    );
    writeFileSync(join(directory, "program.hpp"), cpp);
    assert.doesNotMatch(cpp, /record\("X"\)|"X"/);
    assert.match(cpp, /bbl::set_dom_pointer_handler\([^;]+"click", \{\}\)/);
    assert.match(cpp, /bbl::ui_set_event_handler\([^;]+"change"/);
    assert.match(cpp, /bbl::dom_target_is_element\([^;]+, true\)/);
    runRmlUiFixture(t, "dom-element-surface", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
        },
    });
});

test("element layout extents read the retained client rectangle", () => {
    const directory = resolve("artifacts/dom-element-surface");
    mkdirSync(directory, { recursive: true });
    const cpp = compileEntry(
        directory,
        `
        const panel = document.createElement("div");
        document.body.appendChild(panel);
        void panel.offsetWidth;
        const size = panel.offsetHeight + panel.clientWidth + panel.clientHeight;
        panel.textContent = String(size);
        globalThis.close();
    `,
    );
    assert.match(
        cpp,
        /static_cast<void>\(std::round\(bbl::ui_get_client_rect\([^;]+\)\.offset_width\)\)/,
    );
    for (const field of ["offset_height", "width", "height"])
        assert.match(
            cpp,
            new RegExp(
                `std::round\\(bbl::ui_get_client_rect\\([^;]+\\)\\.${field}\\)`,
            ),
        );
});

test("element event handler properties refuse what they cannot represent", () => {
    const directory = resolve("artifacts/dom-element-surface");
    mkdirSync(directory, { recursive: true });
    const refusal = (body: string, pattern: RegExp): void =>
        assert.throws(() => compileEntry(directory, body), pattern);
    refusal(
        `const button = document.createElement("button");
         button.onclick = () => false;`,
        /cannot return false/,
    );
    refusal(
        `const panel = document.createElement("div");
         panel.onscroll = () => {};`,
        /'scroll' has no native element listener/,
    );
    refusal(
        `const panel = document.createElement("div");
         panel.append("text");
         const value = panel.getAttribute("title");
         const other = document.querySelector("div")?.getAttribute("title");`,
        /optional getAttribute call/,
    );
});

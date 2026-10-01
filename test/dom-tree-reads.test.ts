import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { cppFunction, runRmlUiFixture } from "./native-fixture.js";

const directory = resolve("artifacts/dom-tree-reads");

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

test("element tree, text, editability, selection and narrowed event reads run natively", (t) => {
    const cpp = compileEntry(`
        const log = document.createElement("div");
        log.id = "log";
        document.body.appendChild(log);
        let order = "";
        function record(value: string): void { order += value; log.textContent = order; }
        const panel = document.createElement("div");
        panel.style.cssText = "position:absolute;left:0;top:0;width:400px;height:300px";
        const close = document.createElement("button");
        const label = document.createElement("span");
        label.textContent = "Close";
        close.append("x", label, "!");
        const note = document.createElement("p");
        note.textContent = "note";
        panel.append(close, note);
        document.body.appendChild(panel);
        if (close.parentElement !== panel || panel.parentElement !== document.body) throw new Error("parent");
        if (document.documentElement.parentElement !== null) throw new Error("root parent");
        if (close.firstElementChild !== label || close.lastElementChild !== label) throw new Error("children skip text");
        const detached = document.createElement("i");
        if (label.firstElementChild !== null || detached.parentElement !== null) throw new Error("absent");
        if (close.nextElementSibling !== note || note.previousElementSibling !== close) throw new Error("siblings");
        if (close.previousElementSibling !== null || note.nextElementSibling !== null) throw new Error("ends");
        if (close.textContent !== "xClose!" || panel.textContent !== "xClose!note") throw new Error("text");
        function topSurface(element: HTMLElement): HTMLElement {
            let surface = element;
            while (surface.parentElement && surface.parentElement !== document.body) surface = surface.parentElement;
            return surface;
        }
        if (topSurface(label) !== panel) throw new Error("walk");
        const rows: { label: string }[] = [];
        for (const name of ["a", "b"]) rows.push({ label: name.toUpperCase() });
        const list = document.createElement("div");
        for (const row of rows) {
            const value = document.createElement("b");
            value.textContent = "=";
            list.append(row.label, value);
        }
        if (list.textContent !== "A=B=") throw new Error("data text append");
        const strip = document.createElement("div");
        const first = document.createElement("i");
        const second = document.createElement("b");
        strip.append("tail");
        strip.prepend(first, "mid");
        if (strip.firstElementChild !== first || strip.textContent !== "midtail") throw new Error("prepend");
        strip.prepend(second, first);
        if (strip.firstElementChild !== second || second.nextElementSibling !== first) throw new Error("prepend moves");
        strip.replaceChildren(first, "only");
        if (strip.lastElementChild !== first || strip.textContent !== "only" || second.parentElement !== null)
            throw new Error("replaceChildren");
        const pause = close.lastElementChild as HTMLElement;
        pause.textContent = "Pause";
        if (close.textContent !== "xPause!") throw new Error("asserted child");
        const up = document.createElement("button");
        up.disabled = true;
        const down = document.createElement("button");
        function blocked(direction: number): boolean { return (direction > 0 ? up : down).disabled; }
        if (!blocked(1) || blocked(-1)) throw new Error("conditional owner");
        const editor = document.createElement("div");
        editor.setAttribute("contenteditable", "");
        editor.style.cssText = "position:absolute;left:0;top:100px;width:200px;height:60px";
        const inner = document.createElement("span");
        inner.id = "inner";
        inner.style.cssText = "display:block;width:200px;height:30px;pointer-events:auto";
        const frozen = document.createElement("span");
        frozen.setAttribute("contenteditable", "False");
        editor.append(inner, frozen);
        panel.appendChild(editor);
        if (!inner.isContentEditable || frozen.isContentEditable || panel.isContentEditable) throw new Error("editable");
        const field = document.createElement("input");
        field.id = "field";
        field.value = "hello";
        panel.appendChild(field);
        field.focus();
        field.select();
        const isNode = (target: EventTarget | null): boolean => target instanceof Node;
        if (!isNode(panel) || isNode(null)) throw new Error("node");
        // A stored Event listener sees its payload through the base view.
        interface Escape { readonly onKeyDown: (event: Event) => void }
        const escapes = new Map<string, Escape>();
        function escapeFor(key: string): Escape {
            const existing = escapes.get(key);
            if (existing) return existing;
            const onKeyDown = (raw: Event): void => {
                const event = raw as KeyboardEvent;
                if (event.key !== "Escape") return;
                const target = event.target;
                record(target instanceof Node && !(target instanceof HTMLElement && target.isContentEditable) ? "K" : "k");
            };
            const created: Escape = { onKeyDown };
            escapes.set(key, created);
            return created;
        }
        window.addEventListener("keydown", escapeFor("window").onKeyDown, { capture: true });
        document.addEventListener("pointerdown", (event) => {
            const target = event.target;
            if (target instanceof HTMLElement && target.isContentEditable) record("E");
        });
        const visibility = { isVisible: () => document.visibilityState === "visible" };
        if (!visibility.isVisible() || document.hidden) throw new Error("initial visibility");
        document.addEventListener("visibilitychange", () => {
            record(document.visibilityState === "hidden" && !visibility.isVisible() ? "H" : "V");
        });
        record("1");
        globalThis.close();
    `);
    writeFileSync(join(directory, "program.hpp"), cpp);
    writeFileSync(
        join(directory, "visibility.hpp"),
        "namespace bbl {\n" +
            cppFunction(
                readFileSync("src/lowering/scene-lowerer.ts", "utf8"),
                "void on_visibility_change(",
            ) +
            "\n}",
    );
    assert.match(cpp, /bbl::ui_tree_element\([^;]+bbl::UiTreeRead::Parent\)/);
    assert.match(cpp, /bbl::ui_text_content\(/);
    assert.match(cpp, /bbl::ui_is_content_editable\(/);
    assert.match(cpp, /bbl::dom_target_is_content_editable\(/);
    assert.match(cpp, /bbl::ui_select_text\(/);
    assert.match(cpp, /bbl::ui_first_child_node\(/);
    assert.match(cpp, /bbl::dom_target_is_node\(/);
    assert.match(cpp, /\.as<bbl::PlatformKeyboardEvent>\(\)\.key/);
    assert.match(cpp, /window_document_engine\(\)\.document_hidden/);
    runRmlUiFixture(t, "dom-tree-reads", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
        },
    });
});

test("element tree reads refuse unrepresented owners", () => {
    assert.throws(
        () =>
            compileEntry(`
        const sheet = document.createElement("style");
        document.head.appendChild(sheet);
        const view = document.createElement("div");
        view.textContent = sheet.textContent;
    `),
        /retained <style> element's textContent/,
    );
});

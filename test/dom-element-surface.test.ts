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

const directory = resolve("artifacts/dom-element-surface");

function compileEntry(body: string): string {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    return compileSource(`${realm}${body}`, {
        fileName: join(directory, "entry.ts"),
    }).cpp;
}

test("element event handler properties, containment, connection and layout extents run natively", (t) => {
    const cpp = compileEntry(
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
        // Each handler replaces or removes itself during its own dispatch.
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
        const guard = document.createElement("input");
        guard.type = "checkbox";
        guard.id = "guard";
        guard.style.cssText = "position:absolute;left:300px;top:0;width:30px;height:30px;margin:0";
        guard.onclick = () => { record("g"); return false; };
        guard.onchange = () => record("G");
        const detached = document.createElement("span");
        document.body.append(button, box, guard);
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
    assert.doesNotMatch(cpp, /"X"/);
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

test("element layout extents and rectangles read the retained border box", () => {
    const cpp = compileEntry(
        `
        const panel = document.createElement("div");
        document.body.appendChild(panel);
        void panel.offsetWidth;
        const size = panel.offsetHeight + panel.clientWidth + panel.clientHeight + panel.getBoundingClientRect().width;
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
    assert.match(cpp, /v_bblite_ui_rect_\d+\.offset_width/);
});

test("record-field controls take their declared interface's tag", () => {
    const cpp = compileEntry(`
        const fields: { input: HTMLInputElement } = { input: document.createElement("input") };
        fields.input.type = "range";
        fields.input.min = "1";
        fields.input.addEventListener("change", () => { fields.input.max = fields.input.min; });
        fields.input.oninput = () => { document.title = fields.input.value; };
        document.body.appendChild(fields.input);
        globalThis.close();
    `);
    assert.match(cpp, /bbl::ui_set_attribute\([^;]+"min"/);
    assert.match(cpp, /bbl::ui_on_event\([^;]+"change"/);
    assert.match(cpp, /bbl::ui_set_event_handler\([^;]+"input"/);
});

test("element event handler properties refuse what they cannot represent", () => {
    const refusal = (body: string, pattern: RegExp): void =>
        assert.throws(() => compileEntry(body), pattern);
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

test("Window observer presence guards select the constructed observer", () => {
    const cpp = compileEntry(
        `
        const panel = document.createElement("div");
        document.body.appendChild(panel);
        const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => { panel.textContent = "resized"; });
        resize?.observe(panel);
        const mutation = typeof MutationObserver === "function" ? new MutationObserver(() => {}) : null;
        mutation?.observe(panel, { attributes: true });
        globalThis.close();
    `,
    );
    assert.match(cpp, /bbl::pal::create_resize_observer\(/);
    assert.match(cpp, /->observe\(/);
    assert.match(cpp, /bbl::pal::create_mutation_observer\(/);
});

test("replaceChildren and append insert nodes, text and spread element lists in order", (t) => {
    const output = resolve("artifacts/dom-child-replacement");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "worker.ts"), "self.close();");
    const { cpp } = compileSource(
        `${realm}
        const log = document.createElement("div");
        log.id = "log";
        document.body.appendChild(log);
        let steps = "";
        function record(value: string): void { steps += (steps ? "|" : "") + value; log.textContent = steps; }
        const list = document.createElement("div");
        list.id = "list";
        document.body.appendChild(list);
        const items: HTMLElement[] = [];
        const rest: HTMLElement[] = [];
        for (const name of ["a", "b", "c"]) {
            const item = document.createElement("span");
            item.id = name;
            items.push(item);
            if (name !== "a") rest.push(item);
        }
        const first = items[0]!;
        list.append(...items);
        record(list.contains(items[2]!) ? "3" : "0");
        list.replaceChildren(first, "x", ...rest);
        record(list.contains(first) && list.contains(rest[1]!) ? "1x3" : "0");
        const icon = document.createElement("span");
        icon.id = "icon";
        list.replaceChildren(icon);
        record(!list.contains(first) && list.contains(icon) ? "1" : "0");
        const changing: HTMLElement[] = items.slice();
        function mutateItems(): string {
            changing.pop();
            return "tail";
        }
        list.replaceChildren(...changing, mutateItems());
        record(list.contains(rest[1]!) ? "S" : "s");
        list.replaceChildren(...items, icon);
        record(list.contains(first) && list.contains(icon) ? "4" : "0");
        const input = document.createElement("input");
        input.id = "input";
        document.body.appendChild(input);
        input.focus({ preventScroll: true });
        record(document.activeElement === input ? "F" : "f");
        input.blur();
        input.focus({ focusVisible: false });
        let visible = input.isConnected;
        function clearVisible(): boolean { visible = false; return true; }
        input.focus({ focusVisible: visible, preventScroll: clearVisible() });
        globalThis.close();
    `,
        { fileName: join(output, "entry.ts") },
    );
    writeFileSync(join(output, "program.hpp"), cpp);
    runRmlUiFixture(t, "dom-child-replacement", {
        macros: { BBLITE_WORKERS: 1, BBLITE_OFFSCREEN_SURFACES: 1 },
    });
});

test("focus options refuse what native focus cannot represent", () => {
    assert.throws(
        () =>
            compileEntry(`
                const input = document.createElement("input");
                document.body.appendChild(input);
                input.focus({ preventScroll: true, scrollIntoView: true } as FocusOptions);
                globalThis.close();
            `),
        /focus options represent preventScroll and focusVisible only/,
    );
});

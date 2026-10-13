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
    assert.match(cpp, /bbl::set_dom_pointer_handler\([^;]+"change"/);
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
    assert.match(cpp, /bbl::on_dom_pointer\([^;]+"change"/);
    assert.match(cpp, /bbl::set_dom_pointer_handler\([^;]+"input"/);
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

test("focus options retain absent dictionaries, stored flags and evaluation order", (t) => {
    const output = resolve("artifacts/dom-focus-options");
    mkdirSync(output, { recursive: true });
    const { cpp } = compileSource(`
        interface Options extends FocusOptions { focusVisible?: boolean; }
        const input = document.createElement("input");
        input.id = "target";
        document.body.appendChild(input);
        function focus(options?: Options): void { input.blur(); input.focus(options); }
        focus();
        const stored: Options = { focusVisible: false, preventScroll: true };
        focus(stored);
        stored.focusVisible = true;
        focus(stored);
        stored.focusVisible = undefined;
        focus(stored);
        let effects = 0;
        function absent(): undefined { effects++; return undefined; }
        focus(absent());
        const choices = new Map<string, Options>();
        choices.set("hidden", { focusVisible: false });
        focus(choices.get("missing"));
        focus(choices.get("hidden"));
        let visible = input.isConnected;
        function change(): boolean { effects++; visible = false; return true; }
        focus({ focusVisible: visible, preventScroll: change() });
        focus({ focusVisible: absent() });
        focus({ ignored: change(), focusVisible: false } as Options);
        if (effects !== 4) throw new Error("option effects");
        const missing = document.querySelector("#missing");
        missing?.focus(absent());
        if (effects !== 4) throw new Error("absent receiver evaluated options");
        function stringFlag(value: string | undefined): void {
            input.blur();
            input.focus({ focusVisible: value });
        }
        stringFlag(undefined);
        stringFlag("");
        stringFlag("visible");
        globalThis.close();
    `);
    writeFileSync(join(output, "program.hpp"), cpp);
    runRmlUiFixture(t, "dom-focus-options", {
        macros: { BBLITE_WORKERS: 1, BBLITE_OFFSCREEN_SURFACES: 1 },
    });
});

test("focus options refuse unrepresented getters and non-record values", () => {
    assert.throws(
        () =>
            compileEntry(`
                const input = document.createElement("input");
                document.body.appendChild(input);
                input.focus({ get focusVisible() { return true; } } as FocusOptions);
                globalThis.close();
            `),
        /Focus options require named data properties/,
    );
    assert.throws(
        () =>
            compileEntry(`
            const input = document.createElement("input");
            let reads = 0;
            const options = { get focusVisible() { reads++; return false; } };
            input.focus(options);
        `),
        /Focus options require named data properties/,
    );
    assert.throws(
        () =>
            compileEntry(
                `const input = document.createElement("input"); input.focus(3 as FocusOptions);`,
            ),
        /Focus options require a represented options record/,
    );
});

test("tab order, sibling insertion, replacement, scroll requests and event paths run natively", (t) => {
    const output = resolve("artifacts/dom-element-order");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "worker.ts"), "self.close();");
    const result = compileSource(
        `${realm}
        const log = document.createElement("div");
        log.id = "log";
        document.body.appendChild(log);
        let steps = "";
        function record(value: string): void { steps += value; log.textContent = steps; }
        function item(id: string): HTMLElement {
            const node = document.createElement("span");
            node.id = id;
            return node;
        }
        const list = document.createElement("div");
        list.id = "list";
        document.body.appendChild(list);
        const a = item("a"), b = item("b"), c = item("c"), x = item("x");
        list.append(a, b, c);
        b.replaceWith(x);
        x.replaceWith(c, x);
        const kept = item("kept");
        list.append(kept);
        const detached = item("detached");
        detached.replaceWith(kept);
        record(kept.parentElement === list ? "R" : "r");
        a.insertAdjacentElement("beforebegin", item("d"));
        const e = item("e");
        record(a.insertAdjacentElement("afterend", e) === e ? "A" : "a");
        list.insertAdjacentElement("afterBegin", item("f"));
        list.insertAdjacentElement("beforeend", item("g"));
        const orphan = item("orphan");
        record(orphan.insertAdjacentElement("afterend", item("h")) === null ? "N" : "n");
        try { a.insertAdjacentElement("middle", item("i")); } catch { record("S"); }
        try { list.insertAdjacentElement("afterbegin", list); } catch { record("H"); }
        const first = document.createElement("button");
        first.id = "first";
        first.textContent = "1";
        const panel = document.createElement("div");
        panel.id = "panel";
        panel.textContent = "2";
        const skipped = document.createElement("button");
        skipped.id = "skipped";
        skipped.textContent = "3";
        const last = document.createElement("div");
        last.id = "last";
        last.textContent = "4";
        document.body.append(first, panel, skipped, last);
        record(first.tabIndex === 0 && panel.tabIndex === -1 ? "D" : "d");
        panel.tabIndex = 0;
        skipped.tabIndex = 4294967295;
        record(skipped.tabIndex === -1 && skipped.getAttribute("tabindex") === "-1" ? "W" : "w");
        let order = "";
        function selected(): HTMLElement { order += "r"; return last; }
        function index(): number { order += "v"; return 0; }
        selected().tabIndex = index();
        try { last.tabIndex = steps.length; } catch { record("Q"); }
        record(order === "rv" && last.getAttribute("tabindex") === "0" ? "O" : "o");
        window.addEventListener("keydown", (event) => {
            if (event.key === "Tab") record(event.composedPath().includes(panel) ? "P" : "p");
        }, { capture: true });
        first.focus();
        const scroller = document.createElement("div");
        scroller.id = "scroller";
        scroller.style.cssText = "position:absolute;left:300px;top:0;width:100px;height:40px;overflow-y:scroll;";
        const rows: HTMLElement[] = [];
        for (const id of ["row0", "row1", "row2", "row3", "row4"]) {
            const row = document.createElement("div");
            row.id = id;
            row.style.cssText = "height:30px;";
            scroller.append(row);
            rows.push(row);
        }
        document.body.append(scroller);
        function motion(): boolean { return steps.length < 0; }
        rows[2]!.scrollIntoView?.({ block: "center", behavior: motion() ? "smooth" : "auto" });
        rows[3]!.scrollIntoView({ block: "end" });
        log.scrollIntoView(false);
        function bad(): ScrollLogicalPosition { return (steps.length > 0 ? "middle" : "start") as ScrollLogicalPosition; }
        try { rows[0]!.scrollIntoView({ inline: bad() }); } catch { record("T"); }
        document.addEventListener("ping", (event) => record(event.composedPath().length === 2 ? "C" : "c"));
        document.dispatchEvent(new CustomEvent("ping"));
        first.addEventListener("click", (event) => record(event.composedPath().includes(first) ? "M" : "m"));
        first.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        globalThis.close();
    `,
        { fileName: join(output, "entry.ts") },
    );
    assert.equal(result.manifest.deferredCapabilities, undefined);
    assert.ok(result.manifest.features.includes("input:dom"));
    for (const call of [
        "ui_replace_with",
        "ui_insert_adjacent_element",
        "ui_scroll_into_view",
        "ui_set_tab_index",
        "ui_tab_index",
        "dom_event_composed_path",
    ])
        assert.ok(result.cpp.includes(`bbl::${call}(`), call);
    writeFileSync(join(output, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "dom-element-order", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
        },
    });
});

test("element surface writes refuse forms native order cannot hold", () => {
    const refusal = (body: string, pattern: RegExp): void =>
        assert.throws(() => compileEntry(body), pattern, body);
    refusal(
        `const panel = document.createElement("div"); panel.tabIndex = 2;`,
        /Positive tabIndex values are not supported/,
    );
    refusal(
        `const canvas = document.createElement("canvas"); canvas.tabIndex = -1;`,
        /A native canvas keeps tabIndex 0/,
    );
    refusal(
        `const panel = document.createElement("div"); const where = panel.id as InsertPosition;
         panel.insertAdjacentElement(where, document.createElement("span"));`,
        /insertAdjacentElement requires a literal position/,
    );
    refusal(
        `const panel = document.createElement("div"); panel.replaceWith("text");`,
        /replaceWith text arguments are not represented/,
    );
});

test("static innerHTML form controls own state, listeners and queries as created elements", (t) => {
    const output = resolve("artifacts/dom-authored-markup");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "worker.ts"), "self.close();");
    const result = compileSource(
        `${realm}
        const panel = document.createElement("div");
        panel.id = "panel";
        panel.innerHTML = \`
            <div class="title">Look &amp; feel</div>
            <div class="drop">Drop <b>.cube</b> files</div>
            <div class="list"><span>old</span></div>
            <label class="row"><span>Strength</span><input class="strength" type="range" min="0" max="1" step="0.25" value="0.5"><span class="readout"></span></label>
            <div class="keep-row">
                <select class="slot">
                    <option value="a.cube">first</option>
                    <option value="b.cube" selected>second</option>
                </select>
                <button class="keep" type="button" style="position:absolute;left:0;top:200px;width:80px;height:30px">Keep</button>
                <input class="flag" type="checkbox" checked>
            </div>
            <div class="status"></div>\`;
        document.body.appendChild(panel);
        const list = panel.querySelector(".list") as HTMLElement;
        const strength = panel.querySelector(".strength") as HTMLInputElement;
        const readout = panel.querySelector(".readout") as HTMLElement;
        const slot = panel.querySelector(".slot") as HTMLSelectElement;
        const keep = panel.querySelector(".keep") as HTMLButtonElement;
        const flag = panel.querySelector(".flag") as HTMLInputElement;
        const status = panel.querySelector(".status") as HTMLElement;
        let steps = "";
        function record(value: string): void { steps += value; status.textContent = steps; }
        record(strength.value === "0.5" && slot.value === "b.cube" && flag.checked ? "D" : "d");
        strength.id = "strength";
        keep.id = "keep";
        strength.addEventListener("input", () => {
            readout.textContent = Number(strength.value).toFixed(2);
            record("I");
        });
        keep.addEventListener("click", () => { keep.disabled = true; record("K"); });
        list.innerHTML = "";
        const entry = document.createElement("button");
        entry.textContent = "entry";
        list.appendChild(entry);
        record(list.childElementCount === 1 && entry.parentElement === list ? "L" : "l");
        slot.value = "a.cube";
        flag.checked = false;
        record(slot.value === "a.cube" && !flag.checked ? "W" : "w");
        strength.focus();
        globalThis.close();
    `,
        { fileName: join(output, "entry.ts") },
    );
    assert.equal(result.manifest.deferredCapabilities, undefined);
    assert.ok(
        !result.cpp.includes("<select"),
        "controls are not projected markup",
    );
    writeFileSync(join(output, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "dom-authored-markup", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
        },
    });
});

test("innerHTML form controls refuse markup retained elements cannot hold", () => {
    const refusal = (markup: string, pattern: RegExp): void =>
        assert.throws(
            () =>
                compileEntry(
                    `const host = document.createElement("div"); host.innerHTML = ${JSON.stringify(markup)};`,
                ),
            pattern,
            markup,
        );
    refusal('<input type="file">', /<input> type 'file' is not represented/);
    refusal("<select><!-- x --><option>a</option></select>", /has comments/);
    refusal("<select>a<option>b</option></select>", /holds only options/);
    refusal('<input onclick="run()">', /attribute 'onclick' is not supported/);
    refusal("<select><option>a</select>", /mismatched closing tag/);
    refusal("<textarea>text</textarea>", /textarea content is not represented/);
    refusal('<img src="a.png"><input type="text">', /not <img>/);
    assert.throws(
        () =>
            compileEntry(
                `const host = document.createElement("div"); const kind = host.id;
                 host.innerHTML = "<input type=\\"" + kind + "\\">";`,
            ),
        /form control <input> requires static markup assigned to innerHTML/,
    );
});

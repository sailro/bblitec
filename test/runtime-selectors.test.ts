import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { runRmlUiFixture } from "./native-fixture.js";

/** The selector shapes a real application builds at runtime, on retained elements. */
const applicationShapes = `
    const panel = document.createElement("div");
    document.body.appendChild(panel);
    const holder = document.createElement("div");
    function runtime(value: string): string {
        holder.setAttribute("data-value", value);
        return holder.getAttribute("data-value") ?? "";
    }
    function highlight(name: string): void {
        const row = document.querySelector<HTMLElement>(\`[data-row="\${name}"]\`);
        if (!row) return;
        row.classList.remove("lit");
    }
    highlight(runtime("first"));
    const doc: Document | null = panel.hasAttribute("data-offline") ? null : document;
    if (!doc || doc.querySelector(\`script[data-tag="\${runtime("t-1")}"]\`)) panel.remove();
    const item = { id: runtime("one") };
    (panel.querySelector(\`[data-item="\${item.id}"]\`) as HTMLElement | null)?.focus();
    const section = runtime("two");
    panel.querySelector<HTMLButtonElement>(\`[data-section="\${section}"]\`)?.focus({ preventScroll: true });
    const key = runtime("b");
    const button = panel.querySelector<HTMLElement>(\`[data-key="\${key}"]\`);
    if (button && !(button as HTMLButtonElement).disabled) button.click();
    const step = document.createElement("button");
    step.dataset.step = "2";
    panel.appendChild(step);
    const group = document.activeElement === step ? step.closest(".group") : null;
    const rebuilt = group?.querySelector<HTMLElement>(\`.page[data-step="\${step.dataset.step}"]\`);
    if (rebuilt && rebuilt !== step) rebuilt.focus({ preventScroll: true });
    const alternate = step.hasAttribute("data-alternate");
    const scope = alternate ? ".mark.mark--alternate.is-on" : ".mark:not(.mark--alternate).is-on";
    panel.querySelectorAll(scope).forEach((el) => el.classList.remove("is-on"));
    function reachable(element: HTMLElement): boolean {
        return !(element.tabIndex < 0 || element.matches(":disabled") || element.closest("[hidden], [inert]"));
    }
    function pointerRests(region: Element | null): boolean {
        if (!region) return false;
        return region.matches(":hover");
    }
    const hovered = panel.querySelector(".zone")?.matches(":hover") ?? false;
    if (reachable(step) && !pointerRests(panel) && !hovered && (panel as HTMLElement).matches(":hover")) step.remove();
`;

test("runtime selector text and interaction states lower natively in strict and deferred mode", () => {
    for (const options of [
        {},
        { deferredCapabilities: "runtime-throw" as const },
    ]) {
        const result = compileSource(applicationShapes, options);
        assert.equal(result.manifest.deferredCapabilities, undefined);
        // One checked attribute value per template site.
        assert.equal(result.cpp.match(/bbl::ui_selector_value\(/g)?.length, 6);
        assert.match(
            result.cpp,
            /bbl::ui_selector_choice\(v_scope, \{"\.mark\.mark--alternate\.is-on", "\.mark:not\(\.mark--alternate\)\.is-on"\}\)/,
        );
        assert.match(result.cpp, /bbl::UiSelectorTestKind::Hover/);
        assert.match(result.cpp, /bbl::UiSelectorTestKind::Disabled/);
    }
    const preamble = `const root = document.createElement("div"); document.body.appendChild(root);
        const name = root.getAttribute("data-name") ?? "";`;
    for (const [query, refusal] of [
        [
            "root.querySelector(`#${name}`)",
            /template '#\$\{…\}' is not lowered: runtime text is admitted only inside a quoted attribute value/,
        ],
        [
            "root.querySelector(`[data-x=${name}]`)",
            /runtime text is admitted only inside a quoted attribute value/,
        ],
        [
            'root.querySelector(`.a::before[data-x="${name}"]`)',
            /it is not admitted by the retained selector grammar/,
        ],
        [
            "root.querySelector(name)",
            /Retained DOM query selectors must be literal, a template whose runtime text fills quoted attribute values, or a union of at most 32 literal selectors/,
        ],
        [
            'root.querySelector(name ? ".a" : ":scope > .a")',
            /Retained DOM query selector ':scope > \.a' is not lowered/,
        ],
    ] as const)
        for (const options of [
            {},
            { deferredCapabilities: "runtime-throw" as const },
        ])
            assert.throws(
                () => compileSource(`${preamble} ${query};`, options),
                refusal,
                query,
            );
});

test("authored Document-shaped objects retain their own query methods", () => {
    const result = compileSource(
        `
        const doc = { querySelector(selector: string): string { return selector + "!"; } };
        if (doc.querySelector("value") !== "value!") throw new Error("authored query");
    `,
        { deferredCapabilities: "runtime-throw" },
    );
    assert.equal(result.manifest.deferredCapabilities, undefined);
});

test("runtime selectors match, order and throw as the browser; document states read live", (t) => {
    const directory = resolve("artifacts/runtime-selectors");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        let log = "";
        let order = "";
        function note(text: string): void { log += text; }
        const panel = document.createElement("div");
        panel.id = "panel";
        document.body.appendChild(panel);
        const holder = document.createElement("div");
        function runtime(value: string): string {
            holder.setAttribute("data-value", value);
            return holder.getAttribute("data-value") ?? "";
        }
        const alpha = document.createElement("button");
        alpha.className = "row";
        alpha.setAttribute("data-row", "alpha");
        const quoted = document.createElement("button");
        quoted.className = "row secondary";
        quoted.setAttribute("data-row", "it's");
        const page = document.createElement("span");
        page.className = "page";
        page.dataset.pageStep = "2";
        const off = document.createElement("button");
        off.disabled = true;
        off.setAttribute("data-shortcut", "7");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = true;
        panel.appendChild(alpha);
        panel.appendChild(quoted);
        panel.appendChild(page);
        panel.appendChild(off);
        panel.appendChild(box);

        if (document.querySelector<HTMLElement>(\`[data-row="\${runtime("alpha")}"]\`) === alpha) note("a");
        if (panel.querySelector(\`button[data-row="\${runtime("it's")}"]\`) === quoted) note("b");
        const group = alpha.closest("#panel") as HTMLElement | null;
        if (group?.querySelector<HTMLElement>(\`.page[data-page-step="\${page.dataset.pageStep}"]\`) === page) note("c");
        // An absent optional receiver evaluates no selector text.
        function counted(): string { order += "X"; return "alpha"; }
        const absent = alpha.closest(".missing") as HTMLElement | null;
        if ((absent?.querySelector(\`[data-row="\${counted()}"]\`) ?? null) === null && order === "") note("d");
        // The receiver evaluates before the selector text, each once.
        function receiver(): HTMLElement { order += "R"; return panel; }
        function text(): string { order += "T"; return runtime("alpha"); }
        if (receiver().querySelector(\`[data-row="\${text()}"]\`) === alpha && order === "RT") note("e");
        const seven = Number(runtime("7"));
        if (panel.querySelector(\`button:not([data-row='\${runtime("alpha")}'])[data-shortcut="\${seven}"]\`) === off) note("f");
        if (panel.querySelector("[data-row=\\"" + runtime("alpha") + "\\"]") === alpha) note("g");
        const both = panel.querySelectorAll(\`.row[data-row="\${runtime("alpha")}"], .row[data-row="\${runtime("it's")}"]\`);
        if (both.length === 2 && both[0] === alpha && both[1] === quoted) note("h");
        if (alpha.matches(\`[data-row="\${runtime("alpha")}"]\`) && alpha.closest(\`div[id="\${runtime("panel")}"]\`) === panel) note("i");

        function fails(query: () => unknown, name: string, mark: string): void {
            try { query(); } catch (error) {
                if (error instanceof DOMException && error.name === name) note(mark);
            }
        }
        fails(() => panel.querySelector(\`[data-row="\${runtime("a\\nb")}"]\`), "SyntaxError", "S");
        fails(() => panel.matches(\`[data-row="\${runtime("a\\fb")}"]\`), "SyntaxError", "S");
        fails(() => panel.querySelectorAll(\`[data-row="\${runtime('a"b')}"]\`), "NotSupportedError", "N");
        fails(() => panel.closest(\`[data-row="\${runtime("a\\\\b")}"]\`), "NotSupportedError", "N");
        fails(() => panel.querySelector(\`[data-row='\${runtime("it's")}']\`), "NotSupportedError", "N");
        fails(() => panel.querySelector(\`[data-row="\${runtime("a\\tb")}"]\`), "NotSupportedError", "N");
        fails(() => panel.querySelector(\`[data-row="\${runtime('a"\\n')}"]\`), "NotSupportedError", "Q");
        fails(() => panel.querySelector(runtime(".x") as ".row" | ".page"), "NotSupportedError", "C");
        if (panel.querySelector(runtime(".page") as ".row" | ".page") === page) note("x");

        const secondary = quoted.hasAttribute("data-secondary");
        alpha.classList.add("is-active");
        quoted.classList.add("is-active");
        const scope = secondary ? ".row.secondary.is-active" : ".row:not(.secondary).is-active";
        panel.querySelectorAll(scope).forEach((el) => el.classList.remove("is-active"));
        if (!alpha.classList.contains("is-active") && quoted.classList.contains("is-active")) note("j");

        if (off.matches(":disabled") && !alpha.matches(":disabled") && !panel.matches(":disabled") &&
            panel.querySelectorAll("button:not(:disabled)").length === 2) note("k");
        if (box.matches(":checked") && !alpha.matches(":checked")) {
            box.checked = false;
            if (!box.matches(":checked")) note("l");
        }
        alpha.focus();
        if (alpha.matches(":focus") && alpha.matches(":focus-visible") && panel.matches(":focus-within") &&
            !panel.matches(":focus") && document.querySelector(":focus") === alpha && !quoted.matches(":focus-within")) note("m");
        quoted.focus({ focusVisible: false });
        if (quoted.matches(":focus") && !quoted.matches(":focus-visible") && !alpha.matches(":focus")) note("n");
        quoted.blur();
        if (!panel.matches(":focus-within") && document.querySelector(":focus") === null) note("o");
        // No UI projection has hovered or pressed anything.
        if (!alpha.matches(":hover") && !(panel.querySelector(".row")?.matches(":hover") ?? false) &&
            !(panel as HTMLElement).matches(":active") && document.querySelectorAll(":hover").length === 0) note("p");
        const targets = Array.from(panel.querySelectorAll<HTMLElement>("button, input")).filter((element) =>
            !(element.tabIndex < 0 || element.matches(":disabled") || element.closest("[hidden], [inert]")));
        if (targets.length === 3 && targets[2] === box) note("q");

        const result = document.createElement("div");
        result.id = "selector-log";
        result.textContent = log;
        document.body.appendChild(result);
        globalThis.close();
    `,
        { fileName: join(directory, "entry.ts") },
    );
    assert.equal(result.manifest.deferredCapabilities, undefined);
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "runtime-selectors", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
        },
    });
});

test("hover and active selectors read the Window display's pointer state in the realm", (t) => {
    // test/fixtures/runtime-selectors-window-check.cpp moves and presses the
    // mouse through the Window display; the realm's listeners read the states
    // the display's RmlUi projection published.
    const result = compileSource(`
        let trace = "";
        const log = document.createElement("div");
        log.id = "log";
        document.body.append(log);
        function note(text: string): void { trace += text; log.textContent = trace; }
        function place(element: HTMLElement, style: string): void {
            element.style.cssText = "position:absolute;margin:0;" + style;
            document.body.append(element);
        }
        const region = document.createElement("div");
        place(region, "left:0px;top:0px;width:200px;height:150px;");
        const container = document.createElement("div");
        place(container, "left:300px;top:0px;width:2000px;height:150px;");
        const target = document.createElement("div");
        target.className = "target";
        target.style.cssText = "position:absolute;left:0px;top:0px;width:2000px;height:150px;margin:0;";
        container.append(target);
        const done = document.createElement("div");
        place(done, "left:0px;top:200px;width:200px;height:2000px;");
        function states(): string {
            return (region.matches(":hover") ? "R" : "r") +
                (target.matches(":hover") ? "T" : "t") +
                ((container as HTMLElement).matches(":hover") ? "H" : "h") +
                (target.matches(":active") ? "A" : "a") +
                ((document.body.querySelector(".target")?.matches(":hover") ?? false) ? "C" : "c");
        }
        let pressed = false;
        region.addEventListener("pointerdown", () => { note("P" + states()); });
        target.addEventListener("pointerdown", () => { pressed = true; note("D" + states()); });
        target.addEventListener("pointermove", () => {
            if (pressed) note("M" + states());
            pressed = false;
        });
        done.addEventListener("pointerdown", () => {
            note("E" + states());
            setTimeout(() => globalThis.close(), 0);
        });
    `);
    assert.equal(result.manifest.deferredCapabilities, undefined);
    assert.match(result.cpp, /run_window_application/);
    const output = resolve("artifacts/runtime-selectors-window");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "program.hpp"), result.cpp);
    emitUpstreamGenerated(output, ["core", "backend:sdl"]);
    runRmlUiFixture(t, "runtime-selectors-window", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
            BBLITE_HAS_PBR_RENDERER: 0,
            BBLITE_HAS_SDL_GPU: 1,
            BBLITE_HAS_DAWN: 0,
        },
        includeDirectories: [join(output, "upstream/include")],
    });
});

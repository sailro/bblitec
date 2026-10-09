import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("primary canvas lookup preserves scene ownership and ordinary queries stay retained", () => {
    for (const lookup of [
        'document.getElementById("presentation")',
        'document.querySelector("#presentation")',
    ]) {
        const result = compileSource(`
            import {createEngine, createSceneContext, registerScene, startEngine} from "@babylonjs/lite";
            const canvas = ${lookup} as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            canvas.addEventListener("touchstart", event => event.preventDefault(), {passive: false});
            await registerScene(scene);
            await startEngine(engine);
            (window as unknown as {probe: unknown}).probe = {scene};
        `);
        assert.ok(!result.manifest.features.includes("platform:window"));
        assert.doesNotMatch(
            result.cpp,
            /run_window_application|dom_window_property/,
        );
    }
    const retained = compileSource(`
        const element = document.querySelector("#ordinary-element");
        if (element !== null) element.textContent = "retained";
    `);
    assert.ok(retained.manifest.features.includes("platform:window"));
});

test("document lookup activates retained ownership before construction and preserves style receivers", (t) => {
    const directory = resolve("artifacts/ui-registration-boundaries");
    mkdirSync(directory, { recursive: true });
    const result = compileSource(
        `
        let reads = 0;
        function name(): string { ++reads; return "owned-sheet"; }
        const absent = document.getElementById(name());
        if (absent !== null || reads !== 1) throw new Error("initial lookup");
        if (document.querySelector(".not-created") !== null) throw new Error("initial selector");
        if (document.querySelectorAll(".not-created").length !== 0) throw new Error("initial selector list");
        function sheet(id: string): HTMLStyleElement {
            let value = document.getElementById(id) as HTMLStyleElement | null;
            if (!value) {
                value = document.createElement("style");
                value.id = id;
                document.head.appendChild(value);
            }
            return value;
        }
        const first = sheet("owned-sheet");
        const retained: HTMLStyleElement[] = [sheet("owned-sheet")];
        if (retained[0] !== first || absent !== null) throw new Error("lookup identity or snapshot");
        const install: Array<(value: HTMLStyleElement) => void> = [value => {
            value.textContent = ".marked{color:rgb(255,0,0)}";
        }];
        install[0]!(retained[0]!);
        let effects = 0;
        let catches = 0;
        function css(): string { ++effects; return ".marked{color:blue}"; }
        const replace: Array<(value: HTMLStyleElement) => void> = [value => {
            value.textContent = css();
        }];
        try { replace[0]!(retained[0]!); } catch (error) {
            if (!error.message.includes("css:runtime-stylesheet-installation-bridge")) throw error;
            ++catches;
        }
        if (effects !== 1 || catches !== 1) throw new Error("style boundary effects");
        const panel = document.createElement("div");
        panel.id = "metadata-root";
        panel.innerHTML = '<div id="metadata" ROLE="status" aria-live="polite" aria-hidden="false" DATA-mode="ready"><strong id="emphasis" class="marked">Ready</strong><button id="inactive" type="button" disabled data-action="wait">Wait</button><span id="concealed" hidden>Later</span><img id="hint" alt="" draggable="false" fetchpriority="high"/></div>';
        const metadata = panel.querySelector("#metadata")!;
        if (metadata.getAttribute("role") !== "status" || metadata.getAttribute("aria-live") !== "polite" || metadata.getAttribute("data-mode") !== "ready") throw new Error("metadata projection");
        if (!panel.querySelector("#inactive")!.hasAttribute("disabled") || !panel.querySelector("#concealed")!.hasAttribute("hidden")) throw new Error("boolean attributes");
        document.body.appendChild(panel);
        first.remove();
        if (document.getElementById("owned-sheet") !== null) throw new Error("lookup after removal");
        document.head.appendChild(first);
        if (sheet("owned-sheet") !== retained[0]) throw new Error("reattached lookup");
        const missingButton = document.getElementById("absent-button") as HTMLButtonElement | null;
        let clicked = 0;
        if (missingButton) {
            missingButton.textContent = "unreachable";
            missingButton.addEventListener("click", () => { clicked++; });
        }
        missingButton?.click();
        if ((missingButton ?? null) !== null) throw new Error("nullable lookup provenance");
        const interactive = document.createElement("button");
        interactive.id = "interactive";
        panel.appendChild(interactive);
        const button = document.getElementById("interactive") as HTMLButtonElement | null;
        if (button) {
            button.textContent = "retained";
            button.setAttribute("aria-pressed", "true");
        }
        if (clicked !== 0 || !button || button.textContent !== "retained") throw new Error("nullable retained writes");
        const coalescedButton = button ?? null;
        if (coalescedButton !== button || coalescedButton?.textContent !== "retained")
            throw new Error("coalesced retained owner");
        let order = "";
        let selected: HTMLElement = panel;
        function receiver(): HTMLElement { order += "T"; return selected; }
        function firstSource(): {count: number; enabled: boolean} {
            order += "A";
            return {count: 7, enabled: false};
        }
        function lastSource(): {phaseName: string; count: number} {
            order += "B";
            selected = metadata as HTMLElement;
            return {phaseName: "ready", count: 9};
        }
        const copied = Object.assign(receiver().dataset, firstSource(), lastSource());
        if (order !== "TAB" || copied !== panel.dataset || panel.dataset.count !== "9" ||
            panel.dataset.enabled !== "false" || panel.dataset.phaseName !== "ready" ||
            metadata.getAttribute("data-count") !== null) throw new Error("dataset assign owner/order/coercion");
        function failSource(): {afterFailure: string} { throw new Error("source failed"); }
        try { Object.assign(panel.dataset, {afterFailure: "bad"}, failSource()); } catch (error) {
            if (error.message !== "source failed") throw error;
        }
        if (panel.dataset.afterFailure !== undefined) throw new Error("dataset writes before argument completion");
        const earlySource = {count: 1};
        const earlyAlias = earlySource;
        function mutateSource(): {phase: string} {
            earlyAlias.count = 12;
            return {phase: "changed"};
        }
        Object.assign(panel.dataset, earlySource, mutateSource());
        if (panel.dataset.count !== "12" || panel.dataset.phase !== "changed" || earlyAlias !== earlySource)
            throw new Error("dataset copy observes later argument mutation");
        globalThis.close();
    `,
        { deferredCapabilities: "runtime-throw" },
    );
    assert.deepEqual(
        result.manifest.deferredCapabilities?.map((entry) => entry.id),
        ["css:runtime-stylesheet-installation-bridge"],
    );
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "ui-registration-boundaries", {
        imageDecoder: true,
        macros: { BBLITE_WORKERS: 1, BBLITE_OFFSCREEN_SURFACES: 1 },
    });
});

test("retained canvas metadata reads the native counter without recovery activation", () => {
    const result = compileSource(
        `
        import {createEngine} from "@babylonjs/lite";
        const canvas = document.querySelector("canvas")!;
        const engine = await createEngine(canvas);
        Object.assign(canvas.dataset, {drawCalls: engine.drawCallCount, ready: true});
    `,
        {
            nativeHostUi: {
                sourcePath: "test/ui-registration-boundaries.test.ts",
                elements: [
                    { tag: "canvas", attributes: { id: "renderCanvas" } },
                ],
            },
        },
    );
    assert.ok(result.manifest.features.includes("platform:window"));
    assert.ok(!result.manifest.features.includes("engine:device-recovery"));
    assert.equal(result.manifest.canvasReadyGate, true);
    assert.match(result.cpp, /\.draw_call_count/);
    assert.match(result.cpp, /ui_set_attribute[^\n]+"data-draw-calls"/);
    assert.match(result.cpp, /ui_set_attribute[^\n]+"data-ready"/);
});

test("dataset copying validates plain source fields before requesting storage", () => {
    for (const fields of ["get count() { return 1; }", "count() { return 1; }"])
        assert.throws(
            () =>
                compileSource(`
                const element = document.createElement("div");
                const source = {${fields}};
                Object.assign(element.dataset, source);
            `),
            /Object.assign copies plain properties/,
        );
});

test("markup metadata admission retains behavioral and internal attribute refusals", () => {
    for (const [markup, diagnostic] of [
        ['<div onclick="run()"></div>', /not supported/],
        ['<div data-bbl-node="0"></div>', /not supported/],
        ['<div data-bbl-current-color="true"></div>', /not supported/],
        ["<div data-mode></div>", /invalid or unquoted/],
        ['<div hidden="until-found"></div>', /find-in-page support/],
        ['<div draggable="true"></div>', /authored drags/],
        ['<img fetchpriority="urgent"/>', /fetchpriority requires/],
        ["<span disabled></span>", /not supported/],
        ['<div aria-label="a" ARIA-LABEL="b"></div>', /duplicated/],
    ] as const) {
        assert.throws(
            () =>
                compileSource(
                    `const panel=document.createElement("div"); panel.innerHTML=${JSON.stringify(markup)};`,
                ),
            diagnostic,
        );
    }
    assert.throws(
        () =>
            compileSource(`
        const values: Array<(style: HTMLStyleElement, css: string) => void> = [
            (style, css) => { style.textContent = css; }
        ];
        values[0]!(document.createElement("style"), String(performance.now()));
    `),
        /string literal/,
    );
});

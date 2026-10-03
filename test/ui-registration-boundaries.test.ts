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

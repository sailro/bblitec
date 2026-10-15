import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const deferredCapabilities = "runtime-throw" as const;
const prefix = `import {createEngine} from "@babylonjs/lite";
    await createEngine({}); const panel=document.createElement("div");`;

test("CSS deferral inventories independent features without hiding language gaps", () => {
    const source =
        prefix +
        `
        panel.style.cssText="caption-side:bottom;empty-cells:hide;animation-direction:reverse";
        panel.style.gridTemplateColumns="[start] 1fr [end]";
        panel.style.setProperty("columns", "2");
        const sheet=document.createElement("style");
        sheet.textContent='@media(max-width:600px){.panel{mask:none;break-inside:avoid}}';
    `;
    assert.throws(() => compileSource(source), /Retained UI style/);
    const result = compileSource(source, { deferredCapabilities });
    assert.deepEqual(
        result.manifest.deferredCapabilities?.map((s) => s.id),
        [
            "css:property:caption-side",
            "css:property:empty-cells",
            "css:property:animation-direction",
            "css:grid-tracks:grid-template-columns",
            "css:property:columns",
            "css:property:mask",
            "css:property:break-inside",
        ],
    );
    assert.throws(
        () =>
            compileSource(source + `new FinalizationRegistry(() => {});`, {
                deferredCapabilities,
            }),
        /Unsupported constructor/,
    );
    assert.throws(
        () =>
            compileSource(
                prefix + `panel.style.setProperty("imaginary-property", "x");`,
                {
                    deferredCapabilities,
                },
            ),
        /reviewed retained-UI surface/,
    );
    assert.throws(
        () =>
            compileSource(
                prefix +
                    `panel.style.emptyCells=String(new FinalizationRegistry(() => {}));`,
                {
                    deferredCapabilities,
                },
            ),
        /Unsupported constructor/,
    );
});

test("CSS feature scans ignore custom values, strings and comments", () => {
    const result = compileSource(
        prefix +
            `
        panel.style.cssText="--text:'mask:none;clip-path:none';color:red";
        const sheet=document.createElement("style");
        sheet.textContent="/* float:left */.panel{--text:'};mask:none;{';color:red}";
    `,
        { deferredCapabilities },
    );
    assert.equal(result.manifest.deferredCapabilities, undefined);
});

test("deferred grid contracts retain strict surrounding syntax validation", () => {
    for (const value of [
        "10% bananas(",
        "[start] unknown",
        "subgrid broken",
        "10em repeat(2,)",
    ]) {
        assert.throws(
            () =>
                compileSource(
                    prefix +
                        `panel.style.cssText=${JSON.stringify(`grid-template-columns:${value}`)};`,
                    { deferredCapabilities },
                ),
            /Retained UI style/,
        );
    }
    for (const value of ["[start] 1fr [end]", "10% 2rem", "subgrid [first]"]) {
        const result = compileSource(
            prefix +
                `panel.style.cssText=${JSON.stringify(`grid-template-columns:${value}`)};`,
            { deferredCapabilities },
        );
        assert.equal(
            result.manifest.deferredCapabilities?.[0]?.id,
            "css:grid-tracks:grid-template-columns",
        );
    }
});

test("CSS stubs evaluate values once and throw at each reached installation", (t) => {
    const directory = resolve("artifacts/deferred-ui-style");
    mkdirSync(directory, { recursive: true });
    const source = `
        let effects=0; let catches=0;
        function text(value:string):string { ++effects; return value; }
        const panel=document.createElement("div");
        const sheet=document.createElement("style");
        try { panel.style.emptyCells=text("hide"); } catch(e) {
            if(!e.message.includes("css:property:empty-cells"))throw new Error("property identity");
            ++catches;
        }
        try { sheet.textContent=".panel{mask:none}"; } catch(e) {
            if(!e.message.includes("css:property:mask"))throw new Error("sheet identity");
            ++catches;
        }
        try { panel.style.cssText=\`mask:\${text("none")};columns:2\`; } catch { ++catches; }
        sheet.textContent=text(".panel{color:red}");
        if(effects!==3||catches!==3)throw new Error("evaluation or catch order");
        if(panel.style.color!=="")throw new Error("deferred write must not change styles");
        globalThis.close();
    `;
    const result = compileSource(source, { deferredCapabilities });
    assert.equal(result.manifest.deferredCapabilities?.length, 4);
    // Text generation cannot read is no deferred capability: it refuses.
    for (const write of [
        `panel.style.cssText=text("color:red");`,
        `sheet.textContent=text(String(performance.now()));`,
    ])
        assert.throws(
            () =>
                compileSource(source.replace("globalThis.close();", write), {
                    deferredCapabilities,
                }),
            /Native UI cssText|Module constant|Builder|static|string literal/,
        );
    writeFileSync(resolve(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "deferred-ui-style", {
        macros: { BBLITE_WORKERS: 1, BBLITE_OFFSCREEN_SURFACES: 1 },
    });
});

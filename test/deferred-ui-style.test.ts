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
        panel.style.cssText="aspect-ratio:2;clip-path:inset(1px);animation-delay:1s";
        panel.style.gridTemplateColumns="[start] 1fr [end]";
        panel.style.setProperty("float", "left");
        const sheet=document.createElement("style");
        sheet.textContent='@media(max-width:600px){.panel{mask:none;grid-template-areas:"a b"}}';
    `;
    assert.throws(() => compileSource(source), /Retained UI style/);
    const result = compileSource(source, { deferredCapabilities });
    assert.deepEqual(
        result.manifest.deferredCapabilities?.map((s) => s.id),
        [
            "css:property:aspect-ratio",
            "css:property:clip-path",
            "css:property:animation-delay",
            "css:grid-tracks:grid-template-columns",
            "css:property:float",
            "css:property:mask",
            "css:property:grid-template-areas",
        ],
    );
    assert.throws(
        () =>
            compileSource(source + `new Proxy({}, {});`, {
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
                prefix + `panel.style.clipPath=String(new Proxy({},{}));`,
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

test("CSS stubs evaluate values once and throw at each reached installation", (t) => {
    const directory = resolve("artifacts/deferred-ui-style");
    mkdirSync(directory, { recursive: true });
    const source = `
        let effects=0; let catches=0;
        function text(value:string):string { ++effects; return value; }
        const panel=document.createElement("div");
        const sheet=document.createElement("style");
        try { panel.style.clipPath=text("inset(1px)"); } catch(e) {
            if(!e.message.includes("css:property:clip-path"))throw new Error("property identity");
            ++catches;
        }
        try { panel.style.cssText=text("color:red"); } catch(e) {
            if(!e.message.includes("css:runtime-declaration-parser"))throw new Error("declaration parser identity");
            ++catches;
        }
        try { sheet.textContent=text(".panel{color:red}"); } catch(e) {
            if(!e.message.includes("css:runtime-stylesheet-parser"))throw new Error("sheet parser identity");
            ++catches;
        }
        try { panel.style.cssText=\`mask:\${text("none")};float:left\`; } catch { ++catches; }
        if(effects!==4||catches!==4)throw new Error("evaluation or catch order");
        if(panel.style.color!=="")throw new Error("deferred write must not change styles");
        globalThis.close();
    `;
    const result = compileSource(source, { deferredCapabilities });
    assert.equal(result.manifest.deferredCapabilities?.length, 5);
    writeFileSync(resolve(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "deferred-ui-style", {
        macros: { BBLITE_WORKERS: 1, BBLITE_OFFSCREEN_SURFACES: 1 },
    });
});

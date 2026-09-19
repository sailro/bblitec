import assert from "node:assert/strict";
import { compileSource } from "../src/compiler.js";
import { supportedUiBoxShadow } from "../src/ui-filters.js";
import test from "node:test";
import { runRmlUiFixture } from "./native-fixture.js";

test("saved native UI layers preserve clipped pixels, filters, texture ownership and reuse", (t) => {
    runRmlUiFixture(t, "ui-layer-textures");
});

test("literal box shadows retain complete layers on elements and generated boxes", () => {
    const compile = (shadow: string) =>
        compileSource(`import {createEngine} from "@babylonjs/lite";
        await createEngine({}); const sheet=document.createElement("style");
        sheet.textContent=${JSON.stringify(`.tile::after{content:"";box-shadow:${shadow}}`)};
        document.head.appendChild(sheet); const tile=document.createElement("div");
        tile.style.boxShadow=${JSON.stringify(shadow)}; document.body.appendChild(tile);`);
    for (const shadow of [
        "none",
        "inset 0 0 0 2px blue",
        "0 0 var(--ink, rgba(20,30,40,.5))",
        "0 0 var(--ink)",
        "0 0 var(--2Ink, var(--Fallback, red))",
        "#1234 -2px 3px",
        "1px 2px 3px -4px red inset",
        "inset 0 0 0 1px rgba(20,30,40,.5), 2px 3px 6px blue, inset 0 -1px 0 white",
    ]) {
        assert.ok(supportedUiBoxShadow(shadow), shadow);
        const result = compile(shadow);
        assert.ok(result.cpp.includes(`box-shadow:${shadow}`));
        assert.doesNotMatch(result.cpp, /--bbl-inset-outline/);
        assert.doesNotMatch(
            result.manifest.adaptations.find(
                (item) => item.id === "substituted-ui-runtime",
            )?.nativeSemantics ?? "",
            /degradation[^.]*box-shadow/,
        );
    }
    for (const shadow of [
        "",
        "inset inset 0 0 red",
        "red blue 0 0",
        "0 0",
        "0 0 -1px red",
        "0 0 1% blue",
        "red 0 0,",
        "0 red 0",
        "0 0 url(mask.svg)",
        "0 0 var(--shadow, url(mask.svg))",
        "none, 0 0 red",
        "0 0 currentColor",
    ]) {
        assert.equal(supportedUiBoxShadow(shadow), false, shadow);
        if (shadow) assert.throws(() => compile(shadow), /shadow lists/);
    }
});

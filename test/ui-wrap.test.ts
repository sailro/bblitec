import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("wrapping declarations and legacy word-wrap writes reach the same native properties", () => {
    const compile = (value: string) => compileSource(`
        import { createEngine } from "@babylonjs/lite";
        await createEngine({});
        const panel = document.createElement("div");
        panel.style.cssText = "word-wrap:break-word;word-break:normal;";
        panel.style.wordWrap = ${JSON.stringify(value)};
        document.body.appendChild(panel);
    `);
    const result = compile("anywhere");
    assert.match(result.cpp, /overflow-wrap:break-word;word-break:normal/);
    assert.match(result.cpp, /ui_set_style_property[^\n]+"overflow-wrap", "anywhere"/);
    assert.throws(() => compile("break-all"), /only normal, break-word and anywhere/);
});

test("retained word wrapping inherits, resets, respects white-space and responds to width changes", t => {
    runRmlUiFixture(t, "ui-wrap");
});

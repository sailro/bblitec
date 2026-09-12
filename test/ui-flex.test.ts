import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("retained flex and box declarations survive static projection and live writes", () => {
    const style = "display:flex;flex-flow:WRAP COLUMN;align-content:start;align-self:end;flex:1 1 auto;flex-basis:30%;flex-grow:2;flex-shrink:0;flex-wrap:wrap-reverse;row-gap:4px;column-gap:8px;padding-top:2px;padding-right:3px;padding-bottom:4px;padding-left:5px;margin-left:auto;margin-right:-2px;";
    const compile = (value: string) => compileSource(`
        import { createEngine } from "@babylonjs/lite";
        await createEngine({});
        const panel = document.createElement("div");
        panel.style.cssText = ${JSON.stringify(style)};
        panel.style.flexFlow = ${JSON.stringify(value)};
        document.body.appendChild(panel);
    `);
    const result = compile("row");
    assert.ok(result.cpp.includes(style.replace("WRAP COLUMN", "wrap column")));
    assert.match(result.cpp, /ui_set_style_property[^\n]+"flex-flow", "row"/);
    assert.throws(() => compile("row column"), /supported literal flex and box forms/);
});

test("unsupported flex sizing and malformed layout values refuse", () => {
    for (const [property, value] of [
        ["flex", "-1"], ["flex", "1 1 min-content"], ["flex", "none 1"],
        ["flex-basis", "calc(100% - 5px)"], ["flex-grow", "1e99"],
        ["flex-wrap", "reverse"], ["align-self", "safe center"],
        ["padding-left", "-2px"], ["row-gap", "-1px"],
    ]) assert.throws(() => compileSource(`
        import { createEngine } from "@babylonjs/lite";
        await createEngine({});
        const panel = document.createElement("div");
        panel.style.cssText = ${JSON.stringify(`${property}:${value};`)};
        document.body.appendChild(panel);
    `), /supported literal flex and box forms/);
});

test("native flex layout wraps, resizes, reverses alignment and resets shorthand components", t => {
    runRmlUiFixture(t, "ui-flex");
});

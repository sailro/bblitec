import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { uiStyleSelector } from "../src/ui-style-rule.js";

function compileStyle(style: string) {
    return compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main() {
            await createEngine({});
            const sheet = document.createElement("style");
            sheet.textContent = ${JSON.stringify(style)};
            document.head.appendChild(sheet);
            const panel = document.createElement("div");
            panel.className = "history";
            document.body.appendChild(panel);
        }
        void main();
    `);
}

test("retained scrollbar styling preserves standard properties and typed pseudo-elements", () => {
    const result = compileStyle(`
        .history { overflow-y: auto; scrollbar-width: thin; scrollbar-color: #345678 transparent; }
        .history::-webkit-scrollbar { width: 12px; height: 9px; }
        .history::-webkit-scrollbar-thumb { background: #567890; border: 2px solid transparent; background-clip: padding-box; }
        .history::-webkit-scrollbar-thumb:hover { background: #234567; }
        .history::-webkit-scrollbar-track { background: transparent; margin: 3px 0; }
        .history::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
        .history::-webkit-scrollbar-corner { background: transparent; }
    `);
    assert.match(result.cpp, /ui_add_class_style[^\n]*scrollbar-width: thin; scrollbar-color: #345678 transparent/);
    for (const part of ["Scrollbar", "Thumb", "Track", "Button", "Corner"]) {
        assert.match(result.cpp, new RegExp(`ui_add_style_rule[^\\n]*UiScrollbarPart::${part}`));
    }
    assert.match(result.cpp, /"history", "", "", true, -1[^\n]*UiScrollbarPart::Thumb/);
    assert.match(result.cpp, /ui_add_style_rule[^\n]*background-clip: padding-box/);
    assert.equal(uiStyleSelector({ kind: "class", primary: "history", scrollbar: "thumb", hover: true }),
        ".history::-webkit-scrollbar-thumb:hover");
});

test("unrepresented scrollbar states and values refuse explicitly", () => {
    assert.throws(() => compileStyle(".history { scrollbar-width: 4px; }"), /only auto, thin and none/);
    assert.throws(() => compileStyle(".history { scrollbar-color: red; }"), /two literal/);
    assert.throws(() => compileStyle(".history::-webkit-scrollbar-thumb:horizontal { background: red; }"), /selector.*not lowered/);
    assert.throws(() => compileStyle(".history::-webkit-scrollbar-track-piece { background: red; }"), /selector.*not lowered/);
    assert.throws(() => compileStyle(".history { background: linear-gradient(red, blue); background-clip: padding-box; }"), /box clipping currently applies to solid backgrounds/);
    assert.throws(() => compileStyle(".history { background: url(panel.png); background-clip: padding-box; }"), /box clipping currently applies to solid backgrounds/);
});

test("assigning the background shorthand resets a previous solid clipping box", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main() {
            await createEngine({});
            const panel = document.createElement("div");
            panel.style.cssText = "background-clip: padding-box; background-color: red;";
            document.body.appendChild(panel);
            panel.addEventListener("click", () => { panel.style.background = "blue"; });
        }
        void main();
    `);
    assert.match(result.cpp, /ui_set_style_property\([^\n]+"background-color", "blue"\);\s*bbl::ui_set_style_property\([^\n]+"background-clip", "border-box"\);/);
});

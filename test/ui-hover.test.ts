import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("source stylesheet hover uses the existing selector kinds and state flag", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        await createEngine({});
        const sheet = document.createElement("style");
        sheet.textContent = ".menu_entry:hover{color:#112233}#action:hover{color:#223344}button.menu_entry:hover{color:#334455}.menu_entry.selected:hover{color:#445566}#menu .menu_entry:hover{color:#556677}.panel button:hover{color:#667788}";
        document.head.appendChild(sheet);
        const panel = document.createElement("div");
        panel.id = "menu";
        panel.className = "panel";
        const button = document.createElement("button");
        button.id = "action";
        button.className = "menu_entry selected";
        button.textContent = "Action";
        panel.appendChild(button);
        document.body.appendChild(panel);
    `);
    const rules = result.cpp.split("\n").filter(line => line.includes("bbl::ui_add_style_rule("));
    assert.equal(rules.length, 6);
    for (const rule of rules) assert.match(rule, /, true, /);
    for (const kind of ["Class", "Id", "TagClass", "CompoundClass", "IdDescendantClass", "ClassDescendantTag"])
        assert.ok(rules.some(rule => rule.includes(`bbl::UiStyleSelectorKind::${kind},`)), kind);
});

test("class hover renders through the existing native cascade and resets when the pointer leaves", t => {
    runRmlUiFixture(t, "ui-hover");
});

test("source CSS shares active and keyboard-focus states with host rules", () => {
    const compile = (sheet: string) => compileSource(`
        import { createEngine } from "@babylonjs/lite";
        await createEngine({});
        const style = document.createElement("style");
        style.textContent = ${JSON.stringify(sheet)};
        document.head.appendChild(style);
        const panel = document.createElement("div");
        panel.className = "entry";
        document.body.appendChild(panel);
    `);
    const result = compile(".entry:active{color:red}.entry:focus-visible{color:blue}.entry:active:hover:focus-visible{color:green}");
    const rules = result.cpp.split("\n").filter(line => line.includes("bbl::ui_add_style_rule("));
    assert.equal(rules.length, 3);
    assert.match(rules[0]!, /, false, -1[^\n]*UiScrollbarPart::None, false, true/);
    assert.match(rules[1]!, /, false, -1[^\n]*UiScrollbarPart::None, true, false/);
    assert.match(rules[2]!, /, true, -1[^\n]*UiScrollbarPart::None, true, true/);
    for (const state of ["active", "focus-visible"])
        assert.throws(() => compile(`.entry:${state}{display:grid;grid-template-columns:repeat(2,20px);}`), /one stable/);
    assert.throws(() => compile(".entry:active:active{color:red}"), /selector.*not lowered/);
});

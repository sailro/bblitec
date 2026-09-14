import assert from "node:assert/strict";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {runRmlUiFixture} from "./native-fixture.js";

test("source styles lower direct parent tags with child classes and interaction states", () => {
    const result = compileSource(`
        import {createEngine} from "@babylonjs/lite";
        await createEngine({});
        const sheet = document.createElement("style");
        sheet.textContent = "div > .entry{color:red}body>.entry:hover{color:blue}html > .cursor{color:green}html > .cursor.visible{color:black}";
        document.head.appendChild(sheet);
        const parent = document.createElement("div");
        const child = document.createElement("button");
        child.className = "entry";
        parent.appendChild(child);
        document.body.appendChild(parent);
    `);
    const rules = result.cpp.split("\n").filter(line => line.includes("bbl::ui_add_style_rule("));
    assert.equal(rules.length, 4);
    for (const rule of rules) assert.match(rule, /UiStyleSelectorKind::TagChildClass/);
    assert.match(rules[1]!, /"body", true,/);
    assert.match(rules[3]!, /"cursor", "visible", "html"/);
});

test("native direct-child selectors preserve parent scope, specificity and live reparenting", t => {
    runRmlUiFixture(t, "ui-child-selectors");
});

import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { supportedUiGridTemplateAreas } from "../src/ui-grid.js";
import { runRmlUiFixture } from "./native-fixture.js";

const compile = (css: string) =>
    compileSource(`import {createEngine} from '@babylonjs/lite';await createEngine({});
    const sheet=document.createElement('style');sheet.textContent=${JSON.stringify(css)};document.head.appendChild(sheet);`);

test("named grid areas lower strictly with their authored strings and names", () => {
    const result = compile(
        `.row{display:grid;grid-template-columns:40px minmax(0,1fr) auto;grid-template-areas:"icon copy progress" "icon reward reward"}
        .icon{grid-area:icon}.Copy{grid-area:Copy}.art{grid-area:1 / 1}.wide{grid-area:2 / 1 / span 2 / -1}.cell{grid-column:copy;grid-row:reward / -1}
        .empty{grid-template-areas:none}.dots{grid-template-areas:'a . b' "a ... b"}`,
    );
    assert.equal(result.manifest.deferredCapabilities, undefined);
    const rules = result.cpp
        .split("\n")
        .filter((line) => line.includes("bbl::ui_add_"))
        .join("\n");
    assert.match(
        rules,
        /grid-template-areas:\\"icon copy progress\\" \\"icon reward reward\\"/,
    );
    assert.match(rules, /grid-area:Copy/);
    assert.match(rules, /grid-area:1 \/ 1/);
    assert.match(rules, /grid-column:copy;grid-row:reward \/ -1/);
    const inline =
        compileSource(`import {createEngine} from '@babylonjs/lite';await createEngine({});
        const cell=document.createElement('div');document.body.appendChild(cell);
        cell.style.gridArea='reward';cell.style.gridTemplateAreas='"a b"';cell.style.removeProperty('grid-area');`);
    assert.match(inline.cpp, /"grid-area", "reward"/);
    assert.match(inline.cpp, /"grid-template-areas", "\\"a b\\""/);
    for (const declaration of [
        `grid-template-areas:"a b" "b a"`,
        `grid-template-areas:"a b" "c"`,
        `grid-template-areas:"a b" c`,
        `grid-template-areas:"a+b"`,
        `grid-template-areas:""`,
        "grid-area:span icon",
        "grid-area:2 icon",
        "grid-area:1 / 2 / 3 / 4 / 5",
        "grid-area:0",
        "grid-column:span icon",
        "grid-row:inherit / 2",
    ])
        assert.throws(
            () => compile(`.grid{display:grid;${declaration}}`),
            /Retained UI style property 'grid-(?:template-areas|area|column|row)'/,
            declaration,
        );
    assert.throws(
        () =>
            compileSource(`import {createEngine} from '@babylonjs/lite';await createEngine({});
            const cell=document.createElement('div');cell.style.gridArea='span a';`),
        /Retained UI style property 'grid-area'/,
    );
});

test("native named areas place items, extend the explicit grid and follow live writes", (t) =>
    runRmlUiFixture(t, "ui-grid-areas"));

test("grid area validation handles the full bounded grid and rejects disconnected areas", () => {
    const rows = Array.from(
        { length: 256 },
        (_, row) =>
            `"${Array.from({ length: 256 }, (_, column) => `a${row}_${column}`).join(" ")}"`,
    );
    assert.equal(supportedUiGridTemplateAreas(rows.join(" ")), true);
    rows[255] = rows[255]!.replace("a255_255", "a0_0");
    assert.equal(supportedUiGridTemplateAreas(rows.join(" ")), false);
    assert.equal(
        supportedUiGridTemplateAreas('"a a a" "a . a" "a a a"'),
        false,
    );
});

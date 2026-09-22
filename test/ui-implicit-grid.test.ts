import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const compile = (css: string) =>
    compileSource(`import {createEngine} from '@babylonjs/lite';await createEngine({});
    const sheet=document.createElement('style');sheet.textContent=${JSON.stringify(css)};document.head.appendChild(sheet);`);

test("implicit grid styles preserve native layout, alignment cascade and marker suppression", () => {
    const result = compile(
        ".grid{display:grid;place-items:center;gap:10px}.grid.open{place-items:end start;align-items:center}.items{list-style:none;list-style-type:none}",
    );
    const projected = result.cpp
        .split("\n")
        .filter((line) => line.includes("bbl::ui_add_"))
        .join("\n");
    assert.match(projected, /display:grid/);
    assert.match(projected, /place-items:center/);
    assert.match(projected, /place-items:end start;align-items:center/);
    assert.doesNotMatch(projected, /list-style|--bbl-grid/);
    const inline =
        compileSource(`import {createEngine} from '@babylonjs/lite';await createEngine({});
        const grid=document.createElement('div');grid.style.cssText='display:grid;place-items:center';
        grid.textContent='Caption';document.body.appendChild(grid);grid.style.placeItems='end start';`);
    assert.match(inline.cpp, /display:grid;place-items:center/);
    assert.match(inline.cpp, /"place-items", "end start"/);
    for (const declaration of [
        "list-style:disc",
        "list-style-type:decimal",
        "place-items:baseline",
        "justify-items:legacy",
        "justify-self:safe center",
        "grid-auto-flow:column",
        "grid-template-columns:subgrid",
    ])
        assert.throws(
            () => compile(`.grid{display:grid;${declaration}}`),
            /Retained UI style property/,
        );
});

test("native implicit rows preserve item layout, text, identity and live mutations", (t) =>
    runRmlUiFixture(t, "ui-implicit-grid"));

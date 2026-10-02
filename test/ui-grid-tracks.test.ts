import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const compile = (css: string) =>
    compileSource(`import {createEngine} from '@babylonjs/lite';await createEngine({});
    const sheet=document.createElement('style');sheet.textContent=${JSON.stringify(css)};document.head.appendChild(sheet);`);

test("native grid track admission composes across selectors and responsive rules", () => {
    for (const tracks of [
        "none",
        "auto",
        "0px 40px",
        "1fr",
        "minmax(0,1fr) minmax(80px,2fr)",
        "repeat(2,minmax(0,1fr))",
        "repeat(2,20px 1fr)",
        "0fr .25fr",
        "minmax(34px,auto) minmax(0,1fr)",
        "minmax(0,280px) minmax(auto,100px)",
        "repeat(auto-fit,minmax(70px,1fr))",
        "20px repeat(auto-fill,30px minmax(20px,auto)) 10px",
    ]) {
        const result = compile(
            `.grid{display:inline-grid}.grid{grid-template-columns:${tracks};grid-template-rows:repeat(2,30px)}@media(max-width:480px){.grid{grid-template-columns:1fr}}.grid > .cell{justify-self:end}`,
        );
        assert.match(result.cpp, /display:inline-grid/);
        assert.match(result.cpp, /grid-template-columns/);
        assert.doesNotMatch(result.cpp, /--bbl-(?:fr-)?grid/);
    }
    const live =
        compileSource(`import {createEngine} from '@babylonjs/lite';await createEngine({});const grid=document.createElement('div');document.body.appendChild(grid);
        grid.style.display='grid';grid.style.gridTemplateColumns='repeat(2,minmax(0,1fr))';grid.style.removeProperty('grid-template-columns');`);
    assert.match(
        live.cpp,
        /"grid-template-columns", "repeat\(2,minmax\(0,1fr\)\)"/,
    );
    assert.match(live.cpp, /ui_remove_style_property/);
});

test("grid track admission rejects unsupported placement and malformed sizing", () => {
    for (const tracks of [
        "",
        "subgrid",
        "masonry",
        "20% 1fr",
        "-1fr",
        "1e999px",
        "minmax(1fr,2fr)",
        "minmax(10px,max-content)",
        "repeat(auto-fit,1fr)",
        "repeat(auto-fill,auto)",
        "auto repeat(auto-fit,30px)",
        "repeat(auto-fit,30px) repeat(auto-fill,20px)",
        "repeat(0,20px)",
        "repeat(2.5,20px)",
        "repeat(257,1fr)",
        "repeat(2,repeat(2,1fr))",
        "20px20px",
        "minmax(0,1fr)garbage",
    ]) {
        assert.throws(
            () =>
                compile(`.grid{display:grid;grid-template-columns:${tracks}}`),
            /grid-template-columns/,
            tracks,
        );
    }
    for (const property of [
        "grid-auto-flow:column",
        "grid-row:header",
        "grid-auto-rows:repeat(2,20px)",
        "grid-auto-columns:none",
        "isolation:inherit",
        "grid-template-areas:'header'",
    ])
        assert.throws(
            () => compile(`.grid{display:grid;${property}}`),
            /Retained UI style property/,
        );
});

test("native grid tracks preserve sizing, rows, identity and live cascades", (t) =>
    runRmlUiFixture(t, "ui-grid-tracks"));

test("grid placement composes numeric lines and spans on both axes", () => {
    for (const placement of [
        "auto",
        "1",
        "1 / 3",
        "2/4",
        "256 / 257",
        "-2/-1",
        "span 2",
        "1 / span 2",
        "span 3 / -1",
        "1/auto",
        "auto/3",
        "2/2",
        "3/1",
        "span 2 / span 3",
    ])
        assert.match(
            compile(`.range{grid-column:${placement};grid-row:${placement}}`)
                .cpp,
            /grid-column/,
        );
    for (const placement of [
        "0/2",
        "1/258",
        "-258",
        "span 0",
        "span -2",
        "span 257",
        "1 / 2 / 3",
        "header",
    ])
        assert.throws(
            () => compile(`.range{grid-column:${placement}}`),
            /grid-column/,
        );
});

test("grid implicit sizing and isolation retain live style writes and removals", () => {
    const result =
        compileSource(`import {createEngine} from '@babylonjs/lite'; await createEngine({});
      const grid=document.createElement('div'); document.body.appendChild(grid);
      grid.style.display='grid'; grid.style.gridAutoRows='20px minmax(0,1fr)';
      grid.style.gridAutoColumns='auto'; grid.style.gridRow='1 / span 2';
      grid.style.isolation='isolate'; grid.style.isolation='auto'; grid.style.removeProperty('isolation');`);
    assert.match(result.cpp, /"grid-auto-rows", "20px minmax\(0,1fr\)"/);
    assert.match(result.cpp, /"grid-row", "1 \/ span 2"/);
    assert.match(result.cpp, /"isolation", "isolate"/);
    assert.match(result.cpp, /ui_remove_style_property/);
});

test("native grid column spans retain row placement, track widths and element identity", (t) =>
    runRmlUiFixture(t, "ui-grid-column"));

test("native two-axis placement, intrinsic spans, auto-repeat and isolation mutate coherently", (t) =>
    runRmlUiFixture(t, "ui-grid-placement"));

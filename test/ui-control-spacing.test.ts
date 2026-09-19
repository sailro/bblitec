import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("appearance and logical spacing preserve stylesheet and inline declarations", () => {
    const result =
        compileSource(`import {createEngine} from '@babylonjs/lite';await createEngine({});
        const sheet=document.createElement('style');sheet.textContent='button{appearance:none;padding-inline:9px}@media(max-width:720px){button{padding-inline:4px 8px;gap:4px;row-gap:2px;column-gap:3px}}';document.head.appendChild(sheet);
        const button=document.createElement('button');button.style.cssText='padding-block:3px 7px;margin-inline:auto;-webkit-appearance:none';document.body.appendChild(button);
        button.style.paddingInline='4px 10px';button.style.webkitAppearance='auto';`);
    assert.match(result.cpp, /padding-inline:4px 8px/);
    assert.match(result.cpp, /"padding-inline", "4px 10px"/);
    assert.match(result.cpp, /"appearance", "auto"/);
    const styleWrites = result.cpp
        .split("\n")
        .filter(
            (line) =>
                line.includes("bbl::ui_set_attribute") ||
                line.includes("bbl::ui_set_style_property"),
        )
        .join("\n");
    assert.doesNotMatch(styleWrites, /-webkit-appearance/);
    for (const css of [
        "appearance:menulist",
        "padding-inline:-1px",
        "padding-inline:auto",
        "margin-inline:1px 2px 3px",
        "padding-block-start:1px 2px",
    ])
        assert.throws(
            () =>
                compileSource(
                    `import {createEngine} from '@babylonjs/lite';await createEngine({});const panel=document.createElement('div');panel.style.cssText=${JSON.stringify(css)};document.body.appendChild(panel);`,
                ),
            /Retained UI style property/,
        );
});

test("constructed text, password and range controls share native type assignment", () => {
    for (const type of ["text", "password", "range"]) {
        const result = compileSource(
            `import {createEngine} from '@babylonjs/lite';await createEngine({});const input=document.createElement('input');input.type=${JSON.stringify(type.toUpperCase())};document.body.appendChild(input);`,
        );
        assert.match(
            result.cpp,
            new RegExp(`ui_set_attribute[^\\n]+"type", "${type}"`),
        );
        assert.ok(!result.manifest.features.includes("browser:file"));
    }
    for (const type of ["number", "date", "checkbox"])
        assert.throws(
            () =>
                compileSource(
                    `import {createEngine} from '@babylonjs/lite';await createEngine({});const input=document.createElement('input');input.type=${JSON.stringify(type)};`,
                ),
            /not represented/,
        );
});

test("native grid items retain logical padding", () => {
    const result =
        compileSource(`import {createEngine} from '@babylonjs/lite';await createEngine({});
        const grid=document.createElement('div');grid.style.cssText='display:grid;grid-template-columns:repeat(1,20px)';
        const child=document.createElement('div');child.style.cssText='width:20px;height:20px;padding-inline:2px';grid.appendChild(child);document.body.appendChild(grid);`);
    assert.match(result.cpp, /padding-inline:2px/);
});

test("native logical spacing cascades and appearance controls range painting", (t) =>
    runRmlUiFixture(t, "ui-control-spacing"));

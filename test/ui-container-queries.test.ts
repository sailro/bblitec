import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const source = (
    css: string,
) => `import {createEngine} from '@babylonjs/lite';await createEngine({});
    const sheet=document.createElement('style');sheet.textContent=${JSON.stringify(css)};document.head.appendChild(sheet);`;

test("container rules preserve their conditions through emission", () => {
    const css = `.parent{container-type:inline-size}.reset{container-type:normal}
        @media(max-width:800px){@container(max-width:320px){.row{display:grid;grid-template-columns:1fr}.row:hover{opacity:.5}}}
        @container(max-width:320px){@container(max-width:200px){.small{height:10px}}}
        @container(max-width:320px){@media(prefers-reduced-motion:reduce){.row{transition:none}}}`;
    const result = compileSource(source(css));
    assert.match(result.cpp, /container-type:inline-size/);
    assert.match(
        result.cpp,
        /"display:grid;grid-template-columns:1fr;--bbl-authored-display:1;", \.max_width = 800\.0, \.container_max_width = 320\.0\}\);/,
    );
    assert.match(
        result.cpp,
        /"small"[^\n]*\.container_max_width = 200\.0\}\);/,
    );
    assert.match(
        result.cpp,
        /\.container_max_width = 320\.0, \.media = \{\.reduced_motion = true\}\}\);/,
    );
});

test("container admission refuses unrepresented query forms and native implementation selectors", () => {
    for (const header of [
        "@container sidebar (max-width:320px)",
        "@container(min-width:320px)",
        "@container(max-height:320px)",
        "@container style(--theme:dark)",
        "@container(max-width:-1px)",
        "@container(max-width:2em)",
    ])
        assert.throws(
            () => compileSource(source(`${header}{.row{height:20px}}`)),
            /Retained stylesheet selector/,
        );
    for (const value of ["size", "scroll-state", "inline-size scroll-state"])
        assert.throws(
            () => compileSource(source(`.row{container-type:${value}}`)),
            /container-type/,
        );
    assert.throws(
        () =>
            compileSource(
                source(".row:bbl-container-max-width(320){height:20px}"),
            ),
        /Retained stylesheet selector/,
    );
});

test("native size queries settle nearest-container cascades and intrinsic containment", (t) =>
    runRmlUiFixture(t, "ui-container-queries"));

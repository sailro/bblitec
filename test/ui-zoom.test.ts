import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const compile = (css: string) =>
    compileSource(`import {createEngine} from '@babylonjs/lite';await createEngine({});
    const sheet=document.createElement('style');sheet.textContent=${JSON.stringify(css)};document.head.appendChild(sheet);`);

test("zoom admits nonnegative numbers and percentages, literal or substituted", () => {
    for (const zoom of [
        "1",
        "0",
        "1.15",
        ".5",
        "150%",
        "var(--ui-scale)",
        "var(--ui-scale, 1.3)",
        "var(--tile-scale,80%)",
    ])
        assert.match(compile(`.panel{zoom:${zoom}}`).cpp, /zoom/, zoom);
    for (const zoom of [
        "-1",
        "normal",
        "reset",
        "1px",
        "1e999",
        "calc(2 * 1.5)",
        "var(--ui-scale, normal)",
        "1 2",
    ])
        assert.throws(
            () => compile(`.panel{zoom:${zoom}}`),
            /Retained UI style property 'zoom' is not lowered/,
            zoom,
        );
});

test("offset and client extents read without the zoom a client rectangle keeps", () => {
    const { cpp } =
        compileSource(`import {createEngine} from '@babylonjs/lite';await createEngine({});
        const panel=document.createElement('div');document.body.appendChild(panel);panel.style.zoom='2';
        panel.textContent=String(panel.offsetWidth+panel.getBoundingClientRect().width);`);
    assert.match(cpp, /"zoom", "2"/);
    assert.match(
        cpp,
        /std::round\(bbl::ui_get_client_rect\([^;]+\)\.unzoomed\(\)\.offset_width\)/,
    );
    assert.match(cpp, /->offset_width/);
});

test("native zoom scales lengths, fonts and effects down the tree and stays live", (t) =>
    runRmlUiFixture(t, "ui-zoom"));

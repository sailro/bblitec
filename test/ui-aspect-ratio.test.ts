import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const prefix = `import {createEngine} from '@babylonjs/lite';await createEngine({});`;

test("aspect-ratio lowers strictly from sheets, cssText and style writes", () => {
    const result = compileSource(
        `${prefix}const sheet=document.createElement('style');
        sheet.textContent='.thumb{aspect-ratio: 16 / 9; width: 100%; overflow: hidden}.square{aspect-ratio:1}.mixed{aspect-ratio:auto 4/3}';
        document.head.appendChild(sheet);
        const thumb=document.createElement('div');document.body.appendChild(thumb);
        thumb.style.cssText="width:100%;aspect-ratio:16/10;display:flex";
        thumb.style.aspectRatio='2 auto';`,
    );
    assert.equal(result.manifest.deferredCapabilities, undefined);
    assert.match(result.cpp, /aspect-ratio:16 \/ 9;width:100%/);
    assert.match(result.cpp, /aspect-ratio:auto 4\/3/);
    assert.match(result.cpp, /aspect-ratio:16\/10/);
    assert.match(result.cpp, /"aspect-ratio", "2 auto"/);
    for (const value of [
        "-1",
        "+1",
        "16 /",
        "auto auto",
        "1/2/3",
        "calc(1)",
        "1e40",
        "16:9",
    ])
        assert.throws(
            () =>
                compileSource(
                    `${prefix}const panel=document.createElement('div');panel.style.cssText=${JSON.stringify(`aspect-ratio:${value}`)};`,
                ),
            /Retained UI style property 'aspect-ratio'/,
            value,
        );
});

test("native aspect ratios size block, flex and border-box boxes and refuse unrepresented forms", (t) =>
    runRmlUiFixture(t, "ui-aspect-ratio"));

import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const prefix = `import {createEngine} from '@babylonjs/lite';await createEngine({});`;

test("clip-path insets and polygons lower strictly from sheets, cssText and style writes", () => {
    const result = compileSource(
        `${prefix}const sheet=document.createElement('style');
        sheet.textContent='.cmd{clip-path:polygon(6px 0,100% 0,100% calc(100% - 6px),calc(100% - 6px) 100%,0 100%,0 6px)}' +
            '.mark{clip-path:polygon(9% 2%,87% 0,100% 17%,95% 89%,77% 100%,7% 93%,0 21%)}.bake{clip-path: inset(6px); }' +
            '.flat{clip-path:none}.star{clip-path:polygon(evenodd, 50% 0, 79% 90%, 2% 35%)}' +
            '.fill{transition: clip-path 110ms cubic-bezier(.2, .9, .3, 1.35)}';
        document.head.appendChild(sheet);
        const fill=document.createElement('div');document.body.appendChild(fill);
        fill.style.cssText='clip-path:inset(0 10px 20% 5%)';
        const f=(Math.random()).toFixed(4);
        fill.style.clipPath=\`inset(0 calc(100% - 26px - \${f} * (100% - 52px)) 0 0)\`;
        fill.style.clipPath='inset(1px 2px)';`,
    );
    assert.equal(result.manifest.deferredCapabilities, undefined);
    assert.match(
        result.cpp,
        /clip-path:polygon\(6px 0,100% 0,100% calc\(100% - 6px\),calc\(100% - 6px\) 100%,0 100%,0 6px\)/,
    );
    assert.match(result.cpp, /clip-path:inset\(6px\)/);
    assert.match(result.cpp, /clip-path:inset\(0 10px 20% 5%\)/);
    assert.match(result.cpp, /"clip-path", "inset\(1px 2px\)"/);
    for (const value of [
        "circle(40%)",
        "ellipse(10px 20px)",
        "path('M0 0')",
        "url(#mask)",
        "inset(6px round 4px)",
        "inset(1px 2px 3px 4px 5px)",
        "inset()",
        "inset(6px) border-box",
        "polygon(1px)",
        "polygon(0 0,)",
        "polygon(1em 0)",
        "polygon(calc(100%-6px) 0)",
        "inset(calc(6))",
        "inset(calc(2px * 3px))",
        "inset(calc(6px / 0px))",
        "inset(var(--edge))",
        "inset(5)",
    ])
        assert.throws(
            () =>
                compileSource(
                    `${prefix}const panel=document.createElement('div');panel.style.cssText=${JSON.stringify(`clip-path:${value}`)};`,
                ),
            /Retained UI style property 'clip-path'/,
            value,
        );
});

test("native clip-path clips paint, hit tests, filter composites and transitions", (t) =>
    runRmlUiFixture(t, "ui-clip-path"));

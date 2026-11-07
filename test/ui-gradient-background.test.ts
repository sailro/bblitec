import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { uiGradientBackground } from "../src/ui-gradient-background.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("gradient background layers retain independent dimensions, positions and nested color functions", () => {
    assert.equal(
        uiGradientBackground("linear-gradient(red,blue)"),
        "linear-gradient(red,blue)",
    );
    assert.equal(
        uiGradientBackground(
            "linear-gradient(rgb(1,2,3),rgba(4,5,6,.5)) right bottom/12px 25% no-repeat,radial-gradient(red,blue) top left/auto 10px no-repeat",
        ),
        "linear-gradient(rgb(1,2,3),rgba(4,5,6,.5)) padding-box / 12px 25% / 100% 100%,radial-gradient(red,blue) padding-box / 100% 10px / 0% 0%",
    );
    // Origin and clip boxes: the decorator paints in the clip box, placed in the origin box.
    assert.equal(
        uiGradientBackground(
            "linear-gradient(red,red) -2px -2px / calc(100% + 4px) calc(100% + 4px) no-repeat padding-box border-box",
        ),
        "linear-gradient(red,red) border-box / calc(100% + 4px) calc(100% + 4px) / -2px -2px / padding-box",
    );
    assert.equal(
        uiGradientBackground(
            "linear-gradient(red,red) 0 0/4px 4px no-repeat content-box",
        ),
        "linear-gradient(red,red) content-box / 4px 4px / 0 0",
    );
    // A layer repeats unless no-repeat says otherwise: its decorator tiles the paint box.
    for (const value of [
        "linear-gradient(red,blue) center/2px 22px repeat",
        "linear-gradient(red,blue) center/2px 22px",
    ])
        assert.equal(
            uiGradientBackground(value),
            "linear-gradient(red,blue) padding-box repeat / 2px 22px / 50% 50%",
        );
    for (const value of [
        "linear-gradient(red,blue) center/2px 22px repeat-x",
        "linear-gradient(red,blue) center/2px 22px space",
        "linear-gradient(red,blue) center/2px 22px repeat no-repeat",
        "linear-gradient(red,blue) center/-2px 22px no-repeat",
        "linear-gradient(red,blue) left 2px bottom 3px/2px 22px no-repeat",
        "linear-gradient(red,blue) center/contain no-repeat",
        "linear-gradient(red,blue) constructor/2px 22px no-repeat",
    ]) {
        assert.equal(uiGradientBackground(value), undefined, value);
        assert.throws(
            () =>
                compileSource(
                    `import {createEngine} from "@babylonjs/lite"; await createEngine({}); const e=document.createElement("div"); e.style.cssText=${JSON.stringify(`background:${value}`)}; document.body.appendChild(e);`,
                ),
            /gradient layers require/,
        );
    }
});

test("background none is the image layer alone; the colour takes its initial value", () => {
    const result = compileSource(
        `import {createEngine} from "@babylonjs/lite"; await createEngine({}); const sheet=document.createElement("style"); sheet.textContent=".plain{background:red}.plain.reset{background: NONE }"; document.head.appendChild(sheet);`,
    );
    assert.match(
        result.cpp,
        /bbl-background-image:none;[^"]*background-color:transparent"/,
    );
    assert.doesNotMatch(result.cpp, /background-color:\s*none/i);
});

test("a background shorthand resets an earlier background-clip of its rule", () => {
    const compile = (style: string) =>
        compileSource(
            `import {createEngine} from "@babylonjs/lite"; await createEngine({}); const e=document.createElement("div"); e.style.cssText=${JSON.stringify(style)}; document.body.appendChild(e);`,
        );
    assert.doesNotThrow(() =>
        compile(
            "background-clip:padding-box;background:linear-gradient(red,red) 0 0/4px 4px no-repeat;",
        ),
    );
    assert.throws(
        () =>
            compile(
                "background:linear-gradient(red,red) 0 0/4px 4px no-repeat;background-clip:padding-box;",
            ),
        /box clipping currently applies to solid backgrounds/,
    );
    // Plain gradient layers paint in the clip box the cascade gives them.
    assert.doesNotThrow(() =>
        compile(
            "background:linear-gradient(#9a6f3b,#82592e);background-clip:padding-box;",
        ),
    );
    assert.throws(
        () =>
            compile(
                "background:linear-gradient(#9a6f3b,#82592e);background-clip:content-box;",
            ),
        /box clipping currently applies to solid backgrounds/,
    );
});

test("native sized layers preserve gradient coordinates, paint order, content and live layout", (t) => {
    const layers = uiGradientBackground(
        "linear-gradient(red,red) center/4px 32px no-repeat,linear-gradient(blue,blue) right bottom/40px 6px no-repeat",
    )!;
    const resized = uiGradientBackground(
        "linear-gradient(to right,red,blue) center/50% 25% no-repeat",
    )!;
    mkdirSync("artifacts/ui-gradient-background", { recursive: true });
    writeFileSync(
        "artifacts/ui-gradient-background/styles.hpp",
        `constexpr const char* layers = ${JSON.stringify(`bbl-background-image:${layers};`)};\nconstexpr const char* resized = ${JSON.stringify(`bbl-background-image:${resized};`)};\n`,
    );
    runRmlUiFixture(t, "ui-gradient-background");
});

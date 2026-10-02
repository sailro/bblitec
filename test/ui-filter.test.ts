import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { supportedUiBoxShadow, supportedUiFilter } from "../src/ui-filters.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("ordinary retained filters survive projection and refuse unsupported forms", () => {
    const filters =
        "brightness(50%) contrast(1.5) saturate(0.8) hue-rotate(-30deg) invert(20%) grayscale(1) sepia(.5) opacity(90%) blur(2px) drop-shadow(0 12px 26px rgba(10,20,30,.5))";
    assert.ok(supportedUiFilter(filters));
    assert.ok(
        supportedUiFilter(
            "drop-shadow(red -4px 2px) drop-shadow(0 0 1px #abcd)",
        ),
    );
    for (const invalid of [
        "url(mask.svg)",
        "blur(-1px)",
        "blur(1em)",
        "brightness(NaN)",
        "drop-shadow(0 0 unknown)",
        "drop-shadow(0 0 #12345)",
        "drop-shadow(0 0 rgb(a,b,c))",
        "brightness(1)blur(2px)",
        "drop-shadow(0 0 rgba(20%,30%,40%,.5))",
        "drop-shadow(0 0 var(--Color))",
        `brightness(${"9".repeat(50)})`,
    ])
        assert.equal(supportedUiFilter(invalid), false, invalid);
    for (const value of [
        "brightness(calc(1 - var(--Tone, 0) * .3)) saturate(calc(1 - var(--Tone) * .18))",
        "drop-shadow(0 0 calc(var(--Tone) * 12px) rgba(255,172,88,calc(var(--Tone) * .2)))",
        "drop-shadow(0 4px currentColor) drop-shadow(-2px 3px 1px)",
    ])
        assert.ok(supportedUiFilter(value), value);
    assert.equal(supportedUiBoxShadow("0 0 var(--Color, 2px)"), false);
    assert.equal(supportedUiBoxShadow("0 0 currentColor"), false);
    const compile = (value: string) =>
        compileSource(`
        import { createEngine } from "@babylonjs/lite";
        const engine = await createEngine({});
        const panel = document.createElement("div");
        panel.style.cssText = ${JSON.stringify(`filter:${filters};`)};
        document.body.appendChild(panel);
        panel.style.filter = ${JSON.stringify(value)};
    `);
    assert.ok(compile("none").cpp.includes(`filter:${filters}`));
    assert.match(
        compile("brightness(calc(1 - var(--Tone, 0) * .3))").cpp,
        /--Tone/,
    );
    assert.match(
        compile("drop-shadow(0 4px currentColor)").cpp,
        /currentColor/,
    );
    assert.throws(() => compile("url(mask.svg)"), /only color adjustments/);
});

test("native retained filters preserve nested layers, color parameters, shadows and backdrop order", (t) => {
    runRmlUiFixture(t, "ui-filter");
});

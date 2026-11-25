import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("getComputedStyle reads custom properties by name and represented properties by CSS name", () => {
    const { cpp } = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        await createEngine({});
        const menu = document.createElement("div");
        document.body.appendChild(menu);
        const gap = Number.parseFloat(getComputedStyle(menu).getPropertyValue("--menu-gap"));
        menu.textContent = String(gap) + getComputedStyle(menu).getPropertyValue("Z-Index");
        const style = getComputedStyle(menu);
        menu.title = style.getPropertyValue("--menu-title");
    `);
    assert.match(cpp, /bbl::ui_computed_style\([^;]*"--menu-gap"\)/);
    assert.match(cpp, /bbl::ui_computed_style\([^;]*"--menu-title"\)/);
    assert.match(cpp, /bbl::ui_computed_style\([^;]*"z-index"\)/);
    assert.throws(
        () =>
            compileSource(`
                const menu = document.createElement("div");
                document.body.appendChild(menu);
                menu.textContent = getComputedStyle(menu).getPropertyValue("width");
            `),
        /Computed style 'width' is not represented/,
    );
});

test("native computed custom properties read the specified text through the cascade", (t) =>
    runRmlUiFixture(t, "ui-computed-custom-properties"));

test("getComputedStyle reads box sizing, padding and border widths", () => {
    const { cpp } = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        await createEngine({});
        const plate = document.createElement("div");
        document.body.appendChild(plate);
        const css = getComputedStyle(plate);
        const px = (value: string): number => parseFloat(value) || 0;
        const frame = css.boxSizing === "border-box" ? 0
            : px(css.paddingTop) + px(css.paddingBottom) + px(css.borderTopWidth) + px(css.borderBottomWidth);
        plate.style.minHeight = \`\${(40 - frame).toFixed(1)}px\`;
        plate.title = css.getPropertyValue("Padding-Left") + css.borderLeftWidth;
    `);
    for (const name of [
        "box-sizing",
        "padding-top",
        "padding-bottom",
        "padding-left",
        "border-top-width",
        "border-bottom-width",
        "border-left-width",
    ])
        assert.match(
            cpp,
            new RegExp(`bbl::ui_computed_style\\([^;]*"${name}"\\)`),
            name,
        );
});

test("native computed box edges are the used padding and border widths", (t) =>
    runRmlUiFixture(t, "ui-computed-box-edges"));

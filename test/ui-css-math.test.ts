import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    CSS_LAYOUT_PERCENTAGE_PROPERTIES,
    UI_SAFE_AREA_ENVIRONMENT,
    uiCssMathRefusal,
} from "../src/ui-css-math.js";

test("CSS math refusals follow the shapes the native math folds", () => {
    for (const [property, value] of [
        ["width", "calc(100% - 20px)"],
        ["max-width", "min(260px,100%)"],
        ["top", "calc(2 * (25% + 1.5px) + 1vw)"],
        ["width", "clamp(10px,50%,calc(100% - 4px))"],
        ["left", "calc(-1 * min(50%, 20px))"],
        ["max-width", "calc(100% + var(--a) + var(--a) - var(--b))"],
        ["--inset", "calc(100% - 4px)"],
        ["width", "min(310px,calc(100vw - 36px))"],
        ["transition", "opacity calc(0.2s + 100ms)"],
        // A safe-area inset substitutes a length; another variable its fallback.
        [
            "padding",
            "12px max(14px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom))",
        ],
        ["top", "calc(env(notch-height, 8px) + 4px)"],
        [
            "background",
            "linear-gradient(red, blue) 6px 6px / calc(100% - 6px) calc(100% - 12px) no-repeat",
        ],
    ])
        assert.equal(
            uiCssMathRefusal(property!, value!),
            undefined,
            `${property}: ${value}`,
        );
    for (const [property, value] of [
        ["transform-origin", "calc(100% - 30px) 0"],
        ["width", "min(10px,50%,calc(100% - 4px))"],
        ["width", "max(1px,min(50%,20px))"],
        ["width", "calc(50% * 50%)"],
        ["width", "calc(1em + 2px)"],
        ["width", "calc(1px + 1s)"],
        ["font-size", "calc(1rem + 2px)"],
        // The native host defines the safe-area insets alone.
        ["top", "calc(env(notch-height) + 4px)"],
        ["width", "calc(env(safe-area-inset-left) + 1s)"],
        // A gradient's own stops are not its layer box.
        ["background", "linear-gradient(red calc(50% - 2px), blue)"],
    ])
        assert.notEqual(
            uiCssMathRefusal(property!, value!),
            undefined,
            `${property}: ${value}`,
        );
});

test("the layout percentage properties are the native math's", () => {
    const header = readFileSync("native/src/pal_ui_length_math.hpp", "utf8");
    const list = /css_layout_percentage_property[\s\S]*?\{([\s\S]*?)\};/.exec(
        header,
    )?.[1];
    assert.ok(list);
    assert.deepEqual(
        new Set([...list.matchAll(/"([^"]+)"/g)].map((match) => match[1])),
        CSS_LAYOUT_PERCENTAGE_PROPERTIES,
    );
});

test("the safe-area environment variables are the native host's", () => {
    const header = readFileSync("native/src/pal_ui_length_math.hpp", "utf8");
    const body = /rml_css_environment\(std::string[\s\S]*?\n\}/.exec(
        header,
    )?.[0];
    assert.ok(body);
    assert.deepEqual(
        new Set(
            [...body.matchAll(/name == "([^"]+)"/g)].map((match) => match[1]),
        ),
        UI_SAFE_AREA_ENVIRONMENT,
    );
});

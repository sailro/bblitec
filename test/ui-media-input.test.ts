import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const sheetProgram = (sheet: string): string => `
    import { createEngine } from "@babylonjs/lite";
    await createEngine({});
    const sheet = document.createElement("style");
    sheet.textContent = ${JSON.stringify(sheet)};
    document.head.appendChild(sheet);
`;

test("hover and pointer media features lower to run-time device conditions", () => {
    const { cpp } = compileSource(
        sheetProgram(
            "@media (hover: none) and (pointer: coarse){.touch{display:flex;}}" +
                "@media (pointer:fine){.touch{width:10px;}}" +
                "@media (max-width: 600px) and (orientation: portrait){.touch{height:4px;}}",
        ),
    );
    assert.match(
        cpp,
        /ui_add_style_rule\([^\n]+"display: ?flex;[^"]*"[^\n]+\.media = \{\.hover = false, \.pointer = bbl::PointerPrecision::Coarse\}\}\);/,
    );
    assert.match(
        cpp,
        /ui_add_style_rule\([^\n]+"width: ?10px;?", \.media = \{\.pointer = bbl::PointerPrecision::Fine\}\}\);/,
    );
    assert.match(
        cpp,
        /ui_add_style_rule\([^\n]+"height: ?4px;?", \.max_width = 600\.0, \.orientation = bbl::UiOrientation::Portrait\}\);/,
    );
});

test("other media queries refuse", () => {
    for (const query of [
        "(any-pointer: coarse)",
        "(hover: none) and (hover: hover)",
        "(hover: none), (pointer: coarse)",
        "(hover: none) or (pointer: coarse)",
        "not (hover: none)",
        "(pointer: precise)",
    ])
        assert.throws(
            () =>
                compileSource(
                    sheetProgram(`@media ${query}{.touch{width:1px;}}`),
                ),
            /Retained stylesheet selector '@media/,
            query,
        );
});

test("hover and pointer media rules follow the device's pointing input", (t) => {
    runRmlUiFixture(t, "ui-media-input");
});

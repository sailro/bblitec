import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const sheet = (
    css: string,
): string => `import {createEngine} from "@babylonjs/lite";
    await createEngine({});
    const sheet = document.createElement("style");
    sheet.textContent = ${JSON.stringify(css)};
    document.head.appendChild(sheet);`;

test("color-scheme, accent-color and text-decoration lower as retained declarations", () => {
    const cpp = compileSource(
        sheet(
            ":root{color-scheme:dark}.a{color-scheme:light}.b{color-scheme:normal}" +
                ".c{accent-color:#58c6ff}.d{accent-color:rgb(1, 2, 3)}.e{accent-color:auto}" +
                ".f{accent-color:rgba(1,2,3,1)}.g{accent-color:teal}" +
                ".j{accent-color:var(--accent)}" +
                ".h{text-decoration:none}.i{text-decoration:line-through}",
        ),
    ).cpp;
    for (const declaration of [
        "color-scheme:dark",
        "accent-color:#58c6ff",
        "accent-color:rgb(1, 2, 3)",
        // A variable's color is checked as the PAL projects it (ui_accent_color).
        "accent-color:var(--accent)",
        "text-decoration:line-through",
    ])
        assert.ok(cpp.includes(declaration), declaration);
});

test("color-scheme lists, translucent accents and decoration details refuse", () => {
    for (const [css, pattern] of [
        [
            ".a{color-scheme:light dark}",
            /'color-scheme'[^]*only normal, light, dark/,
        ],
        [".a{color-scheme:only dark}", /'color-scheme'/],
        [
            ".a{accent-color:rgba(88,198,255,0.5)}",
            /'accent-color'[^]*opaque literal/,
        ],
        [".a{accent-color:transparent}", /'accent-color'/],
        [".a{accent-color:#58c6ff80}", /'accent-color'/],
        [".a{text-decoration:underline red}", /'text-decoration'/],
        [".a{text-decoration:underline wavy}", /'text-decoration'/],
    ] as const)
        assert.throws(() => compileSource(sheet(css)), pattern, css);
});

test("native control palettes follow color-scheme, accent-color and Chromium's select metrics", (t) =>
    runRmlUiFixture(t, "ui-control-scheme"));

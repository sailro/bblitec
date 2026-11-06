import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const page = (css: string) => `
    import { createEngine } from "@babylonjs/lite";
    await createEngine({});
    const style = document.createElement("style");
    style.textContent = ${JSON.stringify(css)};
    document.head.appendChild(style);
    const description = document.createElement("div");
    description.className = "description";
    description.textContent = "A description that wraps past the lines its box shows.";
    document.body.appendChild(description);
`;

test("a legacy line clamp reaches the native sheet; unrepresented display values and clamps refuse", () => {
    const result = compileSource(
        page(
            ".description { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }",
        ),
    );
    assert.match(
        result.cpp,
        /display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2/,
    );
    for (const css of [
        ".description { display: contents; }",
        ".description { display: list-item; }",
        ".description { -webkit-line-clamp: 0; }",
        ".description { -webkit-box-orient: sideways; }",
    ])
        assert.throws(
            () => compileSource(page(css)),
            /the value requires layout outside the supported literal flex and box forms/,
        );
});

test("a clamped legacy box ends at its clamp line in an ellipsis; without the clamp it is a flex container", (t) => {
    runRmlUiFixture(t, "ui-line-clamp");
});

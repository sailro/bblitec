import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runApplicationRmlUiFixture } from "./rmlui-application-fixture.js";

// test/fixtures/ui-image-background-check.cpp renders what these emit.
test("a CSS-wide keyword on the background shorthand is every longhand's value", () => {
    const { cpp } = compileSource(`
        const style = document.createElement("style");
        style.textContent = ".art::before { content: ''; background: inherit; background-size: contain; } .plain { background: unset; } .clip { background-clip: initial; }";
        document.head.appendChild(style);
        globalThis.close();
    `);
    assert.match(
        cpp,
        /--bbl-background-clip:inherit;--bbl-background-image:inherit;--bbl-background-size:inherit;--bbl-background-position:inherit;--bbl-background-repeat:inherit;--bbl-background-origin:inherit;--bbl-background-attachment:inherit;--bbl-background-color:inherit;--bbl-background-size:contain/,
    );
    assert.match(
        cpp,
        /--bbl-background-clip:unset;--bbl-background-image:unset;[^"]*--bbl-background-color:unset/,
    );
    assert.match(cpp, /--bbl-background-clip:initial/);
});

test("background keywords run end-to-end through generated declarations and RmlUi", (t) => {
    runApplicationRmlUiFixture(
        t,
        "ui-background-keywords",
        `
        const style = document.createElement("style");
        style.textContent = ".inherit { background: inherit; } .initial { background: initial; } .unset { background: unset; }";
        document.head.appendChild(style);
        const parent = document.createElement("div");
        parent.id = "parent";
        parent.style.cssText = "background: #123456; background-clip: padding-box;";
        parent.setAttribute("data-keyword", "inherit");
        document.body.appendChild(parent);
        for (const keyword of ["inherit", "initial", "unset"]) {
            const child = document.createElement("div");
            child.id = keyword;
            child.className = keyword;
            parent.appendChild(child);
        }
        const written = document.createElement("div");
        written.id = "written";
        parent.appendChild(written);
        written.style.background = parent.getAttribute("data-keyword") || "initial";
        globalThis.close();
    `,
    );
});

test("a run-time background write gives every longhand the same keyword", () => {
    const { cpp } = compileSource(`
        const panel = document.createElement("div");
        document.body.appendChild(panel);
        panel.style.background = "initial";
        const colour = String(Math.random());
        panel.style.background = colour;
        globalThis.close();
    `);
    for (const longhand of ["clip", "image", "size", "attachment"])
        assert.match(
            cpp,
            new RegExp(
                `ui_set_style_property\\([^\\n]+"--bbl-background-${longhand}", "initial"\\);`,
            ),
        );
    assert.match(
        cpp,
        /ui_set_style_property\([^\n]+"--bbl-background-color", "initial"\);/,
    );
    assert.match(
        cpp,
        /ui_set_style_property\([^\n]+"--bbl-background-image", bbl::ui_background_longhand\((\w+), "none"\)\);/,
    );
    assert.match(
        cpp,
        /ui_set_style_property\([^\n]+"--bbl-background-clip", bbl::ui_background_longhand\(\w+, ""\)\);/,
    );
});

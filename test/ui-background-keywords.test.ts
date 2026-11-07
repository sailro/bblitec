import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runApplicationRmlUiFixture } from "./rmlui-application-fixture.js";

// test/fixtures/ui-image-background-check.cpp renders what these emit.
test("a CSS-wide keyword on the background shorthand is every longhand's value", () => {
    const { cpp } = compileSource(`
        const style = document.createElement("style");
        style.textContent = ".art::before { content: ''; background: inherit; background-size: contain; } .plain { background: unset; } .clip { background-clip: initial; } .ua { background: revert-layer; }";
        document.head.appendChild(style);
        globalThis.close();
    `);
    assert.match(
        cpp,
        /background-clip:inherit;bbl-background-image:inherit;bbl-background-size:inherit;bbl-background-position:inherit;bbl-background-repeat:inherit;bbl-background-origin:inherit;bbl-background-attachment:inherit;background-color:inherit;bbl-background-size:contain/,
    );
    assert.match(
        cpp,
        /background-clip:unset;bbl-background-image:unset;[^"]*background-color:unset/,
    );
    assert.match(cpp, /"background-clip:initial;"/);
    assert.match(
        cpp,
        /background-clip:revert;bbl-background-image:revert;[^"]*background-color:revert/,
    );
});

test("background keywords run end-to-end through generated declarations and RmlUi", (t) => {
    runApplicationRmlUiFixture(
        t,
        "ui-background-keywords",
        `
        const style = document.createElement("style");
        style.textContent = ".inherit { background: inherit; } .initial { background: initial; } .unset { background: unset; } .revert { background: revert; }";
        document.head.appendChild(style);
        const parent = document.createElement("div");
        parent.id = "parent";
        parent.style.cssText = "background: #123456; background-clip: padding-box;";
        parent.setAttribute("data-keyword", "inherit");
        document.body.appendChild(parent);
        for (const keyword of ["inherit", "initial", "unset", "revert"]) {
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
    for (const longhand of [
        "background-clip",
        "bbl-background-image",
        "bbl-background-size",
        "bbl-background-attachment",
    ])
        assert.match(
            cpp,
            new RegExp(
                `ui_set_style_property\\([^\\n]+"${longhand}", "initial"\\);`,
            ),
        );
    // The value itself goes last: the PAL tells a colour from gradient layers.
    assert.match(cpp, /ui_set_background\([^\n]+, "initial"\);/);
    assert.match(cpp, /ui_set_background\([^\n]+, \w+\);/);
    assert.match(
        cpp,
        /ui_set_style_property\([^\n]+"bbl-background-image", bbl::ui_background_longhand\((\w+), "none"\)\);/,
    );
    assert.match(
        cpp,
        /ui_set_style_property\([^\n]+"background-clip", bbl::ui_background_longhand\(\w+, "border-box"\)\);/,
    );
});

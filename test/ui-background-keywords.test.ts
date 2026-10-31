import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

test("a CSS-wide keyword on the background shorthand is every longhand's value", () => {
    const { cpp } = compileSource(`
        const style = document.createElement("style");
        style.textContent = ".art::before { content: ''; background: inherit; background-size: contain; } .plain { background: unset; }";
        document.head.appendChild(style);
        globalThis.close();
    `);
    assert.match(
        cpp,
        /--bbl-background-clip:inherit;--bbl-background-image:inherit;--bbl-background-size:inherit;--bbl-background-position:inherit;--bbl-background-repeat:inherit;--bbl-background-origin:inherit;--bbl-background-attachment:inherit;--bbl-background-color:inherit;--bbl-background-size:contain/,
    );
    assert.match(cpp, /--bbl-background-image:unset;/);
});

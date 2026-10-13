import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runApplicationRmlUiFixture } from "./rmlui-application-fixture.js";

// calc()/min() over var(): lengths from inline and inherited custom
// properties (themselves math over var()), numbers, colour alpha and times.
const program = `
    const sheet = document.createElement("style");
    sheet.textContent = \`
        body { --scale: 1.25; --vw: calc(1vw / var(--scale)); }
        .bar { height: 4px; width: calc(var(--n) * 10px); }
        .viewport { height: 4px; width: min(300px, calc(50 * var(--vw))); }
        .night { width: 4px; height: 4px; opacity: calc(1 - var(--night) * 0.5); color: rgba(10, 20, 30, calc(var(--night) * 0.5)); }
        .key { width: 4px; height: 4px; opacity: 0; transition: opacity 100ms linear; transition-delay: calc(var(--i, 0) * 18ms); }
        .key.on { opacity: 1; }
    \`;
    document.head.appendChild(sheet);
    const make = (id: string): HTMLDivElement => {
        const element = document.createElement("div");
        element.id = id;
        element.className = id;
        document.body.appendChild(element);
        return element;
    };
    const bar = make("bar");
    bar.style.setProperty("--n", "3");
    make("viewport");
    const night = make("night");
    night.style.setProperty("--night", "0.6");
    const key = make("key");
    key.style.setProperty("--i", String(2));
    globalThis.close();
`;

test("math over var() resolves natively after substitution", (t) => {
    runApplicationRmlUiFixture(t, "ui-variable-math", program);
});

test("math over var() with unresolvable units refuses at generation", () => {
    const prefix = `const panel = document.createElement("div");`;
    for (const [declaration, unit] of [
        ["width: calc(var(--x) * 2em)", /'em'/],
        ["width: calc(100% - var(--x))", /'%'/],
        ["--size: min(4ch, var(--x))", /'ch'/],
    ] as const)
        assert.throws(
            () =>
                compileSource(
                    `${prefix}panel.style.cssText = ${JSON.stringify(declaration)};`,
                ),
            unit,
        );
    assert.doesNotThrow(() =>
        compileSource(
            `${prefix}panel.style.cssText = "width: calc(94 * var(--dvh)); height: calc(var(--b2b) * 1dvh)";`,
        ),
    );
});

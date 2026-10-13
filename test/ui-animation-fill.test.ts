import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runApplicationRmlUiFixture } from "./rmlui-application-fixture.js";

// Animation shorthands with fill-mode and direction keywords, in any order.
const program = `
    const sheet = document.createElement("style");
    sheet.textContent = \`
        .box { width: 10px; height: 4px; opacity: 0.5; }
        .both.go { animation: fade 100ms linear 100ms both; }
        .forwards.go { animation: fade 100ms linear forwards; }
        .plain.go { animation: fade 100ms linear; }
        .reverse.go { animation: fade 100ms linear reverse forwards; }
        .alternate.go { animation: fade 100ms linear 2 alternate-reverse forwards; }
        .leading.go { animation: backwards fade 100ms linear; }
        @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    \`;
    document.head.appendChild(sheet);
    for (const id of ["both", "forwards", "plain", "reverse", "alternate", "leading"]) {
        const element = document.createElement("div");
        element.id = id;
        element.className = id + " box";
        document.body.appendChild(element);
    }
    globalThis.close();
`;

test("animation fill modes and directions run natively", (t) => {
    runApplicationRmlUiFixture(t, "ui-animation-fill", program);
});

test("unrepresented animation shorthands refuse at generation", () => {
    const prefix = `const panel = document.createElement("div");`;
    for (const [value, diagnostic] of [
        ["spin 1s paused", /paused animations/],
        ["spin 0s forwards", /positive duration/],
        ["spin 1s 1.5", /whole iteration counts/],
        ["spin 1s 0", /whole iteration counts/],
    ] as const)
        assert.throws(
            () =>
                compileSource(
                    `${prefix}panel.style.animation = ${JSON.stringify(value)};`,
                ),
            diagnostic,
        );
    for (const value of [
        "none",
        "1s",
        "forwards forwards 1s",
        "spin 1s running both reverse 3",
    ])
        assert.doesNotThrow(() =>
            compileSource(
                `${prefix}panel.style.animation = ${JSON.stringify(value)};`,
            ),
        );
});

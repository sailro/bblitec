import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runApplicationRmlUiFixture } from "./rmlui-application-fixture.js";

// Easing functions inside multi-item transition and animation lists, the
// initial `ease`, and a keyframe blink with steps().
const program = `
    const sheet = document.createElement("style");
    sheet.textContent = \`
        .curve { width: 10px; height: 4px; transition: opacity 100ms ease, width 100ms cubic-bezier(.2, .9, .3, 1.5); opacity: 0; }
        .curve.on { width: 110px; opacity: 1; }
        .stepped { width: 10px; height: 4px; transition: width 100ms steps(4, jump-end), opacity 100ms step-start; opacity: 0; }
        .stepped.on { width: 110px; opacity: 1; }
        .initial { opacity: 0; transition: opacity 100ms; }
        .initial.on { opacity: 1; }
        .blink { width: 4px; height: 4px; animation: blink 1s steps(1, end) infinite; }
        @keyframes blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
    \`;
    document.head.appendChild(sheet);
    for (const id of ["curve", "stepped", "initial", "blink"]) {
        const element = document.createElement("div");
        element.id = id;
        element.className = id;
        document.body.appendChild(element);
    }
    globalThis.close();
`;

test("easing functions run natively with their CSS curves", (t) => {
    runApplicationRmlUiFixture(t, "ui-easing", program);
});

test("unrepresented easing functions refuse at generation", () => {
    const prefix = `const panel = document.createElement("div");`;
    for (const [write, diagnostic] of [
        [
            `panel.style.transition = "opacity 1s linear(0, 0.5, 1)";`,
            /linear\(\) easing/,
        ],
        [
            `panel.style.cssText = "transition: opacity 1s cubic-bezier(2, 0, 0, 1)";`,
            /x1 and x2 in \[0, 1\]/,
        ],
        [
            `panel.style.animation = "spin 1s steps(1, jump-none) infinite";`,
            /at least 2 for jump-none/,
        ],
        [
            `panel.style.animation = "spin 1s steps(2.5)";`,
            /positive integer count/,
        ],
    ] as const)
        assert.throws(() => compileSource(prefix + write), diagnostic);
    assert.doesNotThrow(() =>
        compileSource(
            prefix +
                `panel.style.transition = "opacity 1s steps(3, jump-none), width 1s cubic-bezier(0, -1, 1, 2)";`,
        ),
    );
});

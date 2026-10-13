import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const directory = resolve("artifacts/ui-important");

// Important sheet declarations against more specific selectors, later normal
// declarations, inline styles and CSSOM writes; important inline styles; a
// hide-everything-but rule; and an important shorthand's delay reset.
const program = `
    const sheet = document.createElement("style");
    sheet.textContent = \`
        .box { width: 10px; height: 4px; opacity: 0.25 !important; }
        #specific { opacity: 0.5; }
        .order { opacity: 0.75 ! IMPORTANT; opacity: 0.1; visibility: hidden !important; }
        body.chrome-hidden > *:not(.keep) { display: none !important; }
        .shown { display: block; width: 8px; height: 4px; }
        .fade { opacity: 0; transition: opacity 100ms linear !important; }
        .fade.on { opacity: 1; }
    \`;
    document.head.appendChild(sheet);
    const make = (id: string, className: string): HTMLDivElement => {
        const element = document.createElement("div");
        element.id = id;
        element.className = className;
        document.body.appendChild(element);
        return element;
    };
    make("specific", "box");
    make("cssom", "box").style.opacity = "1";
    make("inline", "box").style.cssText = "opacity: 0.6 !important";
    make("order", "order box");
    make("hidden", "shown");
    make("kept", "shown keep");
    make("fade", "fade").style.transitionDelay = "50ms";
    document.body.classList.add("chrome-hidden");
    globalThis.close();
`;

test("important declarations keep their mark through lowering", () => {
    const result = compileSource(program);
    assert.match(result.cpp, /opacity:0\.25 !important/);
    assert.match(result.cpp, /visibility:hidden !important/);
    assert.match(result.cpp, /display:none !important/);
    assert.match(
        result.cpp,
        /"opacity: 0\.6 !important"|opacity:0\.6 !important/,
    );
    assert.throws(
        () =>
            compileSource(
                `const element = document.createElement("div"); element.style.setProperty("color", "red", "important");`,
            ),
        /priority/,
    );
});

test("important declarations win the native cascade", (t) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        ${program}`,
        { fileName: join(directory, "entry.ts") },
    );
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "ui-important", {
        macros: { BBLITE_WORKERS: 1, BBLITE_OFFSCREEN_SURFACES: 1 },
    });
});

import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runApplicationRmlUiFixture } from "./rmlui-application-fixture.js";

// Important sheet declarations against more specific selectors, later normal
// declarations, inline styles and CSSOM writes; important inline styles and
// CSSOM writes with the important priority; a hide-everything-but rule; and an
// important shorthand's delay reset.
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
    const survivor = make("survivor", "shown");
    survivor.style.setProperty("display", "block", "important");
    make("plain", "box").style.opacity = "0.9 !important";
    const demoted = make("demoted", "shown");
    demoted.style.setProperty("display", "block", "IMPORTANT");
    demoted.style.display = "block";
    if (survivor.style.display !== "block" || survivor.style.getPropertyValue("display") !== "block")
        throw new Error("an important declaration reads without its mark");
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
    assert.match(
        result.cpp,
        /ui_set_important_style_property\([^;]*"display", "block"\)/,
    );
    assert.throws(
        () =>
            compileSource(
                `const element = document.createElement("div"); element.style.setProperty("color", "red", "high");`,
            ),
        /priority requires an empty string or 'important'/,
    );
    assert.throws(
        () =>
            compileSource(
                `const element = document.createElement("div"); element.style.setProperty("--tone", "red", "important");`,
            ),
        /An important '--tone' declaration is not represented/,
    );
});

test("important declarations win the native cascade", (t) => {
    runApplicationRmlUiFixture(t, "ui-important", program);
});

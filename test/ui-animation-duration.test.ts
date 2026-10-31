import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runApplicationRmlUiFixture } from "./rmlui-application-fixture.js";

// A sheet's animation-duration longhand after and before the shorthand, a
// reduced-motion rule's override and an inline duration list.
const program = `
    const style = document.createElement("style");
    style.textContent = \`
        .dot { width: 4px; height: 4px; animation: pulse 400ms linear infinite; }
        .slow { animation-duration: 800ms; }
        .reset { animation-duration: 800ms; animation: pulse 400ms linear infinite; }
        @media (prefers-reduced-motion: reduce) { .calm { animation-duration: 2.4s; } }
        @keyframes pulse { from { opacity: 0; } to { opacity: 1; } }
    \`;
    document.head.appendChild(style);
    for (const [id, className] of [["base", "dot"], ["slow", "dot slow"], ["reset", "dot reset"], ["calm", "dot calm"], ["inline", "dot"]]) {
        const dot = document.createElement("i");
        dot.id = id;
        dot.className = className;
        document.body.appendChild(dot);
    }
    const inline = document.getElementById("inline")!;
    inline.style.animationDuration = \`\${Number("1600")}ms\`;
    globalThis.close();
`;

test("the animation-duration longhand lowers from sheets, media rules and inline writes", () => {
    const result = compileSource(program);
    assert.match(
        result.cpp,
        /ui_set_style_property\([^;]+"animation-duration", bbl::js::concat\(/,
    );
    assert.match(result.cpp, /animation-duration:800ms/);
    assert.match(result.cpp, /animation-duration:2\.4s/);
    for (const value of ["0s", "-1s", "linear"])
        assert.throws(
            () =>
                compileSource(`
                    const style = document.createElement("style");
                    style.textContent = ".dot { animation-duration: ${value}; }";
                    document.head.appendChild(style);
                `),
            /'animation-duration' is not lowered: only auto or positive animation durations/,
        );
});

test("the animation-duration longhand runs natively: rule order, shorthand resets and inline lists", (t) => {
    runApplicationRmlUiFixture(t, "ui-animation-duration", program);
});

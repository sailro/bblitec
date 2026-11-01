import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runApplicationRmlUiFixture } from "./rmlui-application-fixture.js";

// Sheet duration longhands after and before their shorthands, a
// reduced-motion rule's override and inline duration lists.
const program = `
    const style = document.createElement("style");
    style.textContent = \`
        .dot { width: 4px; height: 4px; transition: opacity 400ms; animation: pulse 400ms linear infinite; }
        .fast { transition-duration: 0s; }
        .slow { animation-duration: 800ms; }
        .reset { animation-duration: 800ms; animation: pulse 400ms linear infinite; }
        .tween { width: 4px; height: 4px; opacity: 0; transition: opacity 400ms linear; }
        .long { transition-duration: 800ms; }
        .tween-reset { transition-duration: 800ms; transition: opacity 400ms linear; }
        .instant { transition-duration: 0s; }
        @media (prefers-reduced-motion: reduce) { .calm { animation-duration: 2.4s; } }
        @keyframes pulse { from { opacity: 0; } to { opacity: 1; } }
    \`;
    document.head.appendChild(style);
    for (const [id, className] of [["base", "dot"], ["slow", "dot slow"], ["reset", "dot reset"], ["calm", "dot calm"], ["inline", "dot fast"], ["tween", "tween long"], ["tween-reset", "tween tween-reset"], ["instant", "tween instant"]]) {
        const dot = document.createElement("i");
        dot.id = id;
        dot.className = className;
        document.body.appendChild(dot);
    }
    const inline = document.getElementById("inline")!;
    inline.style.animationDuration = \`\${Number("1600")}ms\`;
    inline.style.transitionDuration = \`\${Number("200")}ms\`;
    globalThis.close();
`;

test("duration longhands lower from sheets, media rules and inline writes", () => {
    const result = compileSource(program);
    assert.match(
        result.cpp,
        /ui_set_style_property\([^;]+"animation-duration", bbl::js::concat\(/,
    );
    assert.match(
        result.cpp,
        /ui_set_style_property\([^;]+"transition-duration", bbl::js::concat\(/,
    );
    assert.match(result.cpp, /animation-duration:800ms/);
    assert.match(result.cpp, /transition-duration:0s/);
    assert.match(result.cpp, /animation-duration:2\.4s/);
    for (const [property, value, reason] of [
        ["animation-duration", "0s", /zero-duration animations/],
        ["animation-duration", "-1s", /not negative/],
        ["transition-duration", "-1s", /not negative/],
        ["transition-duration", "linear", /not negative/],
    ] as const) {
        assert.throws(
            () =>
                compileSource(`
                    const style = document.createElement("style");
                    style.textContent = ".dot { ${property}: ${value}; }";
                    document.head.appendChild(style);
                `),
            reason,
        );
        const member =
            property === "animation-duration"
                ? "animationDuration"
                : "transitionDuration";
        assert.throws(
            () =>
                compileSource(`
            const dot = document.createElement("div");
            document.body.appendChild(dot);
            dot.style.${member} = ${JSON.stringify(value)};
        `),
            reason,
        );
    }
});

test("duration longhands run natively: rule order, shorthand resets and inline lists", (t) => {
    runApplicationRmlUiFixture(t, "ui-animation-duration", program);
});

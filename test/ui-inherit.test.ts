import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runApplicationRmlUiFixture } from "./rmlui-application-fixture.js";

// Form controls reading their container's font and colour over the user-agent
// control font, a property that does not inherit taken from the parent (its
// em length computed at the parent, the initial value where the parent
// declares none) and followed when the parent changes, and a CSSOM inherit.
const program = `
    const sheet = document.createElement("style");
    sheet.textContent = \`
        .panel { color: #e5eefb; font-size: 14px; line-height: 1.5; border-radius: 12px; }
        .panel.wide { border-radius: 20px; }
        select, button { font: inherit; color: inherit; }
        .round { border-radius: inherit; }
        .em { font-size: 20px; padding: 1em; }
        .pad { font-size: 10px; padding: inherit; }
        .written { color: #ff0000; }
    \`;
    document.head.appendChild(sheet);
    const panel = document.createElement("div");
    panel.id = "panel";
    panel.className = "panel";
    document.body.appendChild(panel);
    const select = document.createElement("select");
    select.id = "select";
    const option = document.createElement("option");
    option.textContent = "Route";
    select.appendChild(option);
    panel.appendChild(select);
    const button = document.createElement("button");
    button.id = "button";
    button.textContent = "Go";
    panel.appendChild(button);
    const round = document.createElement("div");
    round.id = "round";
    round.className = "round";
    panel.appendChild(round);
    const deep = document.createElement("div");
    deep.id = "deep";
    deep.className = "round";
    round.appendChild(deep);
    const plain = document.createElement("div");
    plain.id = "plain";
    panel.appendChild(plain);
    const initial = document.createElement("div");
    initial.id = "initial";
    initial.className = "round";
    plain.appendChild(initial);
    const em = document.createElement("div");
    em.id = "em";
    em.className = "em";
    document.body.appendChild(em);
    const pad = document.createElement("div");
    pad.id = "pad";
    pad.className = "pad";
    em.appendChild(pad);
    const written = document.createElement("div");
    written.id = "written";
    written.className = "written";
    panel.appendChild(written);
    written.style.color = "inherit";
    globalThis.close();
`;

test("inherit lowers as written; the other CSS-wide keywords refuse outside backgrounds", () => {
    const result = compileSource(program);
    assert.match(
        result.cpp,
        /\.primary = "select", \.style = "font:inherit;color:inherit;"/,
    );
    for (const declaration of [
        "color: initial",
        "width: unset",
        "padding: revert",
        "margin: revert-layer",
    ])
        assert.throws(
            () =>
                compileSource(
                    `const sheet = document.createElement("style"); sheet.textContent = ".box { ${declaration}; }"; document.head.appendChild(sheet);`,
                ),
            /CSS-wide (?:initial|unset|revert|revert-layer) keyword is not represented/,
            declaration,
        );
    assert.doesNotThrow(() =>
        compileSource(
            `const sheet = document.createElement("style"); sheet.textContent = ".box { background-color: initial; background-clip: unset; }"; document.head.appendChild(sheet);`,
        ),
    );
});

test("inherit takes the parent's computed value natively", (t) => {
    runApplicationRmlUiFixture(t, "ui-inherit", program);
});

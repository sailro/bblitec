import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runApplicationRmlUiFixture } from "./rmlui-application-fixture.js";

// Form controls reading their container's font and colour over the user-agent
// control font, a property that does not inherit taken from the parent (its
// em length computed at the parent, the initial value where the parent
// declares none) and followed when the parent changes, and a CSSOM inherit;
// initial, unset and revert over lower declarations, revert reaching the
// user-agent sheet's declaration (its em computed at the element) from a
// rule and from CSSOM; keyframe keywords resolved as their animations start.
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
        .rounded { border-radius: 30px; color: #ff0000; }
        .rounded.initial { border-radius: initial; }
        .rounded.unset { border-radius: unset; color: unset; }
        .flat { margin: 0; color: #ff0000; padding-left: 4px; }
        .flat.reverted { margin: revert; color: revert; padding-left: revert-layer; }
        @keyframes take { from { border-radius: inherit; } to { border-radius: inherit; } }
        @keyframes clear { from { border-radius: initial; } to { border-radius: unset; } }
        @keyframes pad { from { padding: inherit; } to { padding: inherit; } }
        .taken { animation: take 1s infinite; }
        .cleared { border-radius: 30px; animation: clear 1s infinite; }
        .keyed { font-size: 10px; animation: pad 1s infinite; }
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
    const keyed = document.createElement("div");
    keyed.id = "keyed";
    keyed.className = "keyed";
    em.appendChild(keyed);
    const written = document.createElement("div");
    written.id = "written";
    written.className = "written";
    panel.appendChild(written);
    written.style.color = "inherit";
    for (const [id, className] of [
        ["keyword-initial", "rounded initial"],
        ["keyword-unset", "rounded unset"],
        ["taken", "taken"],
        ["cleared", "cleared"],
    ]) {
        const element = document.createElement("div");
        element.id = id;
        element.className = className;
        panel.appendChild(element);
    }
    const heading = document.createElement("h1");
    heading.id = "heading";
    heading.className = "flat reverted";
    heading.textContent = "Title";
    panel.appendChild(heading);
    const written_heading = document.createElement("h2");
    written_heading.id = "written-heading";
    written_heading.className = "flat";
    written_heading.textContent = "Subtitle";
    panel.appendChild(written_heading);
    written_heading.style.margin = "revert";
    globalThis.close();
`;

test("CSS-wide keywords lower as written; those reaching an initial value RmlUi does not carry refuse", () => {
    const result = compileSource(program);
    assert.match(
        result.cpp,
        /\.primary = "select", \.style = "font:inherit;color:inherit;"/,
    );
    const sheet = (rules: string) =>
        `const sheet = document.createElement("style"); sheet.textContent = ${JSON.stringify(rules)}; document.head.appendChild(sheet);`;
    assert.throws(
        () => compileSource(sheet(".box { display: inherit; }")),
        /'display' is not lowered: the value requires layout/,
    );
    assert.throws(
        () => compileSource(sheet(".box { --tone: unset; }")),
        /CSS-wide unset keyword is not represented on a custom property/,
    );
    for (const [rules, keyword] of [
        [".box { color: initial; }", "initial"],
        [".box { font: initial; }", "initial"],
        [".box { border-top-color: unset; }", "unset"],
        [".box { border-color: revert-layer; }", "revert"],
        ["@keyframes fade { to { line-height: initial; } }", "initial"],
    ] as const)
        assert.throws(
            () => compileSource(sheet(rules)),
            new RegExp(
                `CSS-wide ${keyword} keyword is not represented: RmlUi's initial value is not CSS's`,
            ),
            rules,
        );
    assert.doesNotThrow(() =>
        compileSource(
            sheet(
                ".box { width: unset; padding: revert; margin: revert-layer; padding-top: initial; flex-grow: unset; color: unset; font-size: revert; background-color: initial; background-clip: unset; } @keyframes grow { to { width: inherit; } }",
            ),
        ),
    );
});

test("keyframe declarations meet the rules' surface", () => {
    assert.throws(
        () =>
            compileSource(
                `const sheet = document.createElement("style"); sheet.textContent = "@keyframes spin { to { scale: 2 3; } }"; document.head.appendChild(sheet);`,
            ),
        /'scale' is not lowered/,
    );
});

test("the CSS-wide keywords resolve natively in the cascade and in keyframes", (t) => {
    runApplicationRmlUiFixture(t, "ui-inherit", program);
});

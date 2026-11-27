import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runApplicationRmlUiFixture } from "./rmlui-application-fixture.js";

const compile = (css: string) =>
    compileSource(
        `const sheet=document.createElement('style');sheet.textContent=${JSON.stringify(css)};document.head.appendChild(sheet);`,
    );

test("vertical-align admits keywords, lengths and percentages", () => {
    for (const value of [
        "middle",
        "-1px",
        "4px",
        ".5em",
        "-0.25rem",
        "2vh",
        "50%",
        "0",
    ])
        assert.match(
            compile(`i{vertical-align:${value}}`).cpp,
            /vertical-align/,
            value,
        );
    for (const value of ["1", "1in", "calc(1px + 1px)", "center", "1px 2px"])
        assert.throws(
            () => compile(`i{vertical-align:${value}}`),
            /Retained UI style property 'vertical-align' is not lowered/,
            value,
        );
});

const program = `
    const sheet = document.createElement("style");
    sheet.textContent =
        ".line { font-size: 16px; line-height: 20px; } .line i { display: inline-block; width: 10px; height: 10px; }" +
        " .down { vertical-align: -4px; } .up { vertical-align: 4px; } .half { vertical-align: 50%; } .em { vertical-align: -0.25em; }";
    document.head.appendChild(sheet);
    const line = document.createElement("div");
    line.className = "line";
    line.textContent = "x";
    document.body.appendChild(line);
    const box = (id: string, className: string): void => {
        const element = document.createElement("i");
        element.id = id;
        element.className = className;
        line.appendChild(element);
    };
    box("base", "");
    box("down", "down");
    box("up", "up");
    box("half", "half");
    box("em", "em");
    globalThis.close();
`;

test("native vertical-align lengths and percentages shift the box from the baseline", (t) => {
    runApplicationRmlUiFixture(t, "ui-vertical-align", program);
});

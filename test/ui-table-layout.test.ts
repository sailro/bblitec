import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { withBrowserPage } from "../src/browser-harness.js";
import { compileSource } from "../src/compiler.js";
import { doubleLiteral, stringLiteral } from "../src/cpp-literals.js";
import { htmlPageServer } from "./html-page-server.js";
import { runRmlUiFixture } from "./native-fixture.js";

/** A table part, an element with its style, attributes and children, or text. */
type TableNode =
    | {
          tag: string;
          style?: string;
          attrs?: Readonly<Record<string, string>>;
          children?: readonly TableNode[];
      }
    | { text: string };

interface TableCase {
    name: string;
    host: string;
    root: TableNode;
}

const box = (width: number, height = 10): TableNode => ({
    tag: "i",
    style: `display:inline-block;width:${width}px;height:${height}px;vertical-align:top`,
});
const space: TableNode = { text: " " };
const cell = (...children: TableNode[]): TableNode => ({
    tag: "td",
    children,
});
const styledCell = (style: string, ...children: TableNode[]): TableNode => ({
    tag: "td",
    style,
    children,
});
const row = (...children: TableNode[]): TableNode => ({ tag: "tr", children });
const body = (...children: TableNode[]): TableNode => ({
    tag: "tbody",
    children,
});
const table = (style: string, ...children: TableNode[]): TableNode => ({
    tag: "table",
    style,
    children,
});

// Text has no size here: the boxes carry every width, so both layouts measure
// the same content. A space between boxes is a line-break opportunity.
const host = "width:400px;font-size:0;line-height:0;";
const rows = [
    row(cell(box(40)), cell(box(80)), cell(box(20))),
    row(cell(box(10)), cell(box(30), box(30)), cell(box(5))),
];
const wrapping = row(
    cell(box(30), space, box(30)),
    cell(box(40), space, box(40)),
);
const cases: readonly TableCase[] = [
    { name: "auto-width", host, root: table("", body(...rows)) },
    {
        name: "width-above-max",
        host,
        root: table("width:400px", body(...rows)),
    },
    {
        name: "width-below-min",
        host,
        root: table("width:100px", body(...rows)),
    },
    { name: "width-between", host, root: table("width:120px", body(wrapping)) },
    { name: "width-squeezed", host, root: table("width:20px", body(wrapping)) },
    {
        name: "collapse",
        host,
        root: table("border-collapse:collapse", body(...rows)),
    },
    {
        name: "spacing",
        host,
        root: table("border-spacing:5px 3px", body(...rows)),
    },
    {
        name: "constrained-cell",
        host,
        root: table(
            "width:300px",
            body(
                row(
                    styledCell("width:100px", box(20)),
                    cell(box(40)),
                    cell(box(10)),
                ),
            ),
        ),
    },
    {
        name: "percent-cell",
        host,
        root: table(
            "width:300px",
            body(
                row(
                    styledCell("width:50%", box(20)),
                    cell(box(40)),
                    cell(box(10)),
                ),
            ),
        ),
    },
    {
        name: "colspan",
        host,
        root: table(
            "",
            body(
                row({
                    tag: "td",
                    attrs: { colspan: "2" },
                    children: [box(150)],
                }),
                row(cell(box(20)), cell(box(30))),
            ),
        ),
    },
    {
        name: "fixed-layout",
        host,
        root: table(
            "table-layout:fixed;width:300px",
            body(
                row(
                    styledCell("width:50px", box(20)),
                    cell(box(90)),
                    cell(box(10)),
                ),
            ),
        ),
    },
    {
        name: "header-middle",
        host,
        root: table(
            "",
            {
                tag: "thead",
                children: [
                    row(
                        { tag: "th", children: [box(10)] },
                        { tag: "th", children: [box(10)] },
                    ),
                ],
            },
            body(
                row(cell(box(60)), cell(box(10, 40))),
                row(cell(box(10)), cell(box(10))),
            ),
            { tag: "tfoot", children: [row(cell(box(10)), cell(box(10)))] },
        ),
    },
    {
        name: "shrink-to-fit-host",
        host: "display:inline-block;font-size:0;line-height:0;",
        root: table("", body(...rows)),
    },
    {
        name: "padding-border",
        host,
        root: table(
            "padding:4px;border:3px solid black",
            body(
                row(
                    styledCell("border:1px solid black;padding:2px", box(20)),
                    cell(box(30)),
                ),
            ),
        ),
    },
    {
        name: "direct-rows",
        host,
        root: table("", row(cell(box(20)), cell(box(10, 30)))),
    },
    {
        name: "row-height-minimum",
        host,
        root: table(
            "",
            body(
                { tag: "tr", style: "height:30px", children: [cell(box(20))] },
                { tag: "tr", style: "height:4px", children: [cell(box(20))] },
            ),
        ),
    },
];

/** The cases' element nodes in document order, each with its parent's index (-1: the case's host). */
function flatten(): {
    caseIndex: number;
    parent: number;
    node: TableNode;
}[] {
    const nodes: { caseIndex: number; parent: number; node: TableNode }[] = [];
    cases.forEach((tableCase, caseIndex) => {
        const visit = (node: TableNode, parent: number): void => {
            const index = nodes.length;
            nodes.push({ caseIndex, parent, node });
            if ("tag" in node)
                for (const child of node.children ?? []) visit(child, index);
        };
        visit(tableCase.root, -1);
    });
    return nodes;
}

test("table properties admit Chromium's table surface and refuse a caption", () => {
    const sheet = (css: string) =>
        compileSource(
            `const sheet=document.createElement('style');sheet.textContent=${JSON.stringify(css)};document.head.appendChild(sheet);`,
        );
    for (const css of [
        "table{border-collapse:collapse}",
        "table{border-spacing:4px}",
        "table{border-spacing:0 .5em}",
        "table{table-layout:fixed}",
    ])
        assert.match(sheet(css).cpp, /table/, css);
    for (const css of [
        "table{border-spacing:-1px}",
        "table{border-spacing:1px 2px 3px}",
        "table{border-collapse:inherit-ish}",
        "table{table-layout:stretch}",
    ])
        assert.throws(
            () => sheet(css),
            /Retained UI style property '(border-spacing|border-collapse|table-layout)' is not lowered/,
            css,
        );
    assert.throws(
        () =>
            compileSource(
                `document.body.appendChild(document.createElement("caption"));`,
            ),
        /A <caption> element is a table caption box/,
    );
});

test("native tables lay out as Chromium does, and refuse what they do not represent", async (t) => {
    const measured = await withBrowserPage(
        htmlPageServer(
            "<!doctype html><style>html,body{margin:0;padding:0}</style><body></body>",
        ),
        {
            serverName: "table layout",
            headless: true,
            viewport: { width: 640, height: 480 },
        },
        async (page, origin) => {
            await page.goto(origin);
            return page.evaluate(
                (tableCases) =>
                    tableCases.map((tableCase) => {
                        const caseHost = document.createElement("div");
                        caseHost.style.cssText = tableCase.host;
                        document.body.append(caseHost);
                        const elements: Element[] = [];
                        const build = (node: TableNode, parent: Element) => {
                            if (!("tag" in node)) {
                                parent.append(node.text);
                                return;
                            }
                            const element = document.createElement(node.tag);
                            if (node.style)
                                element.setAttribute("style", node.style);
                            for (const [name, value] of Object.entries(
                                node.attrs ?? {},
                            ))
                                element.setAttribute(name, value);
                            parent.append(element);
                            elements.push(element);
                            for (const child of node.children ?? [])
                                build(child, element);
                        };
                        build(tableCase.root, caseHost);
                        const origin = caseHost.getBoundingClientRect();
                        const rects = elements.map((element) => {
                            const rect = element.getBoundingClientRect();
                            return [
                                rect.left - origin.left,
                                rect.top - origin.top,
                                rect.width,
                                rect.height,
                            ];
                        });
                        caseHost.remove();
                        return rects;
                    }),
                cases,
            );
        },
    );
    const directory = resolve("artifacts/ui-table-layout");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "browser.json"),
        JSON.stringify(measured, null, 2) + "\n",
    );
    const nodes = flatten();
    const expected = measured.flat();
    assert.equal(
        expected.length,
        nodes.filter(({ node }) => "tag" in node).length,
    );
    const lines = nodes.map(({ caseIndex, parent, node }) =>
        "tag" in node
            ? `{${caseIndex}, ${parent}, ${stringLiteral(node.tag)}, ${stringLiteral(node.style ?? "")}, ${stringLiteral(node.attrs?.colspan ?? "")}, {}}`
            : `{${caseIndex}, ${parent}, {}, {}, {}, ${stringLiteral(node.text)}}`,
    );
    writeFileSync(
        join(directory, "cases.hpp"),
        `
#pragma once
#include <array>
#include <string_view>
struct TableLayoutNode {
    int case_index;
    int parent;
    std::string_view tag;
    std::string_view style;
    std::string_view colspan;
    std::string_view text;
};
inline const std::array<std::string_view, ${cases.length}> table_case_names{{${cases.map((tableCase) => stringLiteral(tableCase.name)).join(", ")}}};
inline const std::array<std::string_view, ${cases.length}> table_case_hosts{{${cases.map((tableCase) => stringLiteral(tableCase.host)).join(", ")}}};
inline const std::array<TableLayoutNode, ${nodes.length}> table_nodes{{
${lines.join(",\n")}
}};
inline const std::array<std::array<double, 4>, ${expected.length}> table_expected{{
${expected.map((rect) => `{${rect.map(doubleLiteral).join(", ")}}`).join(",\n")}
}};
`,
    );
    runRmlUiFixture(t, "ui-table-layout", {
        includeDirectories: [directory],
    });
});
